# Desktop

`desktop/` 包含 Tauri Rust 壳与 Vite 前端，仓库根指南适用于两者。前端规则见 [frontend/AGENTS.md](frontend/AGENTS.md)，壳规则见 [src-tauri/AGENTS.md](src-tauri/AGENTS.md)。桌面目录不进入 npm 包。

Rust 壳启动 Node Host、管理窗口和进程，并在两端之间搬运调用帧。业务状态和会话记录由 Node Host 管理；接口不得在壳中复制业务逻辑。

常用命令：

```sh
cd desktop
npm run dev
npm run build
cd src-tauri
cargo test
```

`npm run build` 使用前端构建结果生成平台安装包。平台目标由对应的 `tauri.*.conf.json` 指定；不能让单个平台任务误用其他平台的打包目标。安装包使用当前构建目标的 Node 与原生依赖，不得跨平台复用 `desktop/vendor/`。
