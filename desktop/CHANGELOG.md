# 桌面版更新记录 / Desktop Changelog

此文件只记录 Ligule Desktop 的安装包与桌面应用变化。CLI 更新单独记录在仓库根目录的 `CHANGELOG.md`。

This file records Ligule Desktop installer and application changes only. CLI updates are tracked separately in the repository root `CHANGELOG.md`.

## [Unreleased]

### 简体中文

### English

## [0.0.4] - 2026-10-14

### 简体中文

#### 桌面架构

- Desktop 从 Tauri 迁移到 Electron，通过 React 前端、Electron Main/Preload 和独立 Node Host 连接共享 Agent 内核；会话状态与工具权限仍由 Host 管理。
- 安装包内置对应平台的 Node 运行时与 Host 依赖，安装后不需要用户另外安装 Node.js、npm 或 pnpm。

#### 工作区、审批与可靠性

- 新增工作区选择与默认工作区设置，支持在不同项目间切换，同时维持工作区和会话的归属关系。
- 提供桌面端审批设置与交互反馈；文件和命令操作继续遵循共享 Host 的权限规则。
- 改进跨会话导出及保存操作，处理文件对话框取消、目标覆盖与过期会话响应等情况，降低作用到错误文件或会话的风险。
- 加强 Electron Main/Preload 与 Host 间的输入校验及退出清理；Renderer 不直接获得任意 Node、文件系统或命令执行能力。

#### 发行平台

- 提供 **Windows x64 NSIS 安装程序**、**Linux x64 AppImage 和 deb**。macOS arm64/x64 尚未纳入正式发行，没有 DMG 下载。

### English

#### Desktop architecture

- Migrated Desktop from Tauri to Electron, connecting the React UI, Electron Main/Preload, and an isolated Node Host to the shared Agent kernel. Session state and tool permissions remain owned by the Host.
- Bundled the platform-matched Node runtime and Host dependencies, so users do not need to install Node.js, npm, or pnpm separately to run the installed app.

#### Workspaces, approvals, and reliability

- Added workspace selection and default-workspace settings for switching projects while preserving correct workspace/session ownership.
- Added Desktop approval settings and interaction feedback. Filesystem and command operations continue to follow shared Host policy.
- Improved export and save operations across session changes, handling cancelled file dialogs, overwrite decisions, and stale session responses to reduce the risk of acting on the wrong session or file.
- Strengthened input validation and shutdown cleanup between Electron Main/Preload and Host; the renderer has no unrestricted Node, filesystem, or command execution access.

#### Release platforms

- Ships a **Windows x64 NSIS installer**, **Linux x64 AppImage and deb** packages. macOS arm64/x64 is not a supported release target yet; no DMG is provided.
