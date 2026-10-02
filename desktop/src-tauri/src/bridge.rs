// 后端进程的托管与调用帧的转递（D24、D30）。这一层只认「一行一条消息」，不认消息里是什么：
// 帧按字符串进出，协议的两端各自实现，壳不理解协议内容。
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{Receiver, Sender};
use std::sync::Mutex;

/// 从可执行文件所在目录往上找 `src/cli.js`，找到就交出它的绝对路径。
/// 找不到的情形要说清楚找过哪几层：开发时目录层级一改就找不到后端，报一句「找不到」查不出来。
pub fn resolve_cli_script(exe_dir: &Path, override_path: Option<&str>) -> Result<PathBuf, String> {
    if let Some(path) = override_path.filter(|value| !value.is_empty()) {
        let candidate = PathBuf::from(path);
        if candidate.is_file() {
            return Ok(candidate);
        }
        return Err(format!("LIGULE_DESKTOP_CLI points at {}, which is not a file", candidate.display()));
    }

    const SEARCH_DEPTH: u32 = 6;
    let mut directory = Some(exe_dir.to_path_buf());
    let mut tried = Vec::new();
    for _ in 0..SEARCH_DEPTH {
        let current = match directory {
            Some(path) => path,
            None => break,
        };
        let candidate = current.join("src").join("cli.js");
        tried.push(candidate.display().to_string());
        if candidate.is_file() {
            return Ok(candidate);
        }
        directory = current.parent().map(|parent| parent.to_path_buf());
    }
    Err(format!(
        "no src/cli.js found from {} upwards (checked {})",
        exe_dir.display(),
        tried.join(", ")
    ))
}

pub struct Host {
    stdin: Mutex<ChildStdin>,
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
pub fn spawn_host(program: &str, args: &[&str]) -> Result<(Host, Receiver<String>, Receiver<String>), String> {
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

    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to start the host ({} {}): {error}", program, args.join(" ")))?;
    let stdin = child.stdin.take().ok_or("the host has no stdin")?;
    let stdout = child.stdout.take().ok_or("the host has no stdout")?;
    let stderr = child.stderr.take().ok_or("the host has no stderr")?;

    let (frames_tx, frames) = std::sync::mpsc::channel();
    let (logs_tx, logs) = std::sync::mpsc::channel();
    pump(stdout, frames_tx);
    pump(stderr, logs_tx);

    Ok((
        Host {
            stdin: Mutex::new(stdin),
            child: Mutex::new(child),
        },
        frames,
        logs,
    ))
}

impl Host {
    /// 交出一帧。行尾的换行由这一层补，上面不需要知道帧是怎么分的。
    pub fn send(&self, frame: &str) -> Result<(), String> {
        let mut stdin = self.stdin.lock().map_err(|_| "the host's stdin is gone".to_string())?;
        writeln!(stdin, "{frame}").map_err(|error| format!("failed to write to the host: {error}"))?;
        stdin.flush().map_err(|error| format!("failed to flush the host's stdin: {error}"))
    }

    /// 终止后端进程。Windows 上没有能够送达进程并让它自己退出的终止信号，参照实现同样是直接终止
    /// （`cline/apps/examples/desktop-app/src-tauri/src/main.rs:342-377`）。
    pub fn stop(&self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{Duration, Instant};

    fn temp_dir(tag: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!("ligule-desktop-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).expect("create the temporary directory");
        directory
    }

    #[test]
    fn finds_the_cli_by_walking_up_from_the_executable_directory() {
        let root = temp_dir("walk");
        let exe_dir = root.join("desktop").join("src-tauri").join("target").join("debug");
        fs::create_dir_all(exe_dir.join("nested")).expect("create the executable directory");
        fs::create_dir_all(root.join("src")).expect("create src");
        fs::write(root.join("src").join("cli.js"), "#!/usr/bin/env node\n").expect("write the cli stub");

        assert_eq!(resolve_cli_script(&exe_dir, None).expect("found"), root.join("src").join("cli.js"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_missing_cli_names_the_directories_it_tried() {
        let root = temp_dir("absent");
        let error = resolve_cli_script(&root, None).expect_err("nothing to find");
        assert!(error.contains("src/cli.js"), "{error}");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn an_override_pointing_nowhere_is_refused_instead_of_falling_back() {
        let root = temp_dir("override");
        fs::create_dir_all(root.join("src")).expect("create src");
        fs::write(root.join("src").join("cli.js"), "").expect("write a decoy");
        let missing = root.join("nowhere.js");
        let error = resolve_cli_script(&root, Some(missing.to_str().expect("utf-8 path"))).expect_err("refused");
        assert!(error.contains("LIGULE_DESKTOP_CLI"), "{error}");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn frames_cross_the_child_in_both_directions_one_per_line() {
        // 真的起一个子进程：这一层要验的是「一行一条」的转递与两个方向都能通，不是它能不能编译。
        // 脚本用事件监听而不是 `for await`：`node -e` 走 CommonJS，顶层的 for await 在那里是语法错误。
        let script = "require('node:readline').createInterface({ input: process.stdin }).on('line', \
                      (line) => { process.stdout.write('echo ' + line + '\\n'); process.stderr.write('log ' + line + '\\n'); });";
        let node = std::env::var("NODE").unwrap_or_else(|_| "node".to_string());
        let (host, frames, logs) = spawn_host(&node, &["-e", script]).expect("spawn the child");

        host.send(r#"{"id":"1","method":"ping"}"#).expect("write a frame");
        // 收不到帧的时候，把子进程写过来的话一起报出来：起不来的原因通常就写在里面。
        let frame = recv(&frames).unwrap_or_else(|| panic!("no frame came back; the child wrote: {:?}", drain(&logs)));
        assert_eq!(frame, r#"echo {"id":"1","method":"ping"}"#);
        assert_eq!(recv(&logs).expect("a log line comes back"), r#"log {"id":"1","method":"ping"}"#);

        host.send("second").expect("write a second frame");
        assert_eq!(recv(&frames).expect("the second frame comes back"), "echo second");
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
}
