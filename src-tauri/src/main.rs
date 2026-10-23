// CCConfig 桌面版主进程。
//
// 职责：
//   1. 探测系统 Node（不内置运行时）
//   2. 启动 Node sidecar（承载既有 preload services.js）
//   3. 建窗口并把 sidecar 端口/token 注入前端
//   4. 托盘常驻：关窗口只隐藏，网关继续服务
//   5. 退出时优雅停止 sidecar

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod node_runtime;
mod sidecar;

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use node_runtime::NodeRuntime;
use sidecar::Sidecar;

const MAIN_WINDOW: &str = "main";
const GUIDE_WINDOW: &str = "guide";

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

fn open_path(path: &Path) {
    let _ = std::process::Command::new("open").arg(path).spawn();
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

fn build_main_window(app: &tauri::AppHandle, port: u16, token: &str) -> tauri::Result<()> {
    let script = format!(
        "window.__CCCONFIG_PORT__ = {}; window.__CCCONFIG_TOKEN__ = {};",
        port,
        serde_json::to_string(token).unwrap_or_else(|_| "\"\"".into())
    );
    // 首帧背景跟随系统外观，避免暗色模式下页面加载前先闪一下白
    let dark = system_is_dark();
    let bg = if dark {
        tauri::window::Color(24, 24, 24, 255)
    } else {
        tauri::window::Color(243, 243, 243, 255)
    };
    WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::App("index.html".into()))
        .title("CCConfig")
        .inner_size(1240.0, 840.0)
        .min_inner_size(900.0, 600.0)
        .center()
        .background_color(bg)
        // 不显式设置时 WKWebView 停在 Aqua 外观，prefers-color-scheme 永远是 light，
        // 导致系统已为暗色但界面仍渲染成亮色。
        .theme(Some(if dark {
            tauri::Theme::Dark
        } else {
            tauri::Theme::Light
        }))
        .initialization_script(&script)
        .build()?;
    Ok(())
}

fn build_guide_window(app: &tauri::AppHandle) -> tauri::Result<()> {
    let dark = system_is_dark();
    WebviewWindowBuilder::new(app, GUIDE_WINDOW, WebviewUrl::App("guide.html".into()))
        .title("CCConfig · 需要 Node.js")
        .inner_size(720.0, 560.0)
        .center()
        .theme(Some(if dark {
            tauri::Theme::Dark
        } else {
            tauri::Theme::Light
        }))
        .build()?;
    Ok(())
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
                let js = format!(
                    "window.__CCCONFIG_PORT__ = {}; window.__CCCONFIG_TOKEN__ = {};",
                    port,
                    serde_json::to_string(&token).unwrap_or_else(|_| "\"\"".into())
                );
                let _ = win.eval(&js);
            }
            eprintln!("[ccconfig] sidecar 已重启，端口 {port}");
        }
        Err(e) => eprintln!("[ccconfig] 重启 sidecar 失败: {e}"),
    }
}

fn setup_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
    let restart = MenuItem::with_id(app, "restart", "重启网关服务", true, None::<&str>)?;
    let logs = MenuItem::with_id(app, "logs", "打开日志目录", true, None::<&str>)?;
    let data = MenuItem::with_id(app, "data", "打开数据目录", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &restart, &logs, &data, &quit])?;

    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/128x128.png"))?;

    let tray = TrayIconBuilder::with_id("ccconfig-tray")
        .icon(icon)
        .menu(&menu)
        // 交互约定：左键单击弹菜单，右键单击显示窗口
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main(app),
            "restart" => restart_sidecar(app),
            "logs" => open_path(&log_dir()),
            "data" => open_path(&data_dir()),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Right,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;

    // Tauri 未暴露「右键不弹菜单」的开关，透传到底层 tray-icon；
    // 否则右键会既弹菜单又显示窗口。
    match tray.with_inner_tray_icon(|inner| {
        inner.set_show_menu_on_right_click(false);
    }) {
        Ok(_) => eprintln!("[ccconfig] 托盘交互已配置：左键单击=菜单，右键单击=窗口"),
        Err(e) => eprintln!("[ccconfig] 关闭托盘右键菜单失败（右键仍会弹菜单）: {e}"),
    }

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
                if let Some(win) = app.get_webview_window(MAIN_WINDOW) {
                    let t = if dark {
                        tauri::Theme::Dark
                    } else {
                        tauri::Theme::Light
                    };
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
