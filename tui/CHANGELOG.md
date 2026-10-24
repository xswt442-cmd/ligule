# 更新记录 / Changelog

本文件只记录 CLI/npm 产品中面向使用者的重要变化。桌面安装包和应用变化单独记录在 `desktop/CHANGELOG.md`。

This file records user-visible changes for the CLI/npm product only. Desktop installer and application changes are recorded separately in `desktop/CHANGELOG.md`.

## [Unreleased]

### 简体中文

**新增**

- 长对话中模型获得 `compact` 工具：可查看上下文压力与压缩块、读回被压缩的原文和溢出文件，并自行选择范围撰写摘要完成压缩。达到软阈值时注入一次临时提醒引导，硬阈值仍由自动压缩兜底。
- `/mcp add <名称> <程序> [参数…]` 与 `/mcp remove <名称>` 把 MCP Server 写入使用者默认配置（环境变量引用与工作目录在配置文件中补充，配置变更后需重新信任）。
- `/extensions [on|off <名称>]` 列出用户扩展并支持停用与启用，登记在下次启动 Host 时生效。
- 在用户数据根 `tools/` 目录放置 TOML 文件即可声明命令工具：占位符整位替换模型参数、不进入 shell 语法，执行沿用 Shell 的权限与审批链路；工具需在模式中列出才会提供给模型。

**改进**

- 压缩结果保存为逐块校验的块序列，多次压缩各自成块、互不覆盖；分支会携带已压缩块，摘要不再丢失。
- 压缩压力阈值预留输出预算（上限为窗口的四分之一），长输出请求更早压缩；每次压缩的原因（手动、自动、超限恢复、模型主动）写入会话记录。
- 会话列表使用可重建的目录索引缓存，未变化的记录不再每次完整解析，长会话目录下列表与恢复浏览明显变快。
- 扩展安装目录支持一目录一包（含 `index.js` 入口）；已安装扩展可停用并登记在数据根，下次启动生效，配置层显式声明的路径不受影响。

**兼容性**

- 工作区信任记录改存数据根的 `trust.json`：旧版 `tui-trust.json` 仍自动读取并在下次写入时合并进新文件，旧文件保留不删除。

**修复**

- 模型请求的凭据绑定用户或命令行声明的服务地址与接口，项目覆盖地址或密钥引用时拒绝发送；对话、压缩和内部子代理沿用同一轮次的绑定快照。
- 自定义搜索后端仅由用户配置或命令行选择，项目配置不能借只读搜索启动指定程序；受管理回收目录拒绝越界路径与指向文件边界外的链接。
- MCP 工具保留服务器配置身份，身份限定的参数规则和审批记忆按实际登记路径生效。
- 并发创建同名文件时仅一个请求成功，其他请求保留已有内容并返回冲突；搜索流式输出完整保留中文与多字节字符。
- 会话恢复与模型请求校验按记录顺序配对工具调用和结果，复用调用 ID 的新轮次仍会识别未完成调用并记录未知结果。

### English

**Added**

- In long conversations the model gains the `compact` tool: it can inspect context pressure and compaction blocks, read back the summarized originals and overflow files, and compact a chosen range with a summary it writes itself. A one-time reminder appears at the soft threshold; the hard threshold still compacts automatically.
- `/mcp add <name> <executable> [args…]` and `/mcp remove <name>` write MCP servers into the user defaults (add environment references and a working directory in the config file; a changed configuration needs trust again).
- `/extensions [on|off <name>]` lists user extensions and disables or enables them; the registry takes effect the next time the Host starts.
- Declaring a command tool takes a TOML file in the data root's `tools/` directory: placeholders replace whole argument entries so model input never enters shell syntax, and execution follows the Shell permission and approval chain; a tool reaches the model only when a mode lists it.

**Improved**

- Compaction is stored as individually validated blocks, so successive passes form separate blocks instead of overwriting one summary, and branches carry their blocks instead of losing the summaries.
- The compaction threshold reserves the output budget (capped at a quarter of the window), so long-output requests compact earlier; every compaction records its reason (manual, automatic, overflow recovery, or model-initiated) in the session record.
- Session listing uses a rebuildable directory index, so unchanged records are no longer fully re-parsed on every list, making listing and resume browsing faster for long session directories.
- The extension install directory supports one-directory packages with an `index.js` entry; installed extensions can be disabled through a registry in the data root that takes effect on the next start, while paths declared by configuration layers stay unaffected.

**Compatibility**

- The workspace trust record now lives in `trust.json` under the data root. The earlier `tui-trust.json` is still read and merged into the new file on the next write; the old file is kept untouched.

**Fixed**

- Model requests bind credentials to the service URL and API declared by the user or command-line flags. Project overrides of the URL or key reference cannot send existing credentials; conversation, compaction, and internal subagents share the turn's binding snapshot.
- Custom search backends can only be selected through user configuration or command-line flags; project configuration cannot launch its own program through read-only search. Managed trash rejects paths and links outside the workspace boundary.
- Registered MCP tools retain their server configuration identity so identity-bound argument rules and approval memory apply correctly.
- Concurrent file creation has one winner and reports conflicts without overwriting content. Streaming search output preserves Chinese and other multibyte characters.
- Recovery and model-request validation pair tool calls with results in record order. A later turn reusing a call ID still detects its pending call and records an unknown outcome.

## [0.0.8] - 2026-10-23

### 简体中文

**修复**

- CLI 安装包仅内置私有 Core 的代码与资源，外部运行依赖由 npm 为当前系统安装，确保同一发行包在 Windows 和 Linux 加载对应的搜索与原生绑定。

### English

**Fixed**

- The CLI tarball bundles the private Core code and resources, while npm installs external runtime dependencies for the consumer's system. The same release artifact loads the matching search backend and native bindings on Windows and Linux.

## [0.0.7] - 2026-10-23

### 简体中文

**改进**

- 终端界面输入 `/` 即可浏览全部命令，按名称或说明筛选并滚动选择；固定命令参数支持 Tab 补全，补全仅修改草稿，权限升级仍需确认。
- `/sessions` 和不带参数的 `/resume` 支持按名称、编号或工具模式筛选；列表优先显示会话名称，筛选文字与聊天草稿分别管理。
- 欢迎区改为左对齐；运行阶段使用 Host 确认的状态，输入区限制显示高度。选择菜单、会话列表、历史和审批面板打开时让普通编辑区让位；工具调用先显示目标摘要，完整内容可从 Ctrl+O 查看。颜色使用继承终端调色板的 ANSI 角色，空间不足时禁用审批操作。
- `/queue list` 可查看待发送消息及队列状态。
- 长问题与选项可分页阅读，回答输入区保持可见；审批和历史详情中的粘贴不会修改隐藏草稿。

**修复**

- Delete 向前删除完整字符，Backspace 向后删除；多行输入的上下移动按显示列定位，避免拆开中文、组合字符和表情。
- 会话切换在目标会话成功打开后才释放原会话锁；切换失败时继续保留当前会话。
- 草稿和外部编辑器内容中的 CRLF 在编辑前统一为 LF，避免光标移动或删除时留下孤立的回车符。
- 未设置 `FORCE_COLOR` 时，终端启动遵守非空的 `NO_COLOR`；窄窗口保留当前会话状态提示。
- 工具审批和提问会临时收起授权设置向导；问题回答只发送给当前问题，不会被用作授权参数。
- 问题回答独立于普通草稿，回答或取消后恢复原文字和光标；退出时保存普通草稿与队列，问题期间收回队列也保留原输入。

### English

**Improved**

- Typing `/` in the terminal UI browses all commands with name or description filtering and scrollable selection. Fixed command arguments support Tab completion, which only edits the draft; permission upgrades still require confirmation.
- `/sessions` and `/resume` without arguments filter by session name, ID, or tool mode. Names appear first, and search text stays separate from the chat draft.
- The welcome area is left-aligned; run phases use Host-confirmed status, and the composer has a bounded display height. Selection menus, session lists, history, and approvals take the place of ordinary editing while open. Tool calls lead with a target summary, with full details available through Ctrl+O. ANSI color roles follow the terminal palette, and approvals are disabled when the window cannot show the required information.
- `/queue list` shows pending messages and queue status.
- Long questions and options can be paged while the answer editor stays visible; pasting in approvals or transcript details preserves the hidden draft.

**Fixed**

- Delete removes the next whole character and Backspace the previous one. Vertical movement in multiline drafts follows display columns without splitting Chinese text, combining characters, or emoji.
- Session navigation releases the previous session lock only after the target opens successfully; a failed switch keeps the current session active.
- CRLF in saved drafts and external-editor content is normalized to LF before editing, so movement and deletion do not leave a stray carriage return.
- Terminal startup honors a nonempty `NO_COLOR` when `FORCE_COLOR` is unset, and narrow windows retain the active-session status hint.
- Tool approvals and questions temporarily hide grant setup; question answers go only to the active question and cannot become grant parameters.
- Answers use a separate draft. Answering or cancelling restores the original text and caret; exit saves the ordinary draft and queue, and queue recovery during a question preserves existing input.

## [0.0.6] - 2026-10-22

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
- 子代理只能使用父会话当前可见的工具；显式子 Mode 不能恢复父 Mode 隐藏或 Permission 不可用的工具。

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
- Subagents are limited to tools visible to the parent session; an explicit child Mode cannot restore tools hidden by the parent Mode or unavailable under its Permission.

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
