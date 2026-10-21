# 架构说明

[简体中文](ARCHITECTURE.zh-cn.md) · [English](ARCHITECTURE.en.md)

本文根据当前源码说明 ligule 的运行结构、一次 Agent Loop 和会话数据路径。工作区有三个源码模块：`core/` 是共享 Agent Core，`tui/` 是 CLI/TUI 产品，`desktop/` 是 Electron 产品。依赖方向为 `tui → core ← desktop`；Core 内部继续区分 Kernel、Host、Session、Model、Policy 与 Tools。产品分别通过 npm `ligule` 和 GitHub Release 发布，Core 不单独发版。

本文面向阅读或修改仓库的贡献者，说明组件职责、依赖方向、一次请求的执行路径和会话恢复。协议字段与模块细节以链接到的源码为准。

## 运行时与执行

- [运行结构](#运行结构)
- [Kernel、插件、工具与能力](#kernel插件工具与能力)
- [一次 Agent Loop](#一次-agent-loop)

## 会话数据与恢复

- [会话记录与恢复](#会话记录与恢复)
- [会话数据路径](#会话数据路径)

## Host 与客户端

- [Host 协议与客户端](#host-协议与客户端)
- [相关文档](#相关文档)

### 运行结构

```mermaid
flowchart LR
  CLI[命令行] -->|进程内调用| Host[Node Host]
  TUI[React 与 Ink] -->|内存协议| Host
  External[本地 MCP 客户端] -->|stdio MCP| MCP[MCP 适配器]
  MCP --> Control[进程内控制门面]
  Control --> Host
  Web[React 桌面界面] <-->|沙盒 Preload 与 IPC| Main[Electron Main]
  Main <-->|按行分隔的消息帧| Child[Node Host 子进程]
  Child --> HostLogic[Host 与内核]
  Host --> Project[项目环境]
  Host --> Loop[Agent Loop]
  Host --> Session[会话 JSONL]
  Loop --> Provider[模型适配器]
  Loop --> Kernel[Kernel]
  Kernel --> Policy[审批判定链]
  Kernel --> Registry[工具注册表]
  Registry --> Tool[已注册工具]
  Tool --> Capability[平台与 I/O 能力]
  Provider --> Endpoint[模型服务]
```

`ligule run` 与直接运行 `ligule`（或使用兼容命令 `ligule tui`）会在界面所属的 Node.js 进程中创建 Host。TUI 通过内存连接发送协议消息。桌面前端只通过固定的沙盒 Preload API 与 Electron Main 通信；Main 将协议帧转发给独立 Node Host，并管理窗口、原生交互和进程生命周期。Node Host 管项目环境、会话、审批与模型请求。入口分别见[命令行](../../tui/src/cli.ts)、[TUI 启动器](../../tui/src/tui/start.ts)、[消息连接](../../core/src/host/connection.ts)、[Electron IPC](../../desktop/electron/ipc.ts)和[Preload API](../../desktop/electron/preload.ts)。

[项目环境装载模块](../../core/src/host/environment.ts) 为 CLI 与 Desktop Host 入口提供同一次读取的配置层与扩展来源。[Provider 构造模块](../../core/src/host/provider.ts) 校验模型协议、能力声明与重试设置；未配置模型的 Host 可以接收设置请求，模型运行明确失败。[会话模式事务](../../core/src/host/session-mode.ts) 负责安装工具限制、提示片段、失败回收和模式事实记录；Host 继续持有会话锁、活跃轮次、协议路由与资源清理。TUI 的记录投影位于 [transcript.ts](../../tui/src/tui/transcript.ts)，Desktop 的[流式缓冲](../../desktop/frontend/src/session-stream.ts) 按会话隔离未落盘输出。

`ligule mcp-server --project <绝对项目根>` 通过 [MCP 适配器](../../core/src/host/mcp-server.ts) 暴露本地控制工具。[控制门面](../../core/src/host/control.ts) 调用同一 Host，维护进程内 operation 状态，并将会话操作限制在启动时授权的项目内。默认模式拒绝需要审批的操作；明确启用 `--operator` 后，客户端可答复真实待决的审批与提问，并修改受支持的会话设置，但不能覆盖硬拒绝。可信 TUI/Desktop 可创建项目绑定的 [Agent Control Grant](../../core/src/host/agent-control.ts)；`--grant <id>` 将会话 Permission、网络和 Policy 限制在 Grant 的默认值与上限内，Host 会在请求时核验撤销、到期和项目绑定。连接关闭时会取消运行并释放会话锁；Session JSONL 持久保存会话记录，operation ID 和消息队列只在当前进程内有效。使用方法见 [MCP 用户指南](../mcp/mcp-guide.zh-CN.md)。

### Kernel、插件、工具与能力

Kernel 从空工具注册表开始。Host 通过[装配器](../../core/src/kernel/assembly.ts)安装插件；插件可以注册工具和提示片段，并返回清理动作。工具模式从已注册工具中选择可交给模型的项目，并选择提示片段；模式不实现工具，也不作审批决定。

工具是模型可调用的契约，包含名称、说明、JSON 参数模式和执行函数。工具实现可以调用 [`core/src/capability/`](../../core/src/capability/) 下的平台能力，例如路径检查、命令执行、网络解析或剪贴板访问。能力本身不会自动成为模型可调用工具。审批结果中的 `capability` 字段用于标记本次判定的操作。

模型提出的每个工具调用都会进入 [`kernel.call`](../../core/src/kernel/kernel.ts)。Kernel 先检查工具注册和参数，再解析声明的命令或网络目标，随后调用审批判定链。判定链按既定顺序应用限制、守卫、配置规则、自动审批条件和用户审批。只有获准的调用会进入工具实现。Kernel 会记录判定结果，以及完成、拒绝或失败的工具结果；模型清单只包含工具名称、说明和参数模式。

Host 为每个会话持有独立的 Permission 与 Policy 状态。Permission 在 Kernel 判定之前按工具的资源访问类别检查读、写、命令、网络和外部进程；Policy 随后决定是否审批或拒绝。交互式 TUI 与 Desktop 可更改会话 Permission，启用 `full-access` 和 `unrestricted` 网络分别需要确认。命令执行通过 [`permission-capabilities.ts`](../../core/src/capability/permission-capabilities.ts) 探测所选 Shell 和平台能力。Linux 使用 bubblewrap，并按实测报告文件系统隔离能力。Windows `workspace-write` 使用每次运行独立的 `WRITE_RESTRICTED` Token 和临时 ACL，标为 `partial`；需要明确授权项目、确认风险并使用不受限网络，且无法限制读取和网络。硬链接、可写祖先目录的 `FILE_DELETE_CHILD` 权限及并发 ACL 修改仍可能越界。Windows `read-only` 仅当所选 Shell 能进入实际工作区时才使用 AppContainer，否则 Kernel 预检会拒绝；可用时它会阻止工作区写入和 Shell 联网，但系统公开可读文件仍可能被读取。项目脚本与 Git 命令都需要工作区信任；每条 Git 命令还需逐次审批，因为仓库配置可能运行 Hook、辅助程序或别名。`full-access` Shell 使用当前操作系统用户权限，并要求不受限网络与进程管理能力可用。MCP `--operator` 不管理 Permission，硬拒绝也不能通过审批覆盖。

默认 `minimal` 模式还提供 `managed_process`，供开发服务器等需要跨工具调用运行的命令使用。启动命令仍按 `exec` capability 应用 Permission、Script Binding、工作区信任和 Policy；现有 `exec` 拒绝规则同样适用。启动须提供 HTTP 回环就绪地址，成功后返回 Session 内句柄、端口和就绪状态；状态与日志查询、显式停止也限定在该 Session，日志最多返回 16 KiB。普通 `exec` 仍等待命令结束并由 Guardian 清理后代。受管进程继续留在 Guardian/Job Object 进程树中，随运行取消、Permission 变更、Session/Host 关闭或所属 Grant 撤销而停止；外部撤销或过期的 Grant 会每秒重新校验。就绪地址只限制 Host 的探测目标，实际监听地址和命令的网络访问仍由启动命令与当前平台 Permission 决定。

### 一次 Agent Loop

```mermaid
sequenceDiagram
  actor User as 用户
  participant Adapter as CLI / TUI / 桌面适配器
  participant Host as Node Host
  participant Loop as Agent Loop
  participant Session as 会话记录
  participant Provider as 模型服务
  participant Kernel as Kernel 与审批链
  participant Tool as 工具与平台能力
  User->>Adapter: 提交一条消息
  Adapter->>Host: run.start
  Host->>Session: 追加用户事件与本轮设置
  Host->>Loop: 使用会话、提供方与 Kernel 运行
  Loop->>Session: 读取模型视图
  Loop->>Provider: 发送提示、工具清单与消息
  Provider-->>Loop: 流式文本、推理与工具调用
  Loop->>Session: 追加助手内容与工具调用
  alt 模型返回工具调用
    Loop->>Kernel: 校验并请求判定
    Kernel->>Kernel: 检查限制、规则与审批
    opt 判定需要用户审批
      Kernel->>Host: 等待本会话的审批答复
      Host-->>Adapter: approval.request
      Adapter-->>User: 显示审批卡
      User-->>Adapter: 允许或拒绝
      Adapter->>Host: approval.respond
      Host-->>Kernel: 返回判定结果
    end
    Kernel->>Tool: 执行获准的工具
    Tool-->>Kernel: 返回结果
    Kernel->>Session: 记录判定与工具结果
    Loop->>Provider: 带上工具结果继续请求
  else 模型完成本轮
    Loop->>Session: 追加完成、取消或失败终态
  end
  Host-->>Adapter: 状态、事件与最终结果
  Adapter-->>User: 显示会话更新
```

[Agent Loop](../../core/src/kernel/loop.ts) 执行一轮用户输入及所需的模型与工具迭代：

1. 将用户输入和本轮有效设置追加到会话记录。
2. 生成系统提示、工具清单，并从会话记录构建模型消息。
3. 若启用了上下文压缩，在发送前检查请求大小；服务报告请求过大时，最多执行一次恢复压缩与重试。
4. 流式接收模型响应，将推理、文本和工具调用写入记录。
5. 通过 Kernel 执行工具调用，将结果写入记录，再按模型响应继续迭代。
6. 在本轮完成、取消或失败时写入一条终态。

[模型适配器](../../core/src/model/) 实现当前支持的 HTTP 消息格式。Host 根据生效的模型服务选择 Provider，并只在发送请求时读取凭据。HTTP 适配器要求响应包含协议终止标记和受支持的结束原因，并发出 `finish` 事件；Loop 在判定完成前拒绝输出耗尽或空响应。工具调用批次会在执行前完整解析并校验参数模式。参数校验拒绝会作为工具结果交给模型处理；Provider JSON 无效或流中断会使本轮失败，且不会重放工具调用。上下文压缩摘要也经过相同的完成检查后才写入检查点。

`model.outputTokens` 表示本次请求的输出预算，与旧版能力上限调整相互独立。模型服务保留字符串形式的 `models` 列表，并可按模型 ID 配置 `modelSettings`，包括显示名称、上下文窗口和请求输出预算。模型级输出声明可以提高未知端点的保守默认值，但不能超过已核实的端点或模型上限，也不能覆盖显式能力限制。未设置该声明的旧配置仍使用保守上限。[预算解析器](../../core/src/model/output-budget.ts)会校验生效限制；同一模型的上下文窗口也控制 Host 的压缩。Provider 重建和会话生成设置变更在轮次边界生效。

Host 的运行进度仅在当前活跃会话与任务期间存在，由 Loop、压缩、审批和提问事件生成。`status.get` 与 `progress` 通知提供阶段、时间和计数；TUI 与 Desktop 展示同一状态。Host 会合并短时间内重复的活动通知，但保留实际进度时间；任务结束时清除进度。进度心跳不会写入 Session JSONL，默认也不会因无活动超时而取消任务。

### 会话记录与恢复

追加式 [JSONL 会话记录](../../core/src/session/session.ts)是对话事实来源。首行记录会话标识和项目信息；之后的事件记录用户与助手消息、工具调用和结果、轮次状态、模型选择、Permission、Policy 覆盖和拒绝计数等状态。Policy 快照可由旧版本读者跳过，不进入模型消息或检查点。会话锁阻止多个进程同时写入同一记录。

默认路径为 `dataRoot()/workspaces/<可读路径>--<稳定哈希>/sessions/`，同目录保存记录和附属文件。只读列表与搜索会扫描旧全局目录和项目目录但不迁移；用户打开旧会话时才会复制到工作区目录，并保留原件。

模型请求使用从记录计算出的投影。界面可以读取推理、标签、轮次信息和用量；按投影规则，这些内容不会全部进入模型消息。创建分支会复制整份记录，或复制到一轮完整结束处为止；父会话保持不变。

检查点是派生文件。使用前会核验格式、覆盖的序号区间以及相对于会话事件的摘要值。校验失败或文件不存在时，从 JSONL 记录重建模型视图。压缩只写检查点，不改写会话记录。过大的工具结果放在旁路文件中，记录保留读取和导出所需的引用。

重新打开会话时，若已派发的工具调用没有结果，恢复逻辑会记下 `tool_outcome_unknown`，不会重放该调用。这样可以重建有效的模型投影，同时避免重复执行结果未知的外部操作。

### 会话数据路径

```mermaid
flowchart TD
  Config[用户配置与项目配置] --> Environment[项目环境快照]
  Environment --> Provider[模型服务与凭据读取]
  Environment --> Policy[审批规则与工具模式]
  Client[CLI / TUI / 桌面界面] --> Protocol[Host 协议]
  Protocol --> Host[Node Host]
  Host --> Log[追加式会话 JSONL]
  Host --> Loop[Agent Loop]
  Log --> Projection[模型消息投影]
  Projection --> Loop
  Loop --> Provider
  Loop --> Kernel[Kernel 判定与工具执行]
  Kernel --> Log
  Log --> Checkpoint[校验后的检查点]
  Log --> Spill[工具结果旁路文件]
  Log --> Export[导出与历史浏览]
  Spill --> Export
```

配置层在 Host 启动项目环境时合并成快照。会话 JSONL 是消息和工具结果的来源；检查点与旁路文件保存可重新校验或取回的派生内容。历史浏览和导出读取记录与可用旁路文件，不以界面缓存作为会话事实来源。用户数据根和项目工作区分别管理用户级资料与项目归属。

配置编辑在版本校验、TOML 修改、生效配置校验和原子替换期间持有目标文件锁。Host 会在保存前校验模型变更，包括共享默认值、其他已载入项目的共享设置以及会话显式选择；拒绝的变更不会修改文件。通过校验的配置仍在现有会话轮次边界生效。SSE 流式响应与非流式 JSON 适配器会向 Loop 提供相同的完成状态、用量、文本、推理和工具调用事件。

### Host 协议与客户端

Host 协议在[协议表](../../core/src/host/protocol.ts)中定义方法、参数、审批请求、问题请求和通知。[`connection.ts`](../../core/src/host/connection.ts) 使用按行分隔的 JSON 消息。Host 在分派前校验方法参数，并持有会话状态；客户端通过协议创建或打开会话、启动或取消轮次、读取记录、回应待办和修改支持的设置。

CLI 命令直接调用 Host。TUI 在内存连接上使用相同协议。桌面前端通过固定的 Preload API 使用 IPC 连接 Electron Main，Main 只转发消息帧，不解释 Host 方法或会话数据。传输方式不同，Host 方法和 Kernel 行为保持共用。

### 相关文档

[术语表](GLOSSARY.zh-cn.md)定义项目用语；[贡献与验证](CONTRIBUTING.zh-cn.md)列出开发命令和检查范围；[使用手册](../guide.zh-CN.md)说明 CLI、TUI 和 Desktop 的用户操作。
