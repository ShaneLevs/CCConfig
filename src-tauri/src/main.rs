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
use std::time::{Duration, Instant};

use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{
    LogicalSize, Manager, PhysicalPosition, Position, RunEvent, Size, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

use node_runtime::NodeRuntime;
use sidecar::Sidecar;

const MAIN_WINDOW: &str = "main";
const GUIDE_WINDOW: &str = "guide";
/// 托盘图标 id
const TRAY_ID: &str = "ccconfig-tray";
/// 托盘弹窗（WebView 面板，不是原生 NSMenu）
const TRAY_POPUP: &str = "tray-popup";
/// 弹窗宽度（逻辑像素）
const POPUP_WIDTH: f64 = 360.0;
const POPUP_MIN_HEIGHT: f64 = 120.0;
const POPUP_MAX_HEIGHT: f64 = 560.0;
/// 弹窗与托盘图标之间的间距
const POPUP_GAP: f64 = 8.0;
/// 托盘点击与「失焦收起」的最小间隔：macOS 点托盘时弹窗会先失焦，
/// 紧接着的 Click 若被当成「打开」就会关不掉，用这个窗口期把同一次点击识别为「收起」。
const POPUP_TOGGLE_GRACE_MS: u64 = 350;

// ==================== 改名（ccswitch → ccconfig）遗留常量 ====================
// 这些字面量已经在用户磁盘上存在，**不能跟着改名**，否则老数据读不到/不迁移。
// 仅用于迁移与只读回退，新写入一律用 ccconfig 命名（JS 侧同类清单见 public/preload/services/legacy.js）。

/// 改名前的「应用数据」目录名（数据从这里迁到 ~/.ccconfig）
const LEGACY_APP_SUPPORT_DIR: &str = "Library/Application Support/CCSwitch";
/// 改名前的日志目录名
const LEGACY_LOG_DIR: &str = "Library/Logs/CCSwitch";
/// 改名前的语言文档（本机档前缀 + 旧共享档），仅在迁移尚未跑完时作只读回退
const LEGACY_LOCALE_DOC_PREFIX: &str = "ccswitch_locale";
const LEGACY_LOCALE_DOC: &str = "ccswitch_locale";

struct AppState {
    sidecar: Mutex<Option<Sidecar>>,
    node: Option<NodeRuntime>,
    sidecar_dir: PathBuf,
}

/// 托盘图标在屏幕上的物理坐标（TrayIconEvent 给的 rect 可能是逻辑单位，统一换算后存这里）
#[derive(Clone, Copy, Debug)]
struct TrayAnchor {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Default)]
struct TrayPopupState {
    /// 最近一次点击的托盘图标位置；弹窗每次展开都按它重新定位
    anchor: Mutex<Option<TrayAnchor>>,
    /// 页面量出来的内容高度（逻辑像素）；resize 命令写入，展开时按它设窗口尺寸
    height: Mutex<f64>,
    /// 上一次「因失焦而收起」的时间，用于区分「点托盘收起」与「点托盘打开」
    hidden_by_blur: Mutex<Option<Instant>>,
}

/// 背景外观（外观切换 / 托盘点击时都要用）
fn theme_of(dark: bool) -> tauri::Theme {
    if dark {
        tauri::Theme::Dark
    } else {
        tauri::Theme::Light
    }
}

/// 用户主目录。Windows 默认没有 HOME，只有 USERPROFILE / HOMEDRIVE+HOMEPATH。
pub(crate) fn home_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        if let Some(p) = std::env::var_os("USERPROFILE").filter(|s| !s.is_empty()) {
            return PathBuf::from(p);
        }
        if let (Some(drive), Some(path)) = (
            std::env::var_os("HOMEDRIVE").filter(|s| !s.is_empty()),
            std::env::var_os("HOMEPATH").filter(|s| !s.is_empty()),
        ) {
            let mut home = PathBuf::from(drive);
            home.push(path);
            return home;
        }
    }
    std::env::var_os("HOME")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            if cfg!(target_os = "windows") {
                PathBuf::from("C:\\")
            } else {
                PathBuf::from("/tmp")
            }
        })
}

/// 数据目录：~/.ccconfig（与 .claude / .dsh / .codex 等 agent 配置同层，便于备份与排查）
pub(crate) fn data_dir() -> PathBuf {
    home_dir().join(".ccconfig")
}

fn log_dir() -> PathBuf {
    data_dir().join("logs")
}

/// 把改名/改位置之前的数据一次性搬到新目录（新位置已有数据时跳过，不覆盖）。
///
/// DB 已改为 `~/.ccconfig/db/` 下每文档一个 JSON 文件，旧的 `db.json` 不再读取也不再搬运；
/// 这里只迁移 Node 路径缓存与日志。
fn migrate_legacy_data() {
    let home = home_dir();
    let new_dir = data_dir();
    let legacy_dir = home.join(LEGACY_APP_SUPPORT_DIR);

    // 新位置已有数据（新格式的 db/ 目录或 runtime.json）就跳过
    if new_dir.join("db").is_dir() || new_dir.join("runtime.json").is_file() {
        return;
    }

    let runtime_src = legacy_dir.join("runtime.json");
    if runtime_src.is_file() {
        if let Err(e) = std::fs::create_dir_all(&new_dir) {
            eprintln!("[ccconfig] 创建数据目录失败: {e}");
            return;
        }
        match std::fs::copy(&runtime_src, new_dir.join("runtime.json")) {
            Ok(_) => eprintln!("[ccconfig] 已迁移 runtime.json → {}", new_dir.display()),
            Err(e) => eprintln!("[ccconfig] 迁移 runtime.json 失败: {e}"),
        }
    }
    // 旧日志一并搬过来，保留排查线索
    let old_log = home.join(LEGACY_LOG_DIR).join("sidecar.log");
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

/// 读系统外观（AppHandle 无 theme() 取值接口，窗口创建前只能问系统）。
/// macOS 走 defaults；Windows 读注册表 AppsUseLightTheme（0 = 深色）。
#[cfg(target_os = "macos")]
fn system_is_dark() -> bool {
    std::process::Command::new("defaults")
        .args(["read", "-g", "AppleInterfaceStyle"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().eq_ignore_ascii_case("Dark"))
        .unwrap_or(false)
}

#[cfg(target_os = "windows")]
fn system_is_dark() -> bool {
    let mut cmd = std::process::Command::new("reg");
    cmd.args([
        "query",
        r"HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize",
        "/v",
        "AppsUseLightTheme",
    ]);
    node_runtime::hide_console(&mut cmd);
    cmd.output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_lowercase().contains("0x0"))
        .unwrap_or(false)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn system_is_dark() -> bool {
    false
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
        // 默认尺寸 = 左侧 agent 切换栏刚好出现的宽度：前端 src/Switch/index.vue 的
        // updateAgentRail 要求 (innerWidth - 800) / 2 >= 100，即 1000（800 内容 + 两侧各 100）；
        // 再宽就只是两侧留白变大，故 1000 是能“看见侧栏”的最小窗口。高度取宽度的 80%。
        .inner_size(1000.0, 800.0)
        .min_inner_size(900.0, 600.0)
        .center()
        // 透明窗口：页面底色交给原生毛玻璃（vibrancy）与应用自己的深色底，
        // 不再用不透明 background_color —— 否则玻璃与 WebGL 背景特效都会被盖住。
        .transparent(true);

    // overlay 透明标题栏是 macOS 专属：Windows 保留系统标题栏（红绿灯/拖区/圆角交给 DWM），
    // 这两个 builder 方法在 tauri 里只在 macOS 上存在，写死会直接编不过 Windows。
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);

    // 不在显式设置 theme 前显示，避开 WebView 默认外观下的一帧白底。
    let builder = builder
        .visible(false)
        .theme(Some(theme_of(dark)))
        .initialization_script(&script);

    let win = builder.build()?;
    apply_main_background(&win, dark);
    let _ = win.show();
    let _ = win.set_focus();
    Ok(())
}

/// 主窗口背景：macOS 用 NSVisualEffectView；Windows 用 Mica/亚克力（失败退模糊）。
/// 页面根节点保持透明，背景材质全部由原生视图提供（见 desktop/bridge/window-shim.js 的说明）。
fn apply_main_background(win: &tauri::WebviewWindow, dark: bool) {
    #[cfg(target_os = "macos")]
    {
        let _ = dark;
        apply_glass(
            win,
            None,
            "主窗口",
            window_vibrancy::NSVisualEffectMaterial::UnderWindowBackground,
        );
    }
    #[cfg(target_os = "windows")]
    {
        apply_windows_background(win, dark, "主窗口");
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (win, dark);
    }
}

/// 原生毛玻璃（NSVisualEffectView）：UnderWindowBackground = 系统窗口材质（跟随深浅色），
/// 即 uTools 8 亚克力观感的同源效果。state=Active 让窗口失焦时玻璃不灰化。
/// radius 传给玻璃视图做圆角（无边框弹窗需要）；失败不致命，仅告警。
#[cfg(target_os = "macos")]
fn apply_glass(
    win: &tauri::WebviewWindow,
    radius: Option<f64>,
    label: &str,
    material: window_vibrancy::NSVisualEffectMaterial,
) {
    use window_vibrancy::{apply_vibrancy, NSVisualEffectState};
    match apply_vibrancy(win, material, Some(NSVisualEffectState::Active), radius) {
        Ok(_) => eprintln!("[ccconfig] 已应用原生毛玻璃背景（{label}）"),
        Err(e) => eprintln!("[ccconfig] 应用毛玻璃失败（{label}，退化为透明窗口）: {e}"),
    }
}

/// Windows 主窗口背景：Win11 优先 Mica（系统窗口材质、性能好），
/// 失败（Win10/更早）退亚克力，再失败退旧版模糊。
#[cfg(target_os = "windows")]
fn apply_windows_background(win: &WebviewWindow, dark: bool, label: &str) {
    match window_vibrancy::apply_mica(win, Some(dark)) {
        Ok(_) => {
            eprintln!("[ccconfig] 已应用 Mica 背景（{label}）");
            return;
        }
        Err(e) => eprintln!("[ccconfig] Mica 不可用（{label}）: {e}"),
    }
    apply_windows_acrylic(win, dark, label);
}

/// Windows 亚克力（Win10 1809+）；失败再退旧版模糊（Win7）。
#[cfg(target_os = "windows")]
fn apply_windows_acrylic(win: &WebviewWindow, dark: bool, label: &str) {
    let tint = if dark {
        (24u8, 24u8, 28u8, 150u8)
    } else {
        (250u8, 250u8, 252u8, 130u8)
    };
    match window_vibrancy::apply_acrylic(win, Some(tint)) {
        Ok(_) => eprintln!("[ccconfig] 已应用亚克力背景（{label}）"),
        Err(e) => {
            eprintln!("[ccconfig] 亚克力失败（{label}），退化为模糊: {e}");
            let _ = window_vibrancy::apply_blur(win, Some(tint));
        }
    }
}

/// 托盘弹窗的背景：macOS 用 NSVisualEffectView（Popover 材质，和系统弹出面板同源），
/// Windows 用亚克力（弹窗不适合 Mica；失败退化为旧版模糊）。页面自己只负责内容与淡色叠层。
fn apply_popup_background(win: &WebviewWindow, dark: bool) {
    #[cfg(target_os = "macos")]
    {
        apply_glass(
            win,
            Some(14.0),
            "托盘弹窗",
            window_vibrancy::NSVisualEffectMaterial::Popover,
        );
        let _ = dark;
    }
    #[cfg(target_os = "windows")]
    {
        apply_windows_acrylic(win, dark, "托盘弹窗");
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (win, dark);
    }
}

/// 找包含指定物理坐标的显示器。
/// 不用 `monitor_from_point`：macOS 上 tao 把 CGDisplayBounds（点）直接当输入，
/// 而托盘事件给的是「点 × scale」的物理坐标，Retina 屏右边/底部的图标会查不到显示器。
fn monitor_at(app: &tauri::AppHandle, x: f64, y: f64) -> Option<tauri::Monitor> {
    let monitors = app.available_monitors().ok()?;
    let mut fallback = None;
    for monitor in monitors {
        let pos = monitor.position();
        let size = monitor.size();
        let left = pos.x as f64;
        let top = pos.y as f64;
        if x >= left
            && x < left + size.width as f64
            && y >= top
            && y < top + size.height as f64
        {
            return Some(monitor);
        }
        fallback.get_or_insert(monitor);
    }
    fallback
}

/// 托盘点击时 rect 可能给的是逻辑单位：按点击位置所在显示器换算成物理像素
fn anchor_from_rect(app: &tauri::AppHandle, position: PhysicalPosition<f64>, rect: tauri::Rect) -> TrayAnchor {
    let scale = monitor_at(app, position.x, position.y)
        .map(|m| m.scale_factor())
        .unwrap_or(1.0);
    let pos = rect.position.to_physical::<f64>(scale);
    let size = rect.size.to_physical::<f64>(scale);
    TrayAnchor {
        x: pos.x,
        y: pos.y,
        width: size.width,
        height: size.height,
    }
}

/// 弹窗创建（常驻隐藏）：首次展开零等待，页面在后台先把数据与尺寸量好。
/// 注入 sidecar 端口/token + 当前语言的 native.json「tray」文案；语言切换后每次展开会重新注入。
fn build_tray_popup(app: &tauri::AppHandle, port: u16, token: &str) -> tauri::Result<WebviewWindow> {
    let dark = system_is_dark();
    let locale = current_locale(app);
    let locale_code = match locale {
        i18n::Locale::Zh => "zh-CN",
        i18n::Locale::En => "en-US",
    };
    let script = format!(
        "{} window.__CC_LOCALE__ = {}; window.__CC_TRAY_I18N__ = {};",
        port_script(port, token),
        serde_json::to_string(locale_code).unwrap_or_else(|_| "\"zh-CN\"".into()),
        i18n::native_value(locale, &["tray"])
    );

    let win = WebviewWindowBuilder::new(app, TRAY_POPUP, WebviewUrl::App("tray.html".into()))
        .title("CCConfig")
        .inner_size(POPUP_WIDTH, 420.0)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .decorations(false)
        // 与主窗口同一套透明语义：玻璃来自原生视图，页面根节点保持透明
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(true)
        .visible(false)
        .theme(Some(theme_of(dark)))
        .initialization_script(&script)
        .build()?;

    apply_popup_background(&win, dark);

    // 失焦即收起（和系统菜单一致）。点托盘图标时窗口也会先失焦，
    // 这里记下时间，交给 toggle 判断「这次点击是收起还是打开」。
    let handle = app.clone();
    let win_for_event = win.clone();
    win.on_window_event(move |event| {
        if let WindowEvent::Focused(false) = event {
            if win_for_event.is_visible().unwrap_or(false) {
                let _ = win_for_event.hide();
                if let Some(state) = handle.try_state::<TrayPopupState>() {
                    if let Ok(mut t) = state.hidden_by_blur.lock() {
                        *t = Some(Instant::now());
                    }
                }
            }
        }
    });

    Ok(win)
}

fn stored_popup_height(app: &tauri::AppHandle) -> f64 {
    app.try_state::<TrayPopupState>()
        .and_then(|state| state.height.lock().ok().map(|h| *h))
        .filter(|h| *h > 0.0)
        .unwrap_or(420.0)
        .clamp(POPUP_MIN_HEIGHT, POPUP_MAX_HEIGHT)
}

/// 按托盘图标位置摆弹窗：默认右对齐图标、向下展开；图标在下半屏（Windows 任务栏、
/// 底部状态栏）时改为向上展开，并保证整个弹窗落在这块屏幕的工作区内。
fn reposition_popup(app: &tauri::AppHandle) {
    let Some(win) = app.get_webview_window(TRAY_POPUP) else {
        return;
    };
    let Some(state) = app.try_state::<TrayPopupState>() else {
        return;
    };
    let Some(anchor) = state.anchor.lock().ok().and_then(|a| *a) else {
        return;
    };

    let height = stored_popup_height(app);
    let monitor = monitor_at(app, anchor.x, anchor.y);
    let scale = monitor.as_ref().map(|m| m.scale_factor()).unwrap_or(1.0);
    let (work_x, work_y, work_w, work_h) = monitor
        .as_ref()
        .map(|m| {
            let area = m.work_area();
            (
                area.position.x as f64,
                area.position.y as f64,
                area.size.width as f64,
                area.size.height as f64,
            )
        })
        .unwrap_or((0.0, 0.0, 1920.0, 1080.0));

    let width_px = (POPUP_WIDTH * scale).round().max(1.0);
    let height_px = (height * scale).round().max(1.0);
    let gap = POPUP_GAP * scale;
    let margin = 8.0 * scale;

    let icon_mid = anchor.y + anchor.height / 2.0;
    let open_down = icon_mid < work_y + work_h / 2.0;
    let y = if open_down {
        anchor.y + anchor.height + gap
    } else {
        anchor.y - height_px - gap
    };
    let x = anchor.x + anchor.width - width_px;
    let x = x.min(work_x + work_w - width_px - margin).max(work_x + margin);
    let y = y.min(work_y + work_h - height_px - margin).max(work_y + margin);

    // 先移动再设尺寸：跨显示器（不同 scale）时，窗口要先落到目标屏，
    // 逻辑尺寸才会按目标屏的 scale 换算，右对齐才不会偏。
    let _ = win.set_position(Position::Physical(PhysicalPosition::new(
        x.round() as i32,
        y.round() as i32,
    )));
    let _ = win.set_size(Size::Logical(LogicalSize::new(POPUP_WIDTH, height)));
}

/// 每次展开都重新注入语言（主窗口里可能刚改过），再让页面重载数据。
fn show_tray_popup(app: &tauri::AppHandle, anchor: TrayAnchor) {
    let Some(win) = app.get_webview_window(TRAY_POPUP) else {
        show_main(app);
        return;
    };

    let Some(state) = app.try_state::<TrayPopupState>() else {
        return;
    };
    if let Ok(mut a) = state.anchor.lock() {
        *a = Some(anchor);
    }
    if let Ok(mut t) = state.hidden_by_blur.lock() {
        *t = None;
    }

    let locale = current_locale(app);
    let locale_code = match locale {
        i18n::Locale::Zh => "zh-CN",
        i18n::Locale::En => "en-US",
    };
    let script = format!(
        "window.__CC_LOCALE__ = {}; window.__CC_TRAY_I18N__ = {}; window.__ccTrayReload && window.__ccTrayReload();",
        serde_json::to_string(locale_code).unwrap_or_else(|_| "\"zh-CN\"".into()),
        i18n::native_value(locale, &["tray"])
    );
    let _ = win.eval(&script);

    // Windows 的亚克力色调跟外观走，展开前按当前系统外观刷新一次
    #[cfg(target_os = "windows")]
    apply_popup_background(&win, system_is_dark());

    reposition_popup(app);
    let _ = win.show();
    let _ = win.set_focus();
}

fn hide_popup_window(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window(TRAY_POPUP) {
        let _ = win.hide();
    }
}

/// 左键切换弹窗。点托盘时窗口可能已经因失焦隐藏，用 hidden_by_blur 的时间窗
/// 判断这次点击是不是「关掉它」的那一下。
fn toggle_tray_popup(app: &tauri::AppHandle, position: PhysicalPosition<f64>, rect: tauri::Rect) {
    let Some(win) = app.get_webview_window(TRAY_POPUP) else {
        show_main(app);
        return;
    };
    if win.is_visible().unwrap_or(false) {
        let _ = win.hide();
        return;
    }
    if let Some(state) = app.try_state::<TrayPopupState>() {
        if let Ok(t) = state.hidden_by_blur.lock() {
            if let Some(ts) = *t {
                if ts.elapsed() < Duration::from_millis(POPUP_TOGGLE_GRACE_MS) {
                    return;
                }
            }
        }
    }
    show_tray_popup(app, anchor_from_rect(app, position, rect));
}

// ==================== 弹窗 → Rust 的命令 ====================

/// 弹窗动作：底部「打开 CCConfig / 退出」，顶部「重启网关」。
/// 重启会阻塞几百毫秒（sidecar RPC），放后台线程避免卡住页面；弹窗保持打开，
/// 页面轮询 getAutoRouteStatus 把状态从「重启中」刷回「运行中」。
#[tauri::command]
fn tray_popup_action(app: tauri::AppHandle, action: String) {
    match action.as_str() {
        "show-main" => {
            hide_popup_window(&app);
            show_main(&app);
        }
        "restart-gateway" => {
            let handle = app.clone();
            std::thread::spawn(move || restart_gateway(&handle));
        }
        "hide" => hide_popup_window(&app),
        "quit" => app.exit(0),
        _ => {}
    }
}

/// 页面渲染完内容后上报自身高度（逻辑像素），窗口随之变高/变矮。
/// 固定高度会在没有订阅时留一大块空白，原生菜单不会这样。
#[tauri::command]
fn tray_popup_resize(app: tauri::AppHandle, height: f64) {
    let h = height.clamp(POPUP_MIN_HEIGHT, POPUP_MAX_HEIGHT);
    if let Some(state) = app.try_state::<TrayPopupState>() {
        if let Ok(mut stored) = state.height.lock() {
            if (*stored - h).abs() < 0.5 {
                return;
            }
            *stored = h;
        }
    }
    let Some(win) = app.get_webview_window(TRAY_POPUP) else {
        return;
    };
    let _ = win.set_size(Size::Logical(LogicalSize::new(POPUP_WIDTH, h)));
    if win.is_visible().unwrap_or(false) {
        reposition_popup(&app);
    }
}

#[tauri::command]
fn tray_popup_hide(app: tauri::AppHandle) {
    hide_popup_window(&app);
}

/// 引导页展示的失败原因：`kind` 决定标题（node = 没找到 Node，sidecar = 起不来），
/// `reason` / `tried` 让用户不必翻日志就能看到实际原因。
fn build_guide_window(
    app: &tauri::AppHandle,
    fail: serde_json::Value,
) -> tauri::Result<()> {
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
            "window.__CC_LOCALE__ = {}; window.__CC_GUIDE__ = {}; window.__CC_FAIL__ = {};",
            serde_json::to_string(locale_code).unwrap_or_else(|_| "\"zh-CN\"".into()),
            i18n::native_value(locale, &["guide"]),
            fail
        ))
        .build()?;
    Ok(())
}

/// 启动失败时把原因追加到 sidecar.log（Finder 启动时 eprintln 用户看不到），
/// 引导页也指到这个文件，出问题时至少能对着看。
fn log_startup_failure(line: &str) {
    eprintln!("[ccconfig] {line}");
    let dir = log_dir();
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("sidecar.log"))
    {
        use std::io::Write;
        let _ = writeln!(f, "[app] {line}");
    }
}

/// 当前界面语言：优先读本机文档 ccconfig_locale_<nativeId>，再回退旧共享档 / 系统语言。
/// 走 /rpc 而不是直接读 db/ 下的文档文件：sidecar 的落盘有 200ms 防抖，窗口长期开着时文件可能滞后。
fn current_locale(app: &tauri::AppHandle) -> i18n::Locale {
    let native_id = sidecar_rpc(app, "__utools.getNativeId")
        .and_then(|v| v.get("value").and_then(|x| x.as_str()).map(str::to_string))
        .filter(|id| !id.is_empty());
    let doc_id = match &native_id {
        Some(id) => format!("ccconfig_locale_{id}"),
        None => "ccconfig_locale".to_string(),
    };

    if let Some(locale) = read_locale_doc(app, &doc_id) {
        return locale;
    }

    // 本机尚无记录：回退改名前的本机档，再回退旧共享档（只作迁移种子）
    if let Some(id) = &native_id {
        if let Some(locale) = read_locale_doc(app, &format!("{LEGACY_LOCALE_DOC_PREFIX}_{id}")) {
            return locale;
        }
    }
    if doc_id != "ccconfig_locale" {
        if let Some(locale) = read_locale_doc(app, "ccconfig_locale") {
            return locale;
        }
    }
    if let Some(locale) = read_locale_doc(app, LEGACY_LOCALE_DOC) {
        return locale;
    }

    i18n::system_locale()
}

/// 读一条语言文档；没有记录 / 值未知（'system'）时返回 None
fn read_locale_doc(app: &tauri::AppHandle, doc_id: &str) -> Option<i18n::Locale> {
    let doc = sidecar_rpc_args(app, "__utools.db.get", serde_json::json!([doc_id]));
    let preference = json_at(&doc, &["locale"]).and_then(|v| v.as_str());
    i18n::from_preference(preference)
}

// ==================== sidecar 同步 RPC（语言档 / 重启网关） ====================
// 只读几个值，不值得为此引入 HTTP 库：本地 127.0.0.1 短连接 + 手写最小 HTTP/1.1 请求，
// 响应体用 serde_json 解析（services 的同步方法直接回 {ok:true,value:...}）。
// 托盘弹窗的数据不走这里 —— 页面自己用 fetch 调 /rpc，异步方法走 /rpc-poll。
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

fn json_at<'a>(v: &'a Option<serde_json::Value>, path: &[&str]) -> Option<&'a serde_json::Value> {
    let mut cur = v.as_ref()?.get("value")?;
    for key in path {
        cur = cur.get(*key)?;
    }
    Some(cur)
}

/// 「重启网关」：停掉网关服务再起来（不重启 sidecar 进程）；未开启时直接带用户去主窗口
fn restart_gateway(app: &tauri::AppHandle) {
    let config = sidecar_rpc(app, "readAutoRouteConfig");
    if !json_bool(&config, &["enabled"]) {
        // 网关没开时重启没有意义：收起弹窗并带用户去主窗口开启
        hide_popup_window(app);
        show_main(app);
        return;
    }
    // stopAutoRoute 同步；startAutoRoute 返回 Promise（sidecar 走异步通道），这里不等结果
    let _ = sidecar_rpc(app, "stopAutoRoute");
    let _ = sidecar_rpc(app, "startAutoRoute");
}

/// 托盘图标事件分发：左键切换自定义弹窗，右键直接开主窗口。
fn handle_tray_event(tray: &TrayIcon, event: TrayIconEvent) {
    match event {
        TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            position,
            rect,
            ..
        } => toggle_tray_popup(tray.app_handle(), position, rect),
        // 右键：直接打开主窗口（不进弹窗）
        TrayIconEvent::Click {
            button: MouseButton::Right,
            button_state: MouseButtonState::Up,
            ..
        } => {
            hide_popup_window(tray.app_handle());
            show_main(tray.app_handle());
        }
        _ => {}
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
/// 启动 sidecar，失败重试一次。
/// 启动阶段偶发的一次失败（旧实例还在收尾、端口/健康检查抢跑）不该直接弹引导页。
fn start_sidecar_with_retry(node: &std::path::Path, dir: &PathBuf) -> Result<Sidecar, String> {
    let mut last = String::new();
    for attempt in 1..=2 {
        match Sidecar::start(node, dir, Some(&data_dir())) {
            Ok(s) => return Ok(s),
            Err(e) => {
                last = e;
                if attempt < 2 {
                    log_startup_failure(&format!(
                        "sidecar 启动失败（第 {attempt} 次，1s 后重试）: {last}"
                    ));
                    std::thread::sleep(Duration::from_millis(1000));
                }
            }
        }
    }
    Err(last)
}

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
            } else {
                // 上次启动只剩引导页：重建主窗口并关掉引导页，不用让用户重开应用
                if build_main_window(app, port, &token).is_ok() {
                    if let Some(guide) = app.get_webview_window(GUIDE_WINDOW) {
                        let _ = guide.close();
                    }
                }
            }
            // 弹窗页面同样拿着旧端口/token，重启后要刷新；首次启动失败时弹窗可能还没建
            if let Some(popup) = app.get_webview_window(TRAY_POPUP) {
                let _ = popup.eval(&port_script(port, &token));
            } else if let Err(e) = build_tray_popup(app, port, &token) {
                eprintln!("[ccconfig] 托盘弹窗创建失败: {e}");
            }
            eprintln!("[ccconfig] sidecar 已重启，端口 {port}");
        }
        Err(e) => eprintln!("[ccconfig] 重启 sidecar 失败: {e}"),
    }
}

fn setup_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    // 菜单栏沿用原来的彩色主体图（透明底、不做模板染色）；
    // 应用图标是白底圆角方块，不能拿来当菜单栏图标
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;

    // 不挂原生菜单：点击事件全部交给 handle_tray_event（左键弹自定义弹窗）
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| handle_tray_event(tray, event))
        .build(app)?;

    eprintln!(
        "[ccconfig] 托盘交互已配置：左键切换自定义弹窗（网关统计 + 订阅用量 + 动作），右键直接打开主窗口"
    );

    Ok(())
}

/// 后台健康监控 + 系统外观跟随：连续 3 次探活失败就尝试重启一次 sidecar
fn spawn_watchdog(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let mut failures = 0u32;
        let mut last_dark = system_is_dark();
        loop {
            std::thread::sleep(Duration::from_secs(5));

            // 系统外观变更后同步窗口 theme，WKWebView/WebView2 的 prefers-color-scheme 才会重算
            let dark = system_is_dark();
            if dark != last_dark {
                last_dark = dark;
                let t = theme_of(dark);
                for label in [MAIN_WINDOW, TRAY_POPUP] {
                    if let Some(win) = app.get_webview_window(label) {
                        let _ = win.set_theme(Some(t));
                    }
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
        .invoke_handler(tauri::generate_handler![
            tray_popup_action,
            tray_popup_resize,
            tray_popup_hide
        ])
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
            app.manage(TrayPopupState::default());

            // 托盘先建，保证即使 sidecar 起不来用户也有入口
            if let Err(e) = setup_tray(&handle) {
                eprintln!("[ccconfig] 托盘创建失败: {e}");
            }

            let Some(rt) = node else {
                log_startup_failure(&format!(
                    "未找到可用的 Node（>=18），已尝试：{}",
                    tried.join(" / ")
                ));
                build_guide_window(
                    &handle,
                    serde_json::json!({
                        "kind": "node",
                        "reason": format!("未找到可用的 Node（>=18）"),
                        "tried": tried,
                    }),
                )?;
                return Ok(());
            };

            match start_sidecar_with_retry(&rt.path, &sidecar_dir) {
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
                    // 弹窗常驻隐藏：页面在后台加载、量高度，首次点托盘零等待。
                    // 失败不致命：左键回落到直接打开主窗口。
                    if let Err(e) = build_tray_popup(&handle, port, &token) {
                        eprintln!("[ccconfig] 托盘弹窗创建失败（左键将打开主窗口）: {e}");
                    }
                    spawn_watchdog(handle.clone());
                }
                Err(e) => {
                    log_startup_failure(&format!("sidecar 启动失败: {e}"));
                    build_guide_window(
                        &handle,
                        serde_json::json!({
                            "kind": "sidecar",
                            "reason": e,
                            "tried": tried,
                        }),
                    )?;
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
