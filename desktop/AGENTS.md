# Desktop

`desktop/` 包含 Electron Main、沙盒 Preload 与 React Renderer，仓库根指南同样适用。前端规则见 [frontend/AGENTS.md](frontend/AGENTS.md)。构建和运行说明见 [README.md](README.md)。桌面目录不进入 npm 包。

`electron/` 的 Main 只管理窗口、原生交互、受管理的 Host 进程和不透明协议帧。独立 Node 24 Host 是唯一业务运行时；Kernel、Policy、Session、配置与凭据由 Host 处理。Main 不导入这些业务模块，也不改写协议帧的业务字段。

常用命令：

```sh
pnpm --filter ligule-desktop run dev
pnpm --filter ligule-desktop run build
pnpm --filter ligule-desktop-frontend run check
node --experimental-strip-types --test desktop/electron/test/host.test.ts desktop/electron/test/security.test.ts
desktop/vendor/node/node.exe desktop/electron/test/run-native-security.mjs
desktop/vendor/node/node.exe desktop/electron/test/run-native-features.mjs
desktop/vendor/node/node.exe desktop/electron/test/run-stub-model.mjs
```

验收使用 `electron/test/` 下的可执行测试程序；原始日志与本机验收记录保存在被忽略的 `desktop/testplace/readings/`。不同平台的结论分别验证，不能将 Windows 的运行结果当作 Linux 或 macOS 的验收。

Main 与 Preload 保持严格 TypeScript，使用现有 TypeScript 编译器；NodeNext 导入后缀为 `.js`。Preload 的运行期仅依赖沙盒支持的 Electron API；`api.ts` 供两侧共享接口类型。

窗口由 `secure-window.ts` 创建：显式启用 sandbox、contextIsolation 与 webSecurity，禁用 Node integration、webview 和不安全内容。生产页面固定为 `app://ligule/index.html`；开发页面固定为 `http://localhost:5188/`。保持 CSP、默认拒绝浏览器权限、导航与外链限制。

`ipc.ts` 是唯一 Main IPC 方法表。每个处理器校验受管理窗口、顶层 frame、精确页面来源和参数；Preload 只公开固定动作及可取消订阅，不公开动态通道、原始事件、任意文件或进程操作。保存对话框只选择路径，文件导出由 Host 执行。

发行配置在 `electron-builder.cjs`。使用当前目标的 Node、原生依赖和 `@vscode/ripgrep` 可选包，不得跨平台或架构复用 `vendor/`。生产 Fuses 必须在真实可执行文件上读取并验证；打包成功不能代替 Host、进程树、窗口和安装器验收。

`fetch-runtime.mjs` 按 `node-pin.json` 准备随包运行树。用其中的 Node 执行 `check-runtime.mjs --vendor desktop/vendor`；打包后用资源目录内的 Node 执行 `check-runtime.mjs --resources <资源目录>`，检查 CLI、命令语法、Keyring 和真实搜索后端。具体安全与原生行为使用真实 Electron 窗口测试，逐项记录已测试的平台与未验证项。
