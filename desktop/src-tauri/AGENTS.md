# Desktop shell

`desktop/src-tauri/` 是桌面壳的 Rust 部分。仓库根指南与 [../AGENTS.md](../AGENTS.md) 同时适用；界面约束见 [../frontend/AGENTS.md](../frontend/AGENTS.md)。

- 壳只管理窗口与 Node Host 子进程，并逐行原样传递调用帧。Rust 不实现业务逻辑，不命名 Host 协议方法、事件或错误码；依赖中不加入序列化、HTTP 或 WebSocket 客户端。
- Tauri 命令为 `host_send`、`host_stop`、`host_restart`、`app_quit` 和 `default_workspace`。壳不持有会话选择；界面通过 `session.open` 决定恢复哪份会话。重启替换进程槽位并停止旧 Host；帧转发线程的生命周期与对应子进程一致。
- 关闭窗口和退出应用走界面确认。支持托盘时，关闭可隐藏窗口；没有托盘时保留窗口并请求确认。真正退出前关闭 Host 标准输入并终止子进程，使会话锁能释放。
- 后端入口依次读取 `LIGULE_DESKTOP_CLI`、随包的 `app/dist/cli.js` 和从可执行文件位置向上查找的 `dist/cli.js`。Node 运行时优先使用随包版本，再读取 `NODE`，最后使用 `PATH`。
- `desktop/fetch-runtime.mjs` 按 `desktop/node-pin.json` 的版本与 SHA-256 准备运行时和应用依赖到 `desktop/vendor/`。该目录不提交；每个平台只携带本平台的原生依赖，并由同平台的构建任务打包。
- 平台安装目标分别由 `tauri.windows.conf.json`、`tauri.linux.conf.json` 和 `tauri.macos.conf.json` 指定。Linux AppImage 需要方形 PNG 图标。发布清单与工作流负责对应平台的构建和产物检查。
- Rust 只依赖 Tauri 与 `tauri-plugin-dialog`；保存对话框权限保持为唯一文件访问权限。检查运行 `cargo test --manifest-path desktop/src-tauri/Cargo.toml`，覆盖后端入口查找、子进程帧转递和进程替换。
