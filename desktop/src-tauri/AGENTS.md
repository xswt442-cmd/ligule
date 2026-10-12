# Desktop shell

`desktop/src-tauri/` 是桌面壳的 Rust 部分。仓库根指南与 [../AGENTS.md](../AGENTS.md) 同时适用；界面约束见 [../frontend/AGENTS.md](../frontend/AGENTS.md)。

- 壳只管理窗口与 Node Host 子进程，并逐行原样传递调用帧。Rust 不实现业务逻辑，不命名 Host 协议方法、事件或错误码；依赖中不加入序列化、HTTP 或 WebSocket 客户端。
- Tauri 命令包括 `host_send`、`host_stop`、`host_restart`、`app_quit`、`default_workspace`、`show_notification` 与 `set_tray_status`。壳不持有会话选择；界面通过 `session.open` 决定恢复哪份会话。重启替换进程槽位并停止旧 Host；帧转发线程的生命周期与对应子进程一致。
- 关闭窗口和退出应用走界面确认。支持托盘时，关闭可隐藏窗口；没有托盘时保留窗口并请求确认。真正退出前关闭 Host 标准输入并终止子进程，使会话锁能释放。
- Linux 通过现有 GTK 依赖 `gio` 监听 Session D-Bus 的托盘宿主注册状态。仅创建图标对象不足以允许隐藏窗口；宿主消失或检测失败时，恢复因托盘而隐藏的窗口。检测不启动辅助进程，不干预 Host 任务。
- 后端入口依次读取 `LIGULE_DESKTOP_CLI`、随包的 `app/dist/cli.js` 和从可执行文件位置向上查找的 `dist/cli.js`。Node 运行时优先使用随包版本，再读取 `NODE`，最后使用 `PATH`。
- `desktop/fetch-runtime.mjs` 按 `desktop/node-pin.json` 的版本与 SHA-256 准备运行时和应用依赖到 `desktop/vendor/`。该目录不提交；每个平台只携带本平台的原生依赖，并由同平台的构建任务打包。
- 平台安装目标分别由 `tauri.windows.conf.json`、`tauri.linux.conf.json` 和 `tauri.macos.conf.json` 指定。Linux AppImage 需要方形 PNG 图标。发布清单与工作流负责对应平台的构建和产物检查。
- Rust 使用 Tauri、`tauri-plugin-dialog`、`tauri-plugin-notification` 与 `notify-rust`。保存对话框只获保存权限；通知插件 capability 只开放权限状态查询与权限申请，不开放插件发送通知。壳命令 `show_notification` 接收前端提供的不透明路由值；空值只恢复主窗口，非空值在通知激活后以 `shell-notification-open` 原样交回。Rust 不解析会话或项目。
- `set_tray_status` 接收前端提供的状态文字、待处理标志与 `zh` 或 `en` 语言；缺少语言时使用中文，其他值报错。Rust 校验文字长度和控制字符后更新托盘提示、图标与已创建菜单项的打开和退出文字。托盘不可用时命令返回错误。Linux 不支持托盘提示文字；macOS 的提示点另以短标题显示。
- `show_notification` 的 Promise 在原生通知被关闭或激活后完成；macOS 使用 `notify-rust` 默认通知后端与应用身份注册，该后端在 `wait_for_response` 中发送通知并等待响应。通知激活后只接受默认激活或 `open-session` 动作。检查运行 `cargo test --manifest-path desktop/src-tauri/Cargo.toml`，覆盖后端入口查找、子进程帧转递、进程替换和通知输入规则。
