// CCConfig 桌面版主进程。
//
// 职责：
//   1. 探测系统 Node（不内置运行时）
//   2. 启动 Node sidecar（承载既有 preload services.js）
//   3. 建窗口并把 sidecar 端口/token 注入前端
//   4. 托盘常驻：关窗口只隐藏，网关继续服务
//   5. 退出时优雅停止 sidecar

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod i18n;
mod node_runtime;
mod sidecar;

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use node_runtime::NodeRuntime;
use sidecar::Sidecar;

const MAIN_WINDOW: &str = "main";
const GUIDE_WINDOW: &str = "guide";
/// 托盘图标 id（重建原生菜单时要按 id 取回）
const TRAY_ID: &str = "ccconfig-tray";

struct AppState {
    sidecar: Mutex<Option<Sidecar>>,
    node: Option<NodeRuntime>,
    sidecar_dir: PathBuf,
}

fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp"))
}

/// 数据目录：~/.ccconfig（与 .claude / .dsh / .codex 等 agent 配置同层，便于备份与排查）
fn data_dir() -> PathBuf {
    home_dir().join(".ccconfig")
}

fn log_dir() -> PathBuf {
    data_dir().join("logs")
}

/// 把改名/改位置之前的数据一次性搬到新目录（新位置已有 db.json 时跳过，不覆盖）
fn migrate_legacy_data() {
    let home = home_dir();
    let new_dir = data_dir();
    let legacy_dir = home.join("Library/Application Support/CCSwitch");

    if new_dir.join("db.json").is_file() {
        return;
    }
    if !legacy_dir.join("db.json").is_file() {
        return;
    }
    if let Err(e) = std::fs::create_dir_all(&new_dir) {
        eprintln!("[ccconfig] 创建数据目录失败: {e}");
        return;
    }
    for name in ["db.json", "runtime.json"] {
        let src = legacy_dir.join(name);
        if !src.is_file() {
            continue;
        }
        match std::fs::copy(&src, new_dir.join(name)) {
            Ok(_) => eprintln!("[ccconfig] 已迁移 {name} → {}", new_dir.display()),
            Err(e) => eprintln!("[ccconfig] 迁移 {name} 失败: {e}"),
        }
    }
    // 旧日志一并搬过来，保留排查线索
    let old_log = home.join("Library/Logs/CCSwitch/sidecar.log");
    if old_log.is_file() {
        let _ = std::fs::create_dir_all(log_dir());
        let _ = std::fs::copy(&old_log, log_dir().join("sidecar.log"));
    }
}

/// 生产：<App>/Contents/Resources/sidecar；开发：src-tauri/resources/sidecar
fn resolve_sidecar_dir(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(dir) = app.path().resource_dir() {
        let candidate = dir.join("sidecar");
        if candidate.join("server.js").is_file() {
            return candidate;
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/sidecar")
}

/// 读 macOS 系统外观（AppHandle 无 theme() 取值接口，窗口创建前只能问系统）
fn system_is_dark() -> bool {
    std::process::Command::new("defaults")
        .args(["read", "-g", "AppleInterfaceStyle"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().eq_ignore_ascii_case("Dark"))
        .unwrap_or(false)
}

/// 注入 sidecar 端口/token（bridge 每次调用时动态读取这两个全局，重启 sidecar 后用 eval 刷新）
fn port_script(port: u16, token: &str) -> String {
    format!(
        "window.__CCCONFIG_PORT__ = {}; window.__CCCONFIG_TOKEN__ = {};",
        port,
        serde_json::to_string(token).unwrap_or_else(|_| "\"\"".into())
    )
}

fn build_main_window(app: &tauri::AppHandle, port: u16, token: &str) -> tauri::Result<()> {
    let script = port_script(port, token);
    // 首帧外观跟随系统：显式设 theme，否则 WKWebView 停在 Aqua 外观（prefers-color-scheme 永远 light）。
    let dark = system_is_dark();
    let builder = WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::App("index.html".into()))
        .title("CCConfig")
        .inner_size(1240.0, 840.0)
        .min_inner_size(900.0, 600.0)
        .center()
        // 透明窗口：页面底色交给原生毛玻璃（vibrancy）与应用自己的深色底，
        // 不再用不透明 background_color —— 否则玻璃与 WebGL 背景特效都会被盖住。
        .transparent(true)
        // 顶栏透明化：标题栏与内容区同一像素空间，红绿灯浮在页面上（前端用 .is-desktop 留出顶部高度）。
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        // 不在显式设置 theme 前显示，避开 WKWebView 默认 Aqua 外观下的一帧白底。
        .visible(false)
        .theme(Some(if dark {
            tauri::Theme::Dark
        } else {
            tauri::Theme::Light
        }))
        .initialization_script(&script);

    let win = builder.build()?;
    apply_glass(
        &win,
        None,
        "主窗口",
        window_vibrancy::NSVisualEffectMaterial::UnderWindowBackground,
    );
    let _ = win.show();
    let _ = win.set_focus();
    Ok(())
}

/// 原生毛玻璃（NSVisualEffectView）：UnderWindowBackground = 系统窗口材质（跟随深浅色），
/// 即 uTools 8 亚克力观感的同源效果。state=Active 让窗口失焦时玻璃不灰化。
/// radius 传给玻璃视图做圆角（无边框弹窗需要）；失败不致命，仅告警。
fn apply_glass(
    win: &tauri::WebviewWindow,
    radius: Option<f64>,
    label: &str,
    material: window_vibrancy::NSVisualEffectMaterial,
) {
    #[cfg(target_os = "macos")]
    {
        use window_vibrancy::{apply_vibrancy, NSVisualEffectState};
        match apply_vibrancy(
            win,
            material,
            Some(NSVisualEffectState::Active),
            radius,
        ) {
            Ok(_) => eprintln!("[ccconfig] 已应用原生毛玻璃背景（{label}）"),
            Err(e) => eprintln!("[ccconfig] 应用毛玻璃失败（{label}，退化为透明窗口）: {e}"),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (win, radius, label, material);
    }
}

fn build_guide_window(app: &tauri::AppHandle) -> tauri::Result<()> {
    let dark = system_is_dark();
    let locale = current_locale(app);
    let locale_code = match locale {
        i18n::Locale::Zh => "zh-CN",
        i18n::Locale::En => "en-US",
    };
    let title = i18n::native(locale, &["guide", "title"]);
    WebviewWindowBuilder::new(app, GUIDE_WINDOW, WebviewUrl::App("guide.html".into()))
        .title(title)
        .inner_size(720.0, 560.0)
        .center()
        .theme(Some(if dark {
            tauri::Theme::Dark
        } else {
            tauri::Theme::Light
        }))
        .initialization_script(&format!(
            "window.__CC_LOCALE__ = {}; window.__CC_GUIDE__ = {};",
            serde_json::to_string(locale_code).unwrap_or_else(|_| "\"zh-CN\"".into()),
            i18n::native_value(locale, &["guide"])
        ))
        .build()?;
    Ok(())
}

/// 当前界面语言：优先读本机文档 ccswitch_locale_<nativeId>，再回退旧共享档 / 系统语言。
/// 走 /rpc 而不是直接读 db.json：sidecar 的落盘有 200ms 防抖，窗口长期开着时文件可能滞后。
fn current_locale(app: &tauri::AppHandle) -> i18n::Locale {
    let native_id = sidecar_rpc(app, "__utools.getNativeId")
        .and_then(|v| v.get("value").and_then(|x| x.as_str()).map(str::to_string))
        .filter(|id| !id.is_empty());
    let doc_id = match &native_id {
        Some(id) => format!("ccswitch_locale_{id}"),
        None => "ccswitch_locale".to_string(),
    };

    let doc = sidecar_rpc_args(app, "__utools.db.get", serde_json::json!([doc_id.clone()]));
    let preference = json_at(&doc, &["locale"]).and_then(|v| v.as_str());
    if let Some(locale) = i18n::from_preference(preference) {
        return locale;
    }

    // 本机尚无记录：回退旧共享档（只作迁移种子）
    if doc_id != "ccswitch_locale" {
        let legacy = sidecar_rpc_args(
            app,
            "__utools.db.get",
            serde_json::json!(["ccswitch_locale"]),
        );
        let legacy_preference = json_at(&legacy, &["locale"]).and_then(|v| v.as_str());
        if let Some(locale) = i18n::from_preference(legacy_preference) {
            return locale;
        }
    }

    i18n::system_locale()
}

// ==================== 网关状态（菜单栏展示用） ====================
// 只读几个数字，不值得为此引入 HTTP 库：本地 127.0.0.1 短连接 + 手写最小 HTTP/1.1 请求，
// 响应体用 serde_json 解析（services 的同步方法直接回 {ok:true,value:...}）。
fn sidecar_rpc(app: &tauri::AppHandle, method: &str) -> Option<serde_json::Value> {
    sidecar_rpc_args(app, method, serde_json::json!([]))
}

fn sidecar_rpc_args(
    app: &tauri::AppHandle,
    method: &str,
    args: serde_json::Value,
) -> Option<serde_json::Value> {
    let state = app.try_state::<AppState>()?;
    let (port, token) = {
        let guard = state.sidecar.lock().ok()?;
        let s = guard.as_ref()?;
        (s.port, s.token.clone())
    };
    let body = serde_json::json!({ "method": method, "args": args }).to_string();
    let req = format!(
        "POST /rpc HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nX-CCConfig-Token: {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(400)).ok()?;
    stream.set_read_timeout(Some(Duration::from_millis(800))).ok()?;
    stream.write_all(req.as_bytes()).ok()?;
    let mut resp = String::new();
    stream.read_to_string(&mut resp).ok()?;
    let payload = resp.split("\r\n\r\n").nth(1)?;
    serde_json::from_str(payload).ok()
}

/// 从 {ok:true,value:{...}} 里按路径取布尔/数值；取不到就按 false / 0 兜底
fn json_bool(v: &Option<serde_json::Value>, path: &[&str]) -> bool {
    json_at(v, path).and_then(|x| x.as_bool()).unwrap_or(false)
}

fn json_u64(v: &Option<serde_json::Value>, path: &[&str]) -> u64 {
    json_at(v, path).and_then(|x| x.as_u64()).unwrap_or(0)
}

fn json_at<'a>(v: &'a Option<serde_json::Value>, path: &[&str]) -> Option<&'a serde_json::Value> {
    let mut cur = v.as_ref()?.get("value")?;
    for key in path {
        cur = cur.get(*key)?;
    }
    Some(cur)
}

fn fmt_tokens(n: u64) -> String {
    if n >= 1_000_000 {
        format!("{:.1}M", n as f64 / 1_000_000.0)
    } else if n >= 1_000 {
        format!("{:.1}k", n as f64 / 1_000.0)
    } else {
        n.to_string()
    }
}

fn fmt_pct(part: u64, total: u64) -> String {
    if total == 0 {
        return "—".to_string();
    }
    let scaled = ((part as f64) * 1000.0 / (total as f64)).round() / 10.0;
    if scaled.fract().abs() < f64::EPSILON {
        format!("{}%", scaled as u64)
    } else {
        format!("{scaled:.1}%")
    }
}

/// 托盘菜单：几行只读统计（禁用项 = 纯展示）+ 三个动作项。
/// 每次鼠标移入图标时重建，所以打开时看到的就是此刻的数字。
fn build_tray_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    use tauri::menu::{IsMenuItem, PredefinedMenuItem};

    let status = sidecar_rpc(app, "getAutoRouteStatus");
    let config = sidecar_rpc(app, "readAutoRouteConfig");
    let enabled = json_bool(&config, &["enabled"]);
    let running = json_bool(&status, &["running"]);
    let port = json_u64(&status, &["port"]);

    let requests = json_u64(&status, &["stats", "requests"]);
    let successes = json_u64(&status, &["stats", "successes"]);
    let prompt = json_u64(&status, &["stats", "promptTokens"]);
    let cached = json_u64(&status, &["stats", "cachedTokens"]);
    let output = json_u64(&status, &["stats", "outputTokens"]);

    let locale = current_locale(app);
    let status_text = if !enabled {
        i18n::native(locale, &["tray", "gatewayDisabled"])
    } else if !running {
        i18n::native(locale, &["tray", "gatewayPortBusy"]).replace("{port}", &port.to_string())
    } else {
        i18n::native(locale, &["tray", "gatewayRunning"]).replace("{port}", &port.to_string())
    };

    let mut items: Vec<Box<dyn IsMenuItem<tauri::Wry>>> = Vec::new();
    // 信息行必须是 enabled=true：macOS 会把 disabled 菜单项自动画成灰色，暗色菜单下几乎看不清。
    // 这些 id 没有对应的 on_menu_event 分支，点击不会触发任何动作。
    items.push(Box::new(MenuItem::with_id(app, "stat-status", status_text, true, None::<&str>)?));

    if enabled && running {
        // 一行一项：标签与主窗口「网关」页的四项统计保持一致
        for (id, text) in [
            (
                "stat-requests",
                i18n::native(locale, &["tray", "requests"])
                    .replace("{count}", &requests.to_string()),
            ),
            (
                "stat-success",
                i18n::native(locale, &["tray", "successRate"])
                    .replace("{value}", &fmt_pct(successes, requests)),
            ),
            (
                "stat-tokens",
                i18n::native(locale, &["tray", "tokens"])
                    .replace("{value}", &fmt_tokens(prompt + output)),
            ),
            (
                "stat-cache",
                i18n::native(locale, &["tray", "cacheHitRate"])
                    .replace("{value}", &fmt_pct(cached, prompt)),
            ),
        ] {
            items.push(Box::new(MenuItem::with_id(app, id, text, true, None::<&str>)?));
        }
    }

    items.push(Box::new(PredefinedMenuItem::separator(app)?));
    items.push(Box::new(MenuItem::with_id(
        app,
        "show",
        i18n::native(locale, &["tray", "showWindow"]),
        true,
        None::<&str>,
    )?));
    items.push(Box::new(MenuItem::with_id(
        app,
        "restart-gateway",
        i18n::native(locale, &["tray", "restartGateway"]),
        enabled,
        None::<&str>,
    )?));
    items.push(Box::new(MenuItem::with_id(
        app,
        "quit",
        i18n::native(locale, &["tray", "quit"]),
        true,
        None::<&str>,
    )?));

    let refs: Vec<&dyn IsMenuItem<tauri::Wry>> = items.iter().map(|b| b.as_ref()).collect();
    Menu::with_items(app, &refs)
}

/// 「重启网关」：停掉网关服务再起来（不重启 sidecar 进程）；未开启时直接带用户去主窗口
fn restart_gateway(app: &tauri::AppHandle) {
    let config = sidecar_rpc(app, "readAutoRouteConfig");
    if !json_bool(&config, &["enabled"]) {
        show_main(app);
        return;
    }
    // stopAutoRoute 同步；startAutoRoute 返回 Promise（sidecar 走异步通道），这里不等结果，
    // 下次鼠标移入图标重建菜单时就能看到新状态
    let _ = sidecar_rpc(app, "stopAutoRoute");
    let _ = sidecar_rpc(app, "startAutoRoute");
}

fn refresh_tray_menu(tray: &TrayIcon) {
    match build_tray_menu(tray.app_handle()) {
        Ok(menu) => {
            let _ = tray.set_menu(Some(menu));
        }
        Err(e) => eprintln!("[ccconfig] 刷新托盘菜单失败: {e}"),
    }
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window(MAIN_WINDOW) {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
        return;
    }
    if let Some(win) = app.get_webview_window(GUIDE_WINDOW) {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// 重建 sidecar 并用 eval 更新页面里的端口/token（bridge 每次调用动态读取这两个全局）
fn restart_sidecar(app: &tauri::AppHandle) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let Some(node) = state.node.clone() else {
        eprintln!("[ccconfig] Node 未就绪，无法重启 sidecar");
        return;
    };
    let dir = state.sidecar_dir.clone();

    if let Ok(mut guard) = state.sidecar.lock() {
        if let Some(mut old) = guard.take() {
            old.stop();
        }
    }

    match Sidecar::start(&node.path, &dir, Some(&data_dir())) {
        Ok(started) => {
            let port = started.port;
            let token = started.token.clone();
            if let Ok(mut guard) = state.sidecar.lock() {
                *guard = Some(started);
            }
            if let Some(win) = app.get_webview_window(MAIN_WINDOW) {
                let _ = win.eval(&port_script(port, &token));
            }
            eprintln!("[ccconfig] sidecar 已重启，端口 {port}");
        }
        Err(e) => eprintln!("[ccconfig] 重启 sidecar 失败: {e}"),
    }
}

fn setup_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let menu = build_tray_menu(app)?;
    // 菜单栏沿用原来的彩色主体图（透明底、不做模板染色）；
    // 应用图标是白底圆角方块，不能拿来当菜单栏图标
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .menu(&menu)
        // 左右键都弹同一个原生菜单（macOS 状态栏标准行为），内容由 refresh_tray_menu 现拉现拼
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main(app),
            "restart-gateway" => restart_gateway(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // 只在「指针移入图标」时重建菜单：此时菜单还没展示，替换是安全的。
            // 绝不能在 Click 里重建 —— 点击时 AppKit 已经把菜单弹出来了，
            // set_menu 会把正在展示的菜单立刻关掉（表现为「一点就消失」）。
            if let TrayIconEvent::Enter { .. } = event {
                refresh_tray_menu(tray);
            }
        })
        .build(app)?;

    eprintln!("[ccconfig] 托盘交互已配置：原生菜单（网关状态 + 请求统计 + 打开主窗口/重启网关/退出）");

    Ok(())
}

/// 后台健康监控 + 系统外观跟随：连续 3 次探活失败就尝试重启一次 sidecar
fn spawn_watchdog(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let mut failures = 0u32;
        let mut last_dark = system_is_dark();
        loop {
            std::thread::sleep(Duration::from_secs(5));

            // 系统外观变更后同步窗口 theme，WKWebView 的 prefers-color-scheme 才会重算
            let dark = system_is_dark();
            if dark != last_dark {
                last_dark = dark;
                let t = if dark {
                    tauri::Theme::Dark
                } else {
                    tauri::Theme::Light
                };
                if let Some(win) = app.get_webview_window(MAIN_WINDOW) {
                    let _ = win.set_theme(Some(t));
                }
            }

            let Some(state) = app.try_state::<AppState>() else {
                continue;
            };
            let port = state
                .sidecar
                .lock()
                .ok()
                .and_then(|g| g.as_ref().map(|s| s.port));

            match port {
                Some(port) if sidecar::health_ok(port) => failures = 0,
                Some(_) => {
                    failures += 1;
                    eprintln!("[ccconfig] sidecar 健康检查失败 {failures}/3");
                    if failures >= 3 {
                        failures = 0;
                        eprintln!("[ccconfig] 触发自动重启 sidecar");
                        restart_sidecar(&app);
                    }
                }
                None => failures = 0,
            }
        }
    });
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle().clone();
            migrate_legacy_data();

            let sidecar_dir = resolve_sidecar_dir(&handle);
            let (node, tried) = node_runtime::detect();

            match node.clone() {
                Some(rt) => {
                    eprintln!("[ccconfig] 使用 Node {} ({})", rt.version, rt.path.display());
                }
                None => {
                    eprintln!("[ccconfig] 未找到可用 Node（>=18），尝试过的位置：");
                    for t in &tried {
                        eprintln!("  - {t}");
                    }
                }
            }

            app.manage(AppState {
                sidecar: Mutex::new(None),
                node: node.clone(),
                sidecar_dir: sidecar_dir.clone(),
            });

            // 托盘先建，保证即使 sidecar 起不来用户也有入口
            if let Err(e) = setup_tray(&handle) {
                eprintln!("[ccconfig] 托盘创建失败: {e}");
            }

            let Some(rt) = node else {
                build_guide_window(&handle)?;
                return Ok(());
            };

            match Sidecar::start(&rt.path, &sidecar_dir, Some(&data_dir())) {
                Ok(started) => {
                    let port = started.port;
                    let token = started.token.clone();
                    eprintln!(
                        "[ccconfig] sidecar 就绪，端口 {port}，日志 {}",
                        started.log_path.display()
                    );
                    if let Ok(mut guard) = app.state::<AppState>().sidecar.lock() {
                        *guard = Some(started);
                    }
                    build_main_window(&handle, port, &token)?;
                    // 托盘在 sidecar 之前就建好了（保证起不来也有入口），这里补一次刷新，
                    // 避免首次展开菜单时看到「未开启」的初始文案
                    if let Some(tray) = handle.tray_by_id(TRAY_ID) {
                        refresh_tray_menu(&tray);
                    }
                    spawn_watchdog(handle.clone());
                }
                Err(e) => {
                    eprintln!("[ccconfig] sidecar 启动失败: {e}");
                    build_guide_window(&handle)?;
                }
            }

            Ok(())
        })
        // 关窗口只隐藏：网关需要常驻
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("CCConfig 启动失败")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(state) = app.try_state::<AppState>() {
                    if let Ok(mut guard) = state.sidecar.lock() {
                        if let Some(mut s) = guard.take() {
                            s.stop();
                        }
                    }
                }
            }
        });
}
