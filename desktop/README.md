# 桌面端开发说明

[简体中文](README.md) · [English](README.en.md)

桌面应用由 `frontend/` 中的 React 与 TypeScript 前端、`src-tauri/` 中的 Rust 与 Tauri 壳，以及 Node Host 组成。前端通过 Tauri 调用 Host 协议；Rust 壳管理窗口并转发按行分隔的消息帧。业务逻辑和会话状态由 Node 管理。完整调用路径见[架构说明](../docs/development/ARCHITECTURE.zh-cn.md)。

## 环境要求

需要 Node.js 24 或更新版本和稳定版 Rust 工具链。Windows 构建需要 WebView2；Linux 构建需要 [CI 工作流](../.github/workflows/ci.yml)列出的 Tauri 系统库。macOS 使用对应架构的原生 runner。支持的安装目标及验收状态见[发行清单](../docs/development/RELEASE.zh-cn.md)。

从仓库根目录安装各个依赖树：

```sh
npm ci
npm --prefix desktop ci
npm --prefix desktop/frontend ci
```

## 启动开发环境

同时启动 Vite 前端和 Tauri 壳：

```sh
npm --prefix desktop run dev
```

壳会启动 Node Host。桌面窗口中的前端使用 Tauri 传输；`dev/` 页面也可以连接本地假 Host，单独检查界面。

## 检查前端

运行前端断言和生产构建：

```sh
npm --prefix desktop/frontend run check
npm --prefix desktop/frontend run build
```

## 检查 Rust 壳

从仓库根目录运行：

```sh
cd desktop/src-tauri
cargo fmt --check
cargo test
```

前端构建会先运行 TypeScript 检查，再由 Vite 打包。Rust 测试覆盖进程入口解析、按行转发消息帧、Host 替换、托盘和通知输入规则。CI 在各自的平台 runner 上构建安装包；这些构建产物用于验证，只有正式发布后才是公开安装包。

## 构建安装包

按顺序完成以下步骤：

1. 构建核心包与平台搜索包：

   ```sh
   npm run build
   npm run build-rg
   ```

2. 在目标平台准备 Node 运行时目录：

   ```sh
   node desktop/fetch-runtime.mjs
   ```

3. 构建桌面安装包：

   ```sh
   npm --prefix desktop run build
   ```

`fetch-runtime.mjs` 会下载 [`node-pin.json`](node-pin.json) 指定的 Node 归档、验证校验和，并将构建产物和生产依赖复制到 `desktop/vendor/`。运行时目录与平台相关，不要在不同操作系统或架构之间复用。Tauri 会将其打入安装包。目标平台的安装包格式由 `tauri.*.conf.json` 指定。

输出位置和安装包格式见[发行清单](../docs/development/RELEASE.zh-cn.md)。如需在打包前检查随包运行时，可使用当前平台 `desktop/vendor/node/` 下的 Node 执行 `desktop/check-runtime.mjs`。

## 应用图标

[`assets/app-icon.png`](assets/app-icon.png) 是源图。在 Windows 上，运行以下命令重新生成前端与 Tauri 图标：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File desktop/make-icons.ps1
node desktop/make-ico.mjs
```

脚本将生成文件写入 `desktop/frontend/public/` 和 `desktop/src-tauri/icons/`。提交前检查生成结果。
