// 桌面壳（D24、D30、实现顺序第 15 步）。这里只有三类事：开窗、起后端进程、把调用帧在 WebView 与
// 后端进程的两根管道之间搬进搬出。协议内容不在这里解释——帧按整行字符串转递，壳不认识里面的方法名。
mod bridge;

use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

use bridge::Host;

const FRAME_EVENT: &str = "host-frame";
const LOG_EVENT: &str = "host-log";

#[derive(Default)]
struct AppState {
    host: Mutex<Option<Host>>,
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

#[tauri::command]
fn app_quit(app: AppHandle) {
    app.exit(0);
}

fn main() {
    tauri::Builder::default()
        .manage(AppState::default())
        .setup(|app| {
            let handle = app.handle().clone();
            if let Err(error) = start_host(&handle) {
                let _ = handle.emit(LOG_EVENT, format!("the host could not start: {error}"));
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![host_send, host_stop, host_restart, app_quit])
        .build(tauri::generate_context!())
        .expect("error while building the desktop shell")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                let _ = stop_host(app_handle);
            }
        });
}
