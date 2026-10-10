// 后端进程的托管与调用帧的转递（D24、D30）。这一层只认「一行一条消息」，不认消息里是什么：
// 帧按字符串进出，协议的两端各自实现，壳不理解协议内容。
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{Receiver, Sender};
use std::sync::Mutex;

/// 找后端入口，按这三步：环境变量指的那一份 → 随包带的那一份（安装包里的 `app/dist/cli.js`，D34）
/// → 从可执行文件所在目录往上找 `dist/cli.js`（开发时的目录层级，构建之后才有）。
/// 找不到的情形要说清楚找过哪几处：开发时目录层级一改就找不到后端，报一句「找不到」查不出来。
pub fn resolve_cli_script(
    exe_dir: &Path,
    resource_dir: Option<&Path>,
    override_path: Option<&str>,
) -> Result<PathBuf, String> {
    if let Some(path) = override_path.filter(|value| !value.is_empty()) {
        let candidate = PathBuf::from(path);
        if candidate.is_file() {
            return Ok(candidate);
        }
        return Err(format!(
            "LIGULE_DESKTOP_CLI points at {}, which is not a file",
            candidate.display()
        ));
    }

    let mut tried = Vec::new();
    if let Some(directory) = resource_dir {
        let candidate = directory.join("app").join("dist").join("cli.js");
        tried.push(candidate.display().to_string());
        if candidate.is_file() {
            return Ok(candidate);
        }
    }

    const SEARCH_DEPTH: u32 = 6;
    let mut directory = Some(exe_dir.to_path_buf());
    for _ in 0..SEARCH_DEPTH {
        let current = match directory {
            Some(path) => path,
            None => break,
        };
        let candidate = current.join("dist").join("cli.js");
        tried.push(candidate.display().to_string());
        if candidate.is_file() {
            return Ok(candidate);
        }
        directory = current.parent().map(|parent| parent.to_path_buf());
    }
    Err(format!(
        "no dist/cli.js found, run npm run build (checked {})",
        tried.join(", ")
    ))
}

/// 随包带的 Node 可执行文件（D34：安装包自带一套运行时，不要求那台机器上有 node）。
/// 没有随包带时交回 None，调用方退回 `NODE` 环境变量或者 PATH 上的 node。
pub fn bundled_node(resource_dir: Option<&Path>) -> Option<PathBuf> {
    let candidate = resource_dir?.join("node").join(node_file_name());
    candidate.is_file().then_some(candidate)
}

#[cfg(windows)]
fn node_file_name() -> &'static str {
    "node.exe"
}

#[cfg(not(windows))]
fn node_file_name() -> &'static str {
    "node"
}

pub struct Host {
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Child>,
}

fn pump<R: std::io::Read + Send + 'static>(reader: R, sink: Sender<String>) {
    std::thread::spawn(move || {
        for line in BufReader::new(reader).lines() {
            match line {
                Ok(text) => {
                    // 接收端关掉之后就不再有地方交：那是壳自己退出的路上，不是后端的错。
                    if sink.send(text).is_err() {
                        return;
                    }
                }
                Err(error) => {
                    let _ = sink.send(format!("[bridge] read failed: {error}"));
                    return;
                }
            }
        }
    });
}

/// 起后端进程，交回进程本身与两条读到的行流（帧与日志）。
/// 流不放在 `Host` 里：读流要交给转发线程持有，而进程本身要留在壳的状态里。
pub fn spawn_host(
    program: &str,
    args: &[&str],
) -> Result<(Host, Receiver<String>, Receiver<String>), String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command.spawn().map_err(|error| {
        format!(
            "failed to start the host ({} {}): {error}",
            program,
            args.join(" ")
        )
    })?;
    let stdin = child.stdin.take().ok_or("the host has no stdin")?;
    let stdout = child.stdout.take().ok_or("the host has no stdout")?;
    let stderr = child.stderr.take().ok_or("the host has no stderr")?;

    let (frames_tx, frames) = std::sync::mpsc::channel();
    let (logs_tx, logs) = std::sync::mpsc::channel();
    pump(stdout, frames_tx);
    pump(stderr, logs_tx);

    Ok((
        Host {
            stdin: Mutex::new(Some(stdin)),
            child: Mutex::new(child),
        },
        frames,
        logs,
    ))
}

impl Host {
    /// 交出一帧。行尾的换行由这一层补，上面不需要知道帧是怎么分的。
    pub fn send(&self, frame: &str) -> Result<(), String> {
        let mut guard = self
            .stdin
            .lock()
            .map_err(|_| "the host's stdin is gone".to_string())?;
        let stdin = guard.as_mut().ok_or("the host's stdin is already closed")?;
        writeln!(stdin, "{frame}")
            .map_err(|error| format!("failed to write to the host: {error}"))?;
        stdin
            .flush()
            .map_err(|error| format!("failed to flush the host's stdin: {error}"))
    }

    /// 让后端进程自己收尾：交回那根输入管道就是「这边不再发帧了」，宿主读到头就走它自己的释放
    /// （取消在跑的轮次、把每份会话的记录锁松开）。等到上限它还没退才硬杀——那时它已经不听了。
    /// 直接杀会把记录锁留在磁盘上等那十秒租约过期，下一次打开那份会话就先读到 `session_locked`。
    /// 收尾交出的是这一具子进程怎么结束的：等没等满那扇时间窗不是可观察的事实，
    /// 一具慢机器上自己退的也可能走过半扇窗，所以检查读的是结局，不是钟点。
    pub fn stop(&self) -> Stopped {
        if let Ok(mut guard) = self.stdin.lock() {
            drop(guard.take());
        }
        if let Ok(mut child) = self.child.lock() {
            for _ in 0..SELF_CLOSE_TRIES {
                if let Ok(Some(status)) = child.try_wait() {
                    return Stopped::of(&status);
                }
                std::thread::sleep(std::time::Duration::from_millis(SELF_CLOSE_PAUSE_MS));
            }
            let _ = child.kill();
            return match child.wait() {
                Ok(status) => Stopped::of(&status),
                Err(_) => Stopped::Gone,
            };
        }
        Stopped::Gone
    }
}

/// `stop` 的那三种结局。`Exited` 与 `Killed` 读的是退出状态：自己按 `exit(0)` 收工的交出成功码，
/// 被这头杀掉的交出信号或非零码；锁用不了时什么都读不到，那是 `Gone`。
#[derive(Debug, PartialEq, Eq)]
pub enum Stopped {
    Exited,
    Killed,
    Gone,
}

impl Stopped {
    fn of(status: &std::process::ExitStatus) -> Self {
        if status.success() {
            Stopped::Exited
        } else {
            Stopped::Killed
        }
    }
}

/// 那一具进程自己收的时间窗：三秒在本机量过是够的（空闲宿主读到 EOF 到退出是几十毫秒），
/// 上限之外仍然由壳杀，退出这件事不能悬着。
const SELF_CLOSE_TRIES: u32 = 60;
const SELF_CLOSE_PAUSE_MS: u64 = 50;

/// 槽位里换上新的一具后端进程，交回被换掉的那一份。调用方要终止它。
/// 同一时刻只留一具进程：重连时不换就会有两具各自往同一个窗口写帧（实现顺序第 65 步）。
pub fn install_host(slot: &mut Option<Host>, next: Host) -> Option<Host> {
    slot.replace(next)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{Duration, Instant};

    fn temp_dir(tag: &str) -> PathBuf {
        let directory =
            std::env::temp_dir().join(format!("ligule-desktop-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).expect("create the temporary directory");
        directory
    }

    #[test]
    fn finds_the_cli_by_walking_up_from_the_executable_directory() {
        let root = temp_dir("walk");
        let exe_dir = root
            .join("desktop")
            .join("src-tauri")
            .join("target")
            .join("debug");
        fs::create_dir_all(exe_dir.join("nested")).expect("create the executable directory");
        fs::create_dir_all(root.join("dist")).expect("create dist");
        fs::write(root.join("dist").join("cli.js"), "#!/usr/bin/env node\n")
            .expect("write the cli stub");

        assert_eq!(
            resolve_cli_script(&exe_dir, None, None).expect("found"),
            root.join("dist").join("cli.js")
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_missing_cli_names_the_directories_it_tried() {
        let root = temp_dir("absent");
        let error = resolve_cli_script(&root, None, None).expect_err("nothing to find");
        assert!(error.contains("dist/cli.js"), "{error}");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn an_override_pointing_nowhere_is_refused_instead_of_falling_back() {
        let root = temp_dir("override");
        fs::create_dir_all(root.join("dist")).expect("create dist");
        fs::write(root.join("dist").join("cli.js"), "").expect("write a decoy");
        let missing = root.join("nowhere.js");
        let error = resolve_cli_script(&root, None, Some(missing.to_str().expect("utf-8 path")))
            .expect_err("refused");
        assert!(error.contains("LIGULE_DESKTOP_CLI"), "{error}");
        let _ = fs::remove_dir_all(&root);
    }

    /// 收尾那一条要验的是「不用杀它」：关掉输入管道就是这头不再发帧，那具进程读到头自己退。
    /// 判据是自己退还是被杀，不是钟点。
    #[test]
    fn a_child_that_exits_on_closed_stdin_is_not_waited_out() {
        // 先等它自己报一句 ready：没有这一格，慢机器上会在它那具进程还没装上 'end' 处理之前就把管道断了。
        let script = "process.stdout.write('ready\\n'); process.stdin.resume(); process.stdin.on('end', () => process.exit(0));";
        let node = std::env::var("NODE").unwrap_or_else(|_| "node".to_string());
        let (host, frames, _logs) = spawn_host(&node, &["-e", script]).expect("spawn the child");
        assert_eq!(recv(&frames).as_deref(), Some("ready"), "the child should say it is listening");
        assert_eq!(
            host.stop(),
            Stopped::Exited,
            "关掉输入管道就该自己收工，不必走到杀那一步"
        );
    }

    /// 另一头的形状：那具进程不理闭掉的输入管道，壳就在窗口之后杀掉它——退出这件事不能悬着。
    #[test]
    fn a_child_that_ignores_the_closed_stdin_is_killed_after_the_window() {
        // 读的是结局：等满那扇时间窗之后被杀的，交回的是信号或非零码，与钟点无关。
        let script = "process.stdout.write('ready\\n'); setInterval(() => {}, 1000);";
        let node = std::env::var("NODE").unwrap_or_else(|_| "node".to_string());
        let (host, frames, _logs) = spawn_host(&node, &["-e", script]).expect("spawn the child");
        assert_eq!(recv(&frames).as_deref(), Some("ready"), "the child should say it is up");
        assert_eq!(
            host.stop(),
            Stopped::Killed,
            "装聋的那一具要走过那扇时间窗再被杀，不能算自己退的"
        );
    }

    #[test]
    fn frames_cross_the_child_in_both_directions_one_per_line() {
        // 真的起一个子进程：这一层要验的是「一行一条」的转递与两个方向都能通，不是它能不能编译。
        // 脚本用事件监听而不是 `for await`：`node -e` 走 CommonJS，顶层的 for await 在那里是语法错误。
        let script = "require('node:readline').createInterface({ input: process.stdin }).on('line', \
                      (line) => { process.stdout.write('echo ' + line + '\\n'); process.stderr.write('log ' + line + '\\n'); });";
        let node = std::env::var("NODE").unwrap_or_else(|_| "node".to_string());
        let (host, frames, logs) = spawn_host(&node, &["-e", script]).expect("spawn the child");

        host.send(r#"{"id":"1","method":"ping"}"#)
            .expect("write a frame");
        // 收不到帧的时候，把子进程写过来的话一起报出来：起不来的原因通常就写在里面。
        let frame = recv(&frames)
            .unwrap_or_else(|| panic!("no frame came back; the child wrote: {:?}", drain(&logs)));
        assert_eq!(frame, r#"echo {"id":"1","method":"ping"}"#);
        assert_eq!(
            recv(&logs).expect("a log line comes back"),
            r#"log {"id":"1","method":"ping"}"#
        );

        host.send("second").expect("write a second frame");
        assert_eq!(
            recv(&frames).expect("the second frame comes back"),
            "echo second"
        );
        host.stop();
    }

    fn recv(receiver: &Receiver<String>) -> Option<String> {
        let deadline = Instant::now() + Duration::from_secs(20);
        while Instant::now() < deadline {
            if let Ok(frame) = receiver.recv_timeout(Duration::from_millis(200)) {
                return Some(frame);
            }
        }
        None
    }

    /// 把此刻已经到手的行都读出来，只用于失败信息。
    fn drain(receiver: &Receiver<String>) -> Vec<String> {
        let mut lines = Vec::new();
        while let Ok(line) = receiver.try_recv() {
            lines.push(line);
        }
        lines
    }

    #[test]
    fn the_bundled_runtime_is_found_before_the_development_tree() {
        let root = temp_dir("bundle");
        let exe_dir = root.join("install");
        let resources = root.join("resources");
        fs::create_dir_all(&exe_dir).expect("create the executable directory");
        fs::create_dir_all(resources.join("app").join("dist")).expect("create the bundled tree");
        fs::write(
            resources.join("app").join("dist").join("cli.js"),
            "// bundled\n",
        )
        .expect("write the bundled entry");
        // 开发时那份仓库也在往上找得到的位置上：随包带的那一份要先，不然装好的应用会去用错处的代码。
        fs::create_dir_all(root.join("dist")).expect("create the development tree");
        fs::write(root.join("dist").join("cli.js"), "// development\n")
            .expect("write the development entry");

        assert_eq!(
            resolve_cli_script(&exe_dir, Some(&resources), None).expect("found"),
            resources.join("app").join("dist").join("cli.js")
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_bundled_node_is_used_only_when_it_is_really_there() {
        let root = temp_dir("node");
        let node = root.join("node").join(node_file_name());
        assert_eq!(bundled_node(Some(&root)), None);

        fs::create_dir_all(root.join("node")).expect("create the node directory");
        fs::write(&node, "not a real node, only a marker\n").expect("write the marker");
        assert_eq!(bundled_node(Some(&root)), Some(node));
        assert_eq!(bundled_node(None), None);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_second_host_replaces_the_first_one_and_the_first_stops_carrying_frames() {
        // 重连那一条路要成立：槽位换新的那一具之后，旧的那一份既不能再写帧，也不再往窗口里送（第 65 步）。
        let script =
            "require('node:readline').createInterface({ input: process.stdin }).on('line', \
                      (line) => { process.stdout.write('echo ' + line + '\\n'); });";
        let node = std::env::var("NODE").unwrap_or_else(|_| "node".to_string());
        let (first, first_frames, _) =
            spawn_host(&node, &["-e", script]).expect("spawn the first child");
        let (second, second_frames, _) =
            spawn_host(&node, &["-e", script]).expect("spawn the second child");

        let mut slot: Option<Host> = None;
        assert!(
            install_host(&mut slot, first).is_none(),
            "an empty slot has nothing to replace"
        );
        let old = install_host(&mut slot, second).expect("the previous host comes back");
        assert!(slot.is_some(), "one host is left in the slot");
        old.stop();

        assert!(
            old.send("nope").is_err(),
            "a stopped host cannot carry a frame"
        );
        assert!(first_frames
            .recv_timeout(Duration::from_millis(300))
            .is_err());
        slot.as_ref()
            .expect("the live host")
            .send("ping")
            .expect("write a frame");
        assert_eq!(
            recv(&second_frames).expect("the new child answers"),
            "echo ping"
        );
        slot.take().expect("the live host").stop();
    }
}
