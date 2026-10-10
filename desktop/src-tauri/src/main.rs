// 桌面壳（D24、D30、实现顺序第 15 步）。这里只有三类事：开窗、起后端进程、把调用帧在 WebView 与
// 后端进程的两根管道之间搬进搬出。协议内容不在这里解释——帧按整行字符串转递，壳不认识里面的方法名。
mod bridge;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};

use bridge::Host;

const FRAME_EVENT: &str = "host-frame";
const LOG_EVENT: &str = "host-log";
/// 退出请求说给界面听的那一条事件：哪几份会话受影响只有界面知道，壳不认识协议内容（D24、方案 6.4）。
const QUIT_EVENT: &str = "shell-quit";
const TRAY_ID: &str = "ligule-main";
const TRAY_OPEN: &str = "tray-open";
const TRAY_QUIT: &str = "tray-quit";

#[derive(Default)]
struct AppState {
    host: Mutex<Option<Host>>,
    /// 托盘有没有立起来。立不起来时点叉收起会把人关在一个找不回的位置，那一种机器上按直接退出走（方案 6.4）。
    restorable: AtomicBool,
    /// 人已经点了「中断任务并退出」。这一条之后拦退出与藏窗口都不再做。
    quitting: AtomicBool,
}

impl AppState {
    fn tray_up(&self) -> bool {
        self.restorable.load(Ordering::Relaxed)
    }

    fn confirmed_quit(&self) -> bool {
        self.quitting.load(Ordering::Relaxed)
    }
}

/// 把主窗口交回眼前：托盘「打开」、macOS 点图标，与退出前那张确认都要窗口在屏幕上才谈得成。
fn restore_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// 退出这一步从壳交到界面：壳只把窗口摆回眼前并把请求说出去，等界面确认后由 `app_quit` 真的收。
fn request_quit(app: &AppHandle) {
    restore_window(app);
    let _ = app.emit(QUIT_EVENT, ());
}

/// 后端交回的一行行转成 WebView 侧的事件。转发线程独立于调用，界面收帧不等壳。
fn pump(app: AppHandle, receiver: std::sync::mpsc::Receiver<String>, event: &'static str) {
    std::thread::spawn(move || {
        while let Ok(line) = receiver.recv() {
            if app.emit(event, line).is_err() {
                return;
            }
        }
    });
}

/// 起后端进程。壳一起来就起，界面不需要先问一次「后端在哪」——这里没有地址可给（D30）。
/// 运行时与后端入口优先用随包带的那一份（D34），没有才退回开发时的目录层级与 PATH 上的 node。
/// 槽位里已经有一具时，这一条换掉它并终止旧的：重连走的也是这一条，同一时刻只留一具进程（实现顺序第 65 步）。
fn start_host(app: &AppHandle) -> Result<(), String> {
    let exe_path = std::env::current_exe()
        .map_err(|error| format!("cannot locate this executable: {error}"))?;
    let exe_dir = exe_path.parent().ok_or("the executable has no directory")?;
    let resources = app.path().resource_dir().ok();
    let cli = bridge::resolve_cli_script(
        exe_dir,
        resources.as_deref(),
        std::env::var("LIGULE_DESKTOP_CLI").ok().as_deref(),
    )?;
    let node = bridge::bundled_node(resources.as_deref())
        .map(|path| path.display().to_string())
        .or_else(|| std::env::var("NODE").ok().filter(|value| !value.is_empty()))
        .unwrap_or_else(|| "node".to_string());
    let (host, frames, logs) = bridge::spawn_host(&node, &[&cli.display().to_string(), "host"])?;

    pump(app.clone(), frames, FRAME_EVENT);
    pump(app.clone(), logs, LOG_EVENT);
    let state = app.state::<AppState>();
    let mut slot = state.slot()?;
    if let Some(old) = bridge::install_host(&mut slot, host) {
        old.stop();
    }
    Ok(())
}

impl AppState {
    /// 拿这一份状态里的槽位。锁被毒过之后不接着用：那说明有一次搬运在持锁时 panic 了。
    fn slot(&self) -> Result<std::sync::MutexGuard<'_, Option<Host>>, String> {
        self.host
            .lock()
            .map_err(|_| "the host slot is poisoned".to_string())
    }
}

/// 终止后端进程并把它从槽位里拿走。
fn stop_host(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    if let Some(host) = state.slot()?.take() {
        host.stop();
    }
    Ok(())
}

#[tauri::command]
fn host_send(state: State<'_, AppState>, frame: String) -> Result<(), String> {
    let guard = state.slot()?;
    match guard.as_ref() {
        Some(host) => host.send(&frame),
        None => Err("the host is not running".to_string()),
    }
}

#[tauri::command]
fn host_stop(app: AppHandle) -> Result<(), String> {
    stop_host(&app)
}

/// 界面上那一个重连动作：换一具后端进程。会话由界面用 `session.open` 接回去，壳不认识会话（D30）。
#[tauri::command]
fn host_restart(app: AppHandle) -> Result<(), String> {
    start_host(&app)
}

/// 界面对过「中断任务并退出」之后才走这一条：先记下人已确认，再请求退出，`ExitRequested` 那一处就不再拦。
#[tauri::command]
fn app_quit(app: AppHandle) {
    app.state::<AppState>()
        .quitting
        .store(true, Ordering::Relaxed);
    app.exit(0);
}

/// 首次使用时那一份默认工作区：系统文档目录下的 `ligule/default-workspace`，不在那儿就建出来。
/// 文档目录由平台自己交回，这里不拼用户主目录。取不到或建不成都把原因交回界面，让那个人自己选一处可用目录——
/// 安装目录、系统目录与用户主目录都不是静默的退路（方案 5.5.3）。
#[tauri::command]
fn default_workspace(app: AppHandle) -> Result<String, String> {
    let documents = app
        .path()
        .document_dir()
        .map_err(|error| format!("the system documents directory is not reachable: {error}"))?;
    let directory = documents.join("ligule").join("default-workspace");
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("{} cannot be created: {error}", directory.display()))?;
    Ok(directory.to_string_lossy().into_owned())
}

/// 托盘那一枚与它两条菜单。立不起来时把原因说出去，界面上那一条叉就退回原来的做法：
/// 收进一个找不回的位置比直接退出更糟（方案 6.4）。
fn build_tray(app: &AppHandle) -> Result<(), String> {
    let open = MenuItem::with_id(app, TRAY_OPEN, "打开 ligule", true, None::<&str>)
        .map_err(|error| format!("the tray menu could not be built: {error}"))?;
    let quit = MenuItem::with_id(app, TRAY_QUIT, "退出 ligule", true, None::<&str>)
        .map_err(|error| format!("the tray menu could not be built: {error}"))?;
    let menu = Menu::with_items(app, &[&open, &quit])
        .map_err(|error| format!("the tray menu could not be built: {error}"))?;
    let icon = app
        .default_window_icon()
        .ok_or("the shell carries no icon to put in the tray")?
        .clone();
    TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("ligule")
        .icon(icon)
        .on_menu_event(|handle, event| match event.id.as_ref() {
            TRAY_OPEN => restore_window(handle),
            TRAY_QUIT => request_quit(handle),
            other => {
                let _ = handle.emit(
                    LOG_EVENT,
                    format!("the tray menu item is not known to this shell: {other}"),
                );
            }
        })
        .build(app)
        .map(|_| ())
        .map_err(|error| format!("the tray could not be built: {error}"))
}

fn main() {
    tauri::Builder::default()
        .manage(AppState::default())
        // 原生保存对话框那一个插件（方案 6A）：界面自己开那扇窗，壳不读记录也不写文件。
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle().clone();
            if let Err(error) = start_host(&handle) {
                let _ = handle.emit(LOG_EVENT, format!("the host could not start: {error}"));
            }
            match build_tray(&handle) {
                Ok(()) => handle
                    .state::<AppState>()
                    .restorable
                    .store(true, Ordering::Relaxed),
                Err(error) => {
                    let _ = handle.emit(LOG_EVENT, format!("the tray is not available: {error}"));
                }
            }
            Ok(())
        })
        // 点叉收起这一扇窗：WebView、后端进程、跑着的轮次、待答的卡与排着的几句都原样留着（方案 6.4）。
        // 收起不弹中断确认——那一句确认只在人真的要走的时候问。
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let state = window.app_handle().state::<AppState>();
                if state.tray_up() && !state.confirmed_quit() {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            host_send,
            host_stop,
            host_restart,
            app_quit,
            default_workspace
        ])
        .build(tauri::generate_context!())
        .expect("error while building the desktop shell")
        .run(|app_handle, event| match event {
            // 退出入口走同一条检查：托盘「退出」、macOS 的 Cmd+Q、关掉最后一扇窗口都先到这里，
            // 由界面说出受影响的会话并等人确认；人点过「中断任务并退出」之后 `app_quit` 才真的收（方案 6.4）。
            tauri::RunEvent::ExitRequested { api, .. } => {
                let state = app_handle.state::<AppState>();
                if state.tray_up() && !state.confirmed_quit() {
                    api.prevent_exit();
                    request_quit(app_handle);
                }
            }
            // macOS 上窗口收起之后点程序图标：把窗口交回眼前，不再起第二具 Host。这一条只有 macOS 有那个事件。
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => restore_window(app_handle),
            tauri::RunEvent::Exit => {
                let _ = stop_host(app_handle);
            }
            _ => {}
        });
}
