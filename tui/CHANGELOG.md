# 更新记录 / Changelog

本文件只记录 CLI/npm 产品中面向使用者的重要变化。桌面安装包和应用变化单独记录在 `desktop/CHANGELOG.md`。

This file records user-visible changes for the CLI/npm product only. Desktop installer and application changes are recorded separately in `desktop/CHANGELOG.md`.

## [Unreleased]

### 简体中文

**新增**

- 默认 `minimal` 模式增加 `managed_process`，可在同一 Session 中启动受 Guardian 管理的本地开发服务器，查看就绪状态、端口与有界日志，并显式停止进程；启动命令沿用 `exec` 的 Permission、Policy、工作区信任与脚本审批。
- `full` 工具模式包含内部 `subagent`，可并行委派最多三个独立子任务；子任务保留独立会话记录，可用 `/sub <序号>` 检查。MCP `ligule_run` 与 `ligule_run_start` 也支持单轮模式收窄和经 schema 验证的结构化结果。
- 本地 MCP 控制新增 `ligule_run` 的有界等待和 `ligule_run_await`，超时不会取消仍在运行的任务。
- 增加 `/mcp list|trust|confirm|revoke|tools` 管理本地 MCP Server 信任；信任可按会话、项目或用户范围设置，服务器配置变化后需要重新确认。

**改进**

- 审批方式明确区分 `ask`、`auto`、`none` 与旧版 `never`；记住的许可可限定本次、会话、项目或用户，文件许可默认只记当前文件。
- 大型审批先显示字节数、摘要和短预览，再由可信界面按需展开详情；系统拒绝、审批不可用和取消不再记作用户拒绝。

**安全**

- 撤销工作区信任会停止基于该信任启动的受管进程；其他 Host 会复核共享信任状态并停止相关进程。

### English

**Added**

- Added `managed_process` to the default `minimal` mode. It starts local development servers under Guardian ownership, reports readiness and port, provides bounded logs, and supports explicit stop within the same Session. Start commands keep `exec` Permission, Policy, workspace trust, and script approval checks.
- The `full` tool mode includes the internal `subagent` tool for up to three concurrent independent child runs; each child keeps a separate Session record that can be inspected with `/sub <seq>`. MCP `ligule_run` and `ligule_run_start` also accept per-run mode narrowing and schema-validated structured results.
- Added bounded waiting with `ligule_run` and `ligule_run_await` to the local MCP control tools. A wait timeout does not cancel the active run.
- Added `/mcp list|trust|confirm|revoke|tools` to manage local MCP server trust by session, project, or user scope. Server configuration changes require trust again.

**Improved**

- Approval modes now distinguish `ask`, `auto`, `none`, and legacy `never`. Remembered approvals can be scoped to one call, a session, a project, or the user; file approvals default to the selected file.
- Large approvals show a byte count, digest, and short preview before trusted interfaces retrieve details on demand. System refusals, unavailable approval channels, and cancellation are no longer recorded as user refusals.

**Security**

- Revoking workspace trust stops managed processes started from that trust; other Hosts recheck the shared trust state and stop affected processes.

## [0.0.5] - 2026-10-19

### 简体中文

**新增**

- 增加会话 Permission 控制，可查看平台隔离能力并单独更改文件/命令档位与网络模式；启用 `full-access` 或不受限网络需要确认，Sandbox 能力不足时 Shell 会拒绝执行。
- 增加 `ligule mcp-server --project <绝对目录>` 本地 stdio MCP 入口，支持会话管理、任务运行与取消、状态查询和记录分页。显式启用 `--operator` 后可修改受支持的会话设置，并答复真实待决的审批或提问；operation ID 和消息队列仅在当前进程内有效。
- 增加 `model.outputTokens` 请求预算与双 API 非流式 JSON 响应支持；模型设置在完整配置校验通过后才保存，拒绝时保留文件原文并保护其他项目的启动。

**改进**

- `/control list` 显示授权来源；旧记录没有来源时明确标注未记录，不推断创建渠道。
- 权限变更记录只会在本次操作实际启用完全访问或不受限网络时标记对应确认。
- 共享模型服务配置支持逐模型上下文窗口和输出额度，按当前选择应用于请求与压缩，兼容原有模型标识列表。
- 完整校验模型终止原因，区分空回复、输出耗尽、协议不完整及断流；非法工具批次不执行副作用，诊断不包含原始参数或网关错误正文。
- 危险操作分类和自动审批统一使用解析后的 Bash 命令名；引号与字面片段拼接不能绕过硬拒绝或解释器审批。
- Bash 危险命令检查会解码未加引号的转义和可识别的 ANSI-C 字符串；不完整或不支持的转义仍需逐次审批。
- Node/Python 脚本审批显示规范路径、SHA-256、解释器、工作区和 Permission；审批等待期间这些内容发生变化会拒绝执行，无法安全绑定的脚本形式也会拒绝运行。
- Permission 变更会保留当前会话的 Policy 覆盖和拒绝状态，并在重新打开会话时恢复；旧格式会话仍可读取，但拒绝写入其不支持的设置事件。
- TUI 显示 Host 确认的运行阶段与无进展时长，并提供可操作的 Provider 错误提示。

### English

**Added**

- Added per-session Permission controls to inspect platform isolation capabilities and change file/command profiles separately from network mode. Enabling `full-access` or unrestricted networking requires confirmation; Shell is denied when sandbox capabilities are insufficient.
- Added `ligule mcp-server --project <absolute-directory>` for local stdio MCP control: manage sessions, run and cancel tasks, query status, and page through records. Explicit `--operator` mode can change supported session settings and answer real pending approvals or questions; operation IDs and the message queue are process-local.
- Added the `model.outputTokens` request budget and non-streaming JSON responses for both APIs. Model settings are saved only after complete configuration validation; rejected edits preserve file contents and other projects' startup behavior.

**Improved**

- `/control list` shows grant origin; legacy grants with no recorded origin are labeled as unknown instead of inferred.
- Permission records mark a confirmation only when that change grants full access or unrestricted networking.
- Shared service configuration supports per-model context windows and output budgets for requests and compaction, while preserving existing model ID lists.
- Validate model finish reasons and distinguish empty replies, exhausted output, incomplete protocols, and interrupted bodies. Invalid tool batches have no side effects, and diagnostics omit raw arguments and gateway error bodies.
- Dangerous-operation checks and automatic approval use the same parsed Bash executable name, so quoting or literal concatenation cannot bypass hard denials or interpreter approval.
- Bash dangerous-command checks decode unquoted escapes and recognized ANSI-C strings; incomplete or unsupported escapes remain approval-gated.
- Node/Python script approvals show the canonical path, SHA-256, interpreter, workspace, and Permission. Changes while approval is pending refuse execution, and script forms that cannot be safely bound are refused.
- Permission changes preserve the current session's Policy override and denial state across reopen. Legacy session records remain readable but refuse unsupported setting events.
- TUI status shows Host-confirmed run phases and time without progress, with actionable Provider error messages.

## [0.0.4] - 2026-10-14

### 简体中文

#### 终端界面与工作区

- 改进 TUI 的工作区信任提示与访问边界处理，让在项目目录中进行文件和命令操作时的授权决策更清楚。
- 优化会话控制与状态反馈，便于在终端中继续对话、取消操作和恢复已有会话；会话数据仍由共享 Host 维护。

#### 稳定性与使用方式

- 完善启动失败时的提示与排查信息，帮助识别工作区、终端环境或模型配置相关的问题。
- CLI 与 TUI 仍通过同一个 npm 包分发：在交互式终端运行 `ligule` 打开 TUI，单轮任务使用 `ligule run "任务内容"`；继续沿用现有的工具审批和会话恢复能力。

### English

#### Terminal UI and workspaces

- Improved workspace trust prompts and access-boundary handling in the TUI, making authorization decisions clearer before filesystem and command operations in a project.
- Refined session controls and status feedback for continuing conversations, cancelling operations, and resuming sessions; the shared Host continues to own session data.

#### Reliability and usage

- Improved startup failure messages and troubleshooting guidance for issues involving the workspace, terminal environment, or model configuration.
- CLI and TUI remain part of the same npm package: run `ligule` in an interactive terminal for the TUI or `ligule run "task"` for one-off requests. Existing tool approval and session recovery capabilities remain available.

## [0.0.3] - 2026-10-12

### 简体中文

#### 新增

- 新增共享 Agent 内核的命令行、终端界面和桌面界面，并提供工具、插件、技能与扩展入口。
- 新增按工作区归属的会话、已完成轮次分支、Markdown 导出、消息队列、输入恢复、检查点压缩和中断恢复。
- 桌面版新增多模型服务设置、系统凭据、待审批和待回答提醒、托盘与通知设置。
- CI 新增 Windows x64、Linux x64、macOS arm64 和 macOS x64 桌面安装包构建。

#### 变更

- 在交互式终端直接运行 `ligule` 会打开终端界面；单轮命令使用 `ligule run`。
- 会话记录默认保存在 `~/.ligule`，并支持使用 `LIGULE_HOME` 指定数据根。

#### 修复

- 取消工具调用时会终止其拥有的进程树；会话锁阻止多个进程同时写入同一记录。
- 恢复时不会重放没有记录结果的工具调用，并会将结果标记为未知。

### English

#### Added

- Added CLI, TUI, and desktop interfaces over one Agent kernel, with tools, plugins, skills, and extensions.
- Added workspace-owned sessions, branches from completed turns, Markdown export, message queues, input recovery, checkpoint compaction, and interrupted-turn recovery.
- Added desktop settings for multiple model services and system credentials, plus approval, question, tray, and notification controls.
- Added CI builds for Windows x64, Linux x64, macOS arm64, and macOS x64 desktop installers.

#### Changed

- Running `ligule` in an interactive terminal opens the TUI; use `ligule run` for a single request.
- Session records default to `~/.ligule`; set `LIGULE_HOME` to choose another data root.

#### Fixed

- Cancelling a tool call terminates its owned process tree; session locks prevent concurrent writers to one record.
- Recovery does not replay tool calls without recorded results and marks their outcomes as unknown.

## [0.0.1] - 2026-09-29

### 简体中文

初始公开版本。完整记录见 [v0.0.1 GitHub Release](https://github.com/xswt442-cmd/ligule/releases/tag/v0.0.1)。

### English

Initial public release. See the [v0.0.1 GitHub Release](https://github.com/xswt442-cmd/ligule/releases/tag/v0.0.1) for its published record.
