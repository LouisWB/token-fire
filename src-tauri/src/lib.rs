mod config;
mod usage;

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, State, WebviewWindow};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

/// 摆件模式下的窗口尺寸，viewBox 是 40x50，所以按 0.8 的比例走
fn ornament_size(size: &str) -> (f64, f64) {
    match size {
        "small" => (112.0, 140.0),
        "large" => (200.0, 250.0),
        _ => (152.0, 190.0),
    }
}

/// 设置面板是独立窗口，尺寸固定。
/// 这样右键开设置时篝火既不用改大小、也不用挪位置，面板还能自己挑个不挡路的地方待着
const PANEL_W: f64 = 300.0;
const PANEL_H: f64 = 585.0; // 量出来的自然高度 560 + 上下各 10 的留白
const PANEL_GAP: i32 = 12;

pub struct AppState {
    config: Mutex<config::Config>,
    db_path: PathBuf,
    last_saved: Mutex<Option<Instant>>,
}

impl AppState {
    fn snapshot(&self) -> config::Config {
        self.config.lock().unwrap().clone()
    }

    fn remember_position(&self, x: i32, y: i32) {
        let mut last = self.last_saved.lock().unwrap();
        let now = Instant::now();
        // 拖动时事件很密集，节流一下，别把磁盘写爆
        if last.map_or(true, |at| now.duration_since(at) > Duration::from_millis(700)) {
            *last = Some(now);
            let mut cfg = self.config.lock().unwrap();
            cfg.x = Some(x);
            cfg.y = Some(y);
            let snapshot = cfg.clone();
            drop(cfg);
            let _ = config::save(&snapshot);
        }
    }
}

fn apply_ornament_size(window: &WebviewWindow, size: &str) {
    let (w, h) = ornament_size(size);
    let _ = window.set_size(LogicalSize::new(w, h));
}

/// 换尺寸或换显示器之后窗口可能跑到屏幕外，挪回来
fn clamp_into_monitor(window: &WebviewWindow) {
    let Ok(Some(monitor)) = window.current_monitor() else {
        return;
    };
    let (Ok(size), Ok(pos)) = (window.outer_size(), window.outer_position()) else {
        return;
    };
    let origin = monitor.position();
    let screen = monitor.size();
    let max_x = (origin.x + screen.width as i32 - size.width as i32).max(origin.x);
    let max_y = (origin.y + screen.height as i32 - size.height as i32).max(origin.y);
    let x = pos.x.clamp(origin.x, max_x);
    let y = pos.y.clamp(origin.y, max_y);
    if x != pos.x || y != pos.y {
        let _ = window.set_position(PhysicalPosition::new(x, y));
    }
}

/// 把设置面板摆在篝火旁边：优先左边，左边放不下换右边，都放不下就居中。
/// 竖向让面板底边跟篝火底边对齐，看着像是从篝火旁边"长"出来的
fn place_panel(app: &AppHandle) {
    let Some(panel) = app.get_webview_window("settings") else {
        return;
    };
    let _ = panel.set_size(LogicalSize::new(PANEL_W, PANEL_H));

    if let Some(main) = app.get_webview_window("main") {
        if let (Ok(Some(monitor)), Ok(main_pos), Ok(main_size)) = (
            main.current_monitor(),
            main.outer_position(),
            main.outer_size(),
        ) {
            let origin = monitor.position();
            let screen = monitor.size();
            let panel_w = (PANEL_W * monitor.scale_factor()) as i32;
            let panel_h = (PANEL_H * monitor.scale_factor()) as i32;
            let right_limit = origin.x + screen.width as i32;

            let left_x = main_pos.x - panel_w - PANEL_GAP;
            let x = if left_x >= origin.x {
                left_x
            } else if main_pos.x + main_size.width as i32 + PANEL_GAP + panel_w <= right_limit {
                main_pos.x + main_size.width as i32 + PANEL_GAP
            } else {
                origin.x + (screen.width as i32 - panel_w) / 2
            };

            let y = main_pos.y + main_size.height as i32 - panel_h;
            let max_x = (right_limit - panel_w).max(origin.x);
            let max_y = (origin.y + screen.height as i32 - panel_h).max(origin.y);
            let _ = panel.set_position(PhysicalPosition::new(
                x.clamp(origin.x, max_x),
                y.clamp(origin.y, max_y),
            ));
        }
    }

    let _ = panel.show();
    let _ = panel.set_focus();
}

#[tauri::command]
fn sample_rate(state: State<'_, AppState>) -> usage::Sample {
    usage::sample(&state.db_path, usage::TAU_SECONDS)
}

#[tauri::command]
fn check_env(state: State<'_, AppState>) -> usage::Env {
    usage::probe_env(&state.db_path)
}

#[tauri::command]
fn get_config(state: State<'_, AppState>) -> config::Config {
    state.snapshot()
}

#[tauri::command]
fn open_settings(app: AppHandle) {
    place_panel(&app);
}

#[tauri::command]
fn close_settings(app: AppHandle) {
    if let Some(panel) = app.get_webview_window("settings") {
        let _ = panel.hide();
    }
}

#[tauri::command]
fn set_config(
    app: AppHandle,
    state: State<'_, AppState>,
    metric: String,
    size: String,
    autostart: bool,
) -> Result<config::Config, String> {
    let size_changed;
    let snapshot;
    {
        let mut cfg = state.config.lock().unwrap();
        size_changed = cfg.size != size;
        cfg.metric = metric;
        cfg.size = size;
        cfg.autostart = autostart;
        snapshot = cfg.clone();
        drop(cfg);
        config::save(&snapshot)?;
    }

    // 直接按目标状态设置，幂等，不怕重复调用
    let autolaunch = app.autolaunch();
    let _ = if autostart {
        autolaunch.enable()
    } else {
        autolaunch.disable()
    };

    // 改大小是用户明确要求的，只有这时候才动篝火
    if size_changed {
        if let Some(window) = app.get_webview_window("main") {
            apply_ornament_size(&window, &snapshot.size);
            clamp_into_monitor(&window);
        }
    }

    // 面板和摆件是两个窗口，改完设置得通知摆件一声
    let _ = app.emit("config-changed", &snapshot);
    Ok(snapshot)
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

pub fn run() {
    let initial = config::load();
    let first_run = !config::exists();

    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(AppState {
            config: Mutex::new(initial.clone()),
            db_path: usage::default_db_path(),
            last_saved: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            sample_rate,
            check_env,
            get_config,
            open_settings,
            close_settings,
            set_config,
            quit_app
        ])
        .setup(move |app| {
            let window = app
                .get_webview_window("main")
                .expect("找不到主窗口");

            let (w, h) = ornament_size(&initial.size);
            let _ = window.set_size(LogicalSize::new(w, h));

            // 记住上次的位置；第一次运行就贴到右下角待着
            match (initial.x, initial.y) {
                (Some(x), Some(y)) => {
                    let _ = window.set_position(PhysicalPosition::new(x, y));
                }
                _ => {
                    if let Ok(Some(monitor)) = window.current_monitor() {
                        let screen = monitor.size();
                        let win = window.outer_size().unwrap_or_default();
                        let x = screen.width as i32 - win.width as i32 - 48;
                        let y = screen.height as i32 - win.height as i32 - 120;
                        let _ = window.set_position(PhysicalPosition::new(x.max(0), y.max(0)));
                    }
                }
            }
            clamp_into_monitor(&window);

            // 第一次跑（还没有配置文件）说明用户是新的，直接把设置面板亮出来，
            // 因为面板里会写清楚"有没有找到 ccswitch"
            if first_run {
                place_panel(app.handle());
            }

            let handle = app.handle().clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::Moved(pos) = event {
                    handle.state::<AppState>().remember_position(pos.x, pos.y);
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("启动 Tauri 失败")
        .run(|app_handle, event| {
            // 退出前再存一次，免得刚拖完就关掉
            if let tauri::RunEvent::Exit = event {
                if let Some(window) = app_handle.get_webview_window("main") {
                    if let Ok(pos) = window.outer_position() {
                        app_handle
                            .state::<AppState>()
                            .remember_position(pos.x, pos.y);
                    }
                }
                let state = app_handle.state::<AppState>();
                let snapshot = state.snapshot();
                let _ = config::save(&snapshot);
            }
        });
}