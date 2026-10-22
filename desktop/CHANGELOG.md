# 桌面版更新记录 / Desktop Changelog

此文件只记录 Ligule Desktop 的安装包与桌面应用变化。CLI/TUI 更新单独记录在 `tui/CHANGELOG.md`。

This file records Ligule Desktop installer and application changes only. CLI/TUI updates are tracked separately in `tui/CHANGELOG.md`.

## [Unreleased]

### 简体中文

### English

## [0.0.7] - 2026-10-22

### 简体中文

**新增**

- 默认 `minimal` 模式增加 `managed_process`，可在同一 Session 中启动受 Guardian 管理的本地开发服务器，查看就绪状态、端口与有界日志，并显式停止进程；启动命令沿用 `exec` 的 Permission、Policy、工作区信任与脚本审批。
- 增加外控会话输入栏，可查看当前会话的模型、工具模式、Policy、Permission 与 Grant 上限，并向同一 Host Session 发送消息；会话菜单可查看内部子代理记录。
- 增加 MCP 信任设置面板，可查看本机 Server 启动详情、按会话/项目/用户范围信任或撤销；信任仅允许启动进程，工具调用仍逐次经过 Policy。

**改进**

- 审批卡对大型参数先显示字节数、摘要和短预览，可信界面可在待决期间按需展开详情。审批记忆支持本次、会话、项目和用户范围；文件许可默认限定在当前文件。
- Policy 使用 `ask`、`auto`、`none` 三档，旧版 `never` 保持拒绝语义。硬拒绝、审批不可用与取消保持各自结果，不显示为用户拒绝。
- 设置重组为八个独立入口，常规页整合外观设置；工具模式和 Grant 选择只用于查看，不会改变运行中的会话。权限、MCP Server 和 Grant 的低频细节按需展开，保留原有创建、信任、审批和撤销操作。
- MCP 信任面板读取 Server 工具清单设有有界超时；无响应的 Server 不会无限期占用临时连接。

**安全**

- 撤销工作区信任会停止基于该信任启动的受管进程；其他 Host 定期检查共享信任状态。
- 子代理只能使用父会话当前可见的工具；显式子 Mode 不能恢复父 Mode 隐藏或 Permission 不可用的工具。

### English

**Added**

- Added `managed_process` to the default `minimal` mode. It starts local development servers under Guardian ownership, reports readiness and port, provides bounded logs, and supports explicit stop within the same Session. Start commands keep `exec` Permission, Policy, workspace trust, and script approval checks.
- Added an external-session composer that shows the active session's model, tool mode, Policy, Permission, and Grant ceilings, and routes messages to the same Host Session. The conversation menu also exposes internal subagent records.
- Added MCP trust settings to inspect local server launch details and trust or revoke servers at session, project, or user scope. Trust permits process startup only; every tool call still passes through Policy.

**Improved**

- Approval cards show a byte count, digest, and short preview for large parameters; trusted interfaces can retrieve full details while the request is pending. Remembered approvals support one-call, session, project, and user scopes; file approvals default to the selected file.
- Policy now distinguishes `ask`, `auto`, and `none`, while legacy `never` retains its refusal behavior. Hard denials, unavailable approval channels, and cancellation keep distinct outcomes instead of appearing as user refusals.
- Settings now has eight separate sections, with appearance controls in General. Mode and Grant selections only change what is inspected; they do not change a running session. Less-frequent Permission, MCP server, and Grant details expand on demand while existing create, trust, approval, and revoke actions remain available.
- MCP server tool discovery in the trust panel has a bounded timeout, so an unresponsive server cannot hold a temporary connection indefinitely.

**Security**

- Revoking workspace trust stops managed processes started from that trust; other Hosts periodically check the shared trust state.
- Subagents are limited to tools visible to the parent session; an explicit child Mode cannot restore tools hidden by the parent Mode or unavailable under its Permission.

## [0.0.6] - 2026-10-19

### 简体中文

**新增**

- 新会话发送第一条消息前可设置工具模式、审批方式、文件/命令权限与网络模式；完全访问和不受限网络仍需分别确认，并由 Host 记录确认来源。
- 增加会话 Permission 控制面板，可查看平台隔离能力并单独更改文件/命令档位与网络模式；启用 `full-access` 或不受限网络需要确认，Sandbox 能力不足时 Shell 会拒绝执行。
- 模型服务提供可编辑的模型目录表，支持逐模型名称、上下文窗口和最大输出 token 数；获取可用列表后可选择要加入的模型，并保留已有模型的手动参数，设置实际用于选中模型的请求与压缩。

**改进**

- 安装包中的 Node 运行树只包含产品清单和生产依赖；构建与运行资源检查会拒绝源码、测试材料和嵌套部署目录。
- 当文件权限边界与项目目录不同时，会话归属、项目设置与重启恢复仍使用实际项目目录。
- 状态栏显示 Host 确认的运行阶段与无进展时长；长标题保留状态和操作按钮的显示空间。
- 共享 Core 区分正常完成、空回复、输出耗尽及断流，安全拒绝非法工具批次，并支持显式输出预算和双 API 非流式 JSON 响应。
- 模型配置在写入前验证共享默认层、项目有效配置和会话显式选择，拒绝时保持文件原文；构建与运行树校验拒绝过时的 Core 内容和越界链接。
- 危险操作分类和自动审批统一使用解析后的 Bash 命令名；引号与字面片段拼接不能绕过硬拒绝或解释器审批。
- Bash 危险命令检查会解码未加引号的转义和可识别的 ANSI-C 字符串；不完整或不支持的转义仍需逐次审批。
- Node/Python 脚本审批卡显示规范路径、SHA-256、解释器、工作区和 Permission；审批等待期间这些内容发生变化会拒绝执行，无法安全绑定的脚本形式也会拒绝运行。

**修复**

- 修复没有选中会话时重连后断连横幅残留；Linux deb 增加 GBM 和 ALSA 运行依赖声明。
- 授权详情显示可信界面来源；旧授权未记录来源时明确标记，不追认为可信界面创建。
- Permission 变更会保留当前会话的 Policy 覆盖和拒绝状态，并在重新打开会话时恢复；旧格式会话仍可读取，但拒绝写入其不支持的设置事件。

### English

**Added**

- New conversations can select a tool mode, approval mode, file/command permission profile, and network mode before the first message. Full access and unrestricted networking still require separate confirmations, which the Host records with their source.
- Added a per-session Permission panel to inspect platform isolation capabilities and change file/command profiles separately from network mode. Enabling `full-access` or unrestricted networking requires confirmation; Shell is denied when sandbox capabilities are insufficient.
- Added editable model catalogs with per-model display names, context windows, and maximum output tokens. Fetching shows the available models for selection and preserves existing manual settings; the selected model's limits control actual requests and compaction.

**Improved**

- Restricted the packaged Node runtime tree to its product manifest and production dependencies; build and runtime-resource checks reject source files, test material, and nested deployment directories.
- Session ownership, project settings, and restart recovery use the actual project directory when it differs from the filesystem permission boundary.
- Status shows Host-confirmed run phases and time without progress; long titles retain space for status and action buttons.
- Shared Core distinguishes normal completion, empty replies, exhausted output, and interrupted bodies, safely rejects invalid tool batches, and supports explicit output budgets and non-streaming JSON responses for both APIs.
- Model configuration validates shared defaults, effective project settings, and explicit session selections before writing; rejected edits preserve the file. Build and runtime-tree checks reject stale Core content and links escaping the runtime.
- Dangerous-operation checks and automatic approval use the same parsed Bash executable name, so quoting or literal concatenation cannot bypass hard denials or interpreter approval.
- Bash dangerous-command checks decode unquoted escapes and recognized ANSI-C strings; incomplete or unsupported escapes remain approval-gated.
- Node/Python script approval cards show the canonical path, SHA-256, interpreter, workspace, and Permission. Changes while approval is pending refuse execution, and script forms that cannot be safely bound are refused.

**Fixed**

- Fixed the disconnected banner remaining after reconnecting without a selected session; the Linux deb now declares GBM and ALSA runtime dependencies.
- Grant details identify grants created through the trusted UI and label legacy grants whose origin was never recorded.
- Permission changes preserve the current session's Policy override and denial state across reopen. Legacy session records remain readable but refuse unsupported setting events.

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

- 提供 **Windows x64 NSIS 安装程序**、**Linux x64 AppImage 和 deb**。

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

- Ships a **Windows x64 NSIS installer** and **Linux x64 AppImage and deb** packages.
