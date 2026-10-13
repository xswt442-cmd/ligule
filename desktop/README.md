# 桌面端开发说明

[简体中文](README.md) · [English](README.en.md)

桌面应用由 `electron/` 中的 Electron Main 与 Preload、`frontend/` 中的 React 前端，以及独立 Node Host 组成。Main 只管理窗口和 Host 进程，业务逻辑与会话状态由 Node Host 管理。

## 环境与依赖

使用 Node.js 24 或更新版本。分别安装仓库、桌面壳和前端依赖：

```sh
npm ci
npm --prefix desktop ci
npm --prefix desktop/frontend ci
```

Electron `44.7.0`、electron-builder `26.15.3` 与 `@electron/fuses` `2.1.3` 固定为桌面目录的开发依赖。

## 启动开发应用

先构建核心并准备本机的 Node 运行时和 Host 运行树，再从仓库根目录运行桌面开发入口：

```sh
npm run build
node desktop/fetch-runtime.mjs
npm --prefix desktop run dev
```

开发入口先编译 Electron TypeScript，再启动固定在 `http://localhost:5188/` 的 Vite 服务和 Electron。只有该入口会向 Electron 传入 `--dev`。

## 检查前端

```sh
npm --prefix desktop/frontend run check
npm --prefix desktop/frontend run build
```

## 验收

自动化检查、真实窗口测试和安装器验收的程序位于 `electron/test/`；运行日志与验收记录留在被 Git 忽略的 `desktop/testplace/readings/`，不会随仓库分发。在 Windows 上按顺序运行：

```sh
node node_modules/typescript/bin/tsc -p desktop/electron/tsconfig.json
node --experimental-strip-types --test desktop/electron/test/host.test.ts desktop/electron/test/security.test.ts
desktop/vendor/node/node.exe --experimental-strip-types --test desktop/electron/test/process-tree.test.ts
desktop/vendor/node/node.exe desktop/electron/test/run-native-security.mjs
desktop/vendor/node/node.exe desktop/electron/test/run-native-features.mjs
desktop/vendor/node/node.exe desktop/electron/test/run-stub-model.mjs
desktop/vendor/node/node.exe desktop/electron/test/run-packaged-smoke.mjs
powershell.exe -NoProfile -ExecutionPolicy Bypass -File desktop/electron/test/run-installer-smoke.ps1
```

从 Git Bash 直接启动 Electron 之前要先执行 `unset ELECTRON_RUN_AS_NODE NODE_OPTIONS NODE_PATH`，否则测试脚本会被当成普通 Node 脚本执行。真实窗口与安装器用例只使用隔离的测试工作区和数据根，证据写入被忽略的 `desktop/testplace/readings/`。`run-native-features.mjs` 只在 Windows 上提供保存对话框自动化；`run-real-model.mjs` 还需要本机凭据记录，并依赖共享运行时的流式解析修复。

## 构建应用

先构建核心包并准备当前操作系统和架构对应的 Node 运行时：

```sh
npm run build
node desktop/fetch-runtime.mjs
```

再从仓库根目录执行桌面构建：

```sh
npm --prefix desktop run build
```

`npm --prefix desktop run build:dir` 生成未安装目录，适合检查 `app.asar` 与随包资源。`build:win`、`build:linux`、`build:mac` 分别生成 Windows x64 NSIS、Linux x64 AppImage 与 deb、macOS 本机架构 DMG。macOS arm64 与 x64 需要分别在对应架构的机器上构建，并先准备该机的运行时。构建会拒绝与本机架构或 Node 运行时标记不符的架构参数。发行构建不会自动发布，也不使用开发者证书签名或公证。为保证 Apple Silicon 上启用 fuses 的应用可以启动，arm64 macOS 构建会重置 Electron 要求的 ad-hoc 签名。

`fetch-runtime.mjs` 按 [`node-pin.json`](node-pin.json) 下载并验证 Node 归档，再准备 `vendor/node/` 与 `vendor/app/`。打包后 Node 与 Host 运行树位于应用资源目录，应用代码、前端文件和图标位于 `app.asar`。构建会关闭 Electron 的 RunAsNode、NODE_OPTIONS 和命令行调试开关，并要求应用从 `app.asar` 加载；Windows 与 macOS 的打包配置同时启用归档完整性检查。

安装包写入 `desktop/release/`。目标平台的运行时必须在对应平台和架构上准备，不能复用其他平台生成的 `vendor/`。

## 应用图标

[`assets/app-icon.png`](assets/app-icon.png) 是源图。在 Windows 上重新生成桌面图标：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File desktop/make-icons.ps1
node desktop/make-ico.mjs
```

脚本将 PNG 和 ICO 图标写入 `desktop/icons/`，并将前端使用的 PNG 写入 `desktop/frontend/public/`。
