# 桌面版更新记录 / Desktop Changelog

此文件只记录 Ligule Desktop 的安装包与桌面应用变化。CLI/TUI 更新单独记录在 `tui/CHANGELOG.md`。

This file records Ligule Desktop installer and application changes only. CLI/TUI updates are tracked separately in `tui/CHANGELOG.md`.

## [Unreleased]

### 简体中文

- 模型服务提供可编辑的模型目录表，支持逐模型名称、上下文窗口和最大输出 token 数；一键获取列表并保留手动参数，设置实际用于选中模型的请求与压缩。

- 安装包中的 Node 运行树只包含产品清单和生产依赖；构建与运行资源检查会拒绝源码、测试材料和嵌套部署目录。
- 当文件权限边界与项目目录不同时，会话归属、项目设置与重启恢复仍使用实际项目目录。
- 状态栏显示 Host 确认的运行阶段与无进展时长；长标题保留状态和操作按钮的显示空间。
- 共享 Core 区分正常完成、空回复、输出耗尽及断流，安全拒绝非法工具批次，并支持显式输出预算和双 API 非流式 JSON 响应。
- 模型配置在写入前验证共享默认层、项目有效配置和会话显式选择，拒绝时保持文件原文；构建与运行树校验拒绝过时的 Core 内容和越界链接。
- 修复没有选中会话时重连后断连横幅残留；Linux deb 增加 GBM 和 ALSA 运行依赖声明。

### English

- Added editable model catalogs with per-model display names, context windows, and maximum output tokens. Fetching adds models while preserving manual settings; the selected model's limits control actual requests and compaction.

- Restricted the packaged Node runtime tree to its product manifest and production dependencies; build and runtime-resource checks reject source files, test material, and nested deployment directories.
- Session ownership, project settings, and restart recovery use the actual project directory when it differs from the filesystem permission boundary.
- Status shows Host-confirmed run phases and time without progress; long titles retain space for status and action buttons.
- Shared Core distinguishes normal completion, empty replies, exhausted output, and interrupted bodies, safely rejects invalid tool batches, and supports explicit output budgets and non-streaming JSON responses for both APIs.
- Model configuration validates shared defaults, effective project settings, and explicit session selections before writing; rejected edits preserve the file. Build and runtime-tree checks reject stale Core content and links escaping the runtime.
- Fixed the disconnected banner remaining after reconnecting without a selected session; the Linux deb now declares GBM and ALSA runtime dependencies.

## [0.0.5] - 2026-10-15

### 简体中文

- 改善桌面侧栏搜索焦点、工作区分组和停止本轮操作的可见性；支持折叠其他会话。
- 添加 DeepSeek、OpenAI 与 Anthropic 服务预设，以及 OpenAI 兼容服务的模型发现和多选；凭据使用系统凭据库或环境变量引用。
- 增加需明确确认的「完全不需审批」档位；工作区边界、拒绝规则和安全守卫仍然生效。
- 外观设置增加独立的界面、用户消息和模型回复 px 字号，以及可调会话行距；审批设置内容支持键盘和滚轮滚动。

### English

- Improved desktop search focus, workspace grouping, and stop-turn visibility; the Other conversations group can be collapsed.
- Added DeepSeek, OpenAI, and Anthropic service presets plus model discovery and multi-select for OpenAI-compatible endpoints; credentials use the OS credential store or environment-variable references.
- Added a no-approval tier that requires explicit confirmation; workspace boundaries, deny rules, and safety guards remain active.
- Added independent px controls for interface, user-message, and assistant-message fonts, adjustable transcript line spacing, and keyboard/scroll-wheel access to approval settings.

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
