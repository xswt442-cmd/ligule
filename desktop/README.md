# 桌面端开发说明

[简体中文](README.md) · [English](README.en.md)

桌面应用由 `electron/` 中的 Electron Main 与 Preload、`frontend/` 中的 React 前端，以及独立 Node Host 组成。Main 只管理窗口和 Host 进程，业务逻辑与会话状态由 Node Host 管理。

## 环境与依赖

使用 Node.js 24 或更新版本。仓库在根 `package.json` 中固定 pnpm 版本；从根目录冻结安装全部工作区依赖：

```sh
pnpm install --frozen-lockfile
```

Electron `44.7.0`、electron-builder `26.15.3`、`@electron/fuses` `2.1.3` 与 `builder-util` `26.15.3` 固定为桌面包的开发依赖。Electron npm 包不自动下载平台二进制；安装工作区依赖后，通过它提供的 CLI 为当前操作系统和架构安装匹配版本：

```sh
pnpm --filter ligule-desktop exec install-electron
```

## 启动开发应用

先构建核心、准备本机的 Node 运行时和 Host 运行树，并安装 Electron 二进制，再从仓库根目录运行桌面开发入口：

```sh
pnpm --filter ligule run build
pnpm --filter ligule run prepare-runtime
pnpm --filter ligule-desktop exec install-electron
pnpm --filter ligule-desktop run dev
```

开发入口先编译 Electron TypeScript，再启动固定在 `http://localhost:5188/` 的 Vite 服务和 Electron。只有该入口会向 Electron 传入 `--dev`。

## 检查前端

```sh
pnpm --filter ligule-desktop-frontend run check
pnpm --filter ligule-desktop-frontend run build
```

## 验收

自动化检查、真实窗口测试和安装器验收的程序位于 `electron/test/`；运行日志与验收记录留在被 Git 忽略的 `desktop/testplace/readings/`，不会随仓库分发。安装依赖、准备根 Host 和目标 Node 后，先运行桌面构建以生成 Electron Main、Frontend 和目标平台应用，再执行真实窗口测试。`run-installer-smoke.ps1` 还需要先生成 Windows NSIS 安装包。

`run-stub-model.mjs` 会启动真实 Electron 主进程、生产 Preload、`app://` 窗口和独立 Node Host；只有模型端点由本机确定性 stub 替代。它在隔离项目中写入测试 Skill，并配置真实 stdio MCP fixture，检查 Skill 目录发现、激活与正文加载、MCP 工具定义披露、Skill 激活审批、`mcp.inspect` 审批、`mcp.call` 审批、真实 MCP 子进程调用和结果入会话。该用例不需要真实模型密钥，也不等同于真实模型验收。

```sh
pnpm exec tsc -p desktop/electron/tsconfig.json
node --experimental-strip-types --test desktop/electron/test/host.test.ts desktop/electron/test/security.test.ts
```

在 Linux 和 macOS 上用随包 Node 检查 POSIX 进程组，并启动真实窗口。Linux 需要 `xvfb-run` 提供图形会话：

```sh
desktop/vendor/node/node --experimental-strip-types --test desktop/electron/test/posix-process-tree.test.ts
# Linux
xvfb-run -a desktop/vendor/node/node desktop/electron/test/run-native-security.mjs
xvfb-run -a desktop/vendor/node/node desktop/electron/test/run-stub-model.mjs
xvfb-run -a desktop/vendor/node/node desktop/electron/test/run-packaged-smoke.mjs --app-dir <解包应用的绝对路径>
# macOS
desktop/vendor/node/node desktop/electron/test/run-native-security.mjs
desktop/vendor/node/node desktop/electron/test/run-stub-model.mjs
desktop/vendor/node/node desktop/electron/test/run-packaged-smoke.mjs --app-dir <ligule.app 的绝对路径>
```

Windows 使用随包 Node 运行 Job Object 检查和原生对话框测试，并执行 NSIS 隔离安装验收：

```powershell
desktop/vendor/node/node.exe --experimental-strip-types --test desktop/electron/test/process-tree.test.ts
desktop/vendor/node/node.exe desktop/electron/test/run-native-security.mjs
desktop/vendor/node/node.exe desktop/electron/test/run-stub-model.mjs
desktop/vendor/node/node.exe desktop/electron/test/run-native-features.mjs
desktop/vendor/node/node.exe desktop/electron/test/run-packaged-smoke.mjs
powershell.exe -NoProfile -ExecutionPolicy Bypass -File desktop/electron/test/run-installer-smoke.ps1
```

要单独运行带 Skill 与 MCP 流程的真实 Electron stub 验收，在仓库根目录执行 `desktop/vendor/node/node.exe desktop/electron/test/run-stub-model.mjs`。它会构建证据报告并在成功后删除自己的临时项目；失败时会保留临时项目与日志以供排查。

Linux 使用 `xvfb-run -a` 运行 `run-native-security.mjs`、`run-stub-model.mjs` 和 `run-packaged-smoke.mjs`；macOS 直接运行这些测试。POSIX `posix-process-tree.test.ts` 验证受控停止与 Main 强杀后的孤儿 Host watchdog；Windows 用 `process-tree.test.ts` 验证 Job Object。`run-native-features.mjs` 的保存对话框和托盘自动化仅支持 Windows。系统通知点击没有自动化验收入口，必须记为未执行；托盘、通知和点击跳转仍需按目标系统人工实机检查。真实窗口测试使用隔离工作区和数据根。

## 构建应用

先构建核心包并准备当前操作系统和架构对应的 Node 运行时：

```sh
pnpm --filter ligule run build
pnpm --filter ligule run prepare-runtime
pnpm --filter ligule-desktop exec install-electron
```

再从仓库根目录执行桌面构建：

```sh
pnpm --filter ligule-desktop run build
```

`pnpm --filter ligule-desktop run build:dir` 生成未安装目录，适合检查 `app.asar` 与随包资源。`build:win`、`build:linux`、`build:mac` 分别生成 Windows x64 NSIS、Linux x64 AppImage 与 deb、macOS 本机架构 DMG。macOS arm64 与 x64 需要分别在对应架构的机器上构建，并先准备该机的运行时。构建会拒绝与本机架构或 Node 运行时标记不符的架构参数。发行构建不会自动发布，也不使用开发者证书签名或公证。为保证 Apple Silicon 上启用 fuses 的应用可以启动，arm64 macOS 构建会重置 Electron 要求的 ad-hoc 签名。

`pnpm --filter ligule run prepare-runtime` 会校验根 `packageManager` 指定的 pnpm 版本，再调用 `fetch-runtime.mjs` 下载并验证 [`node-pin.json`](node-pin.json) 中的 Node 归档，准备 `vendor/node/` 与 `vendor/app/`。打包后 Node 与 Host 运行树位于应用资源目录，应用代码、前端文件和图标位于 `app.asar`。构建会关闭 Electron 的 RunAsNode、NODE_OPTIONS 和命令行调试开关，并要求应用从 `app.asar` 加载；Windows 与 macOS 的打包配置同时启用归档完整性检查。

安装包写入 `desktop/release/`。目标平台的运行时必须在对应平台和架构上准备，不能复用其他平台生成的 `vendor/`。

## 应用图标

[`assets/app-icon.png`](assets/app-icon.png) 是源图。在 Windows 上重新生成桌面图标：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File desktop/make-icons.ps1
node desktop/make-ico.mjs
```

脚本将 PNG 和 ICO 图标写入 `desktop/icons/`，并将前端使用的 PNG 写入 `desktop/frontend/public/`。
