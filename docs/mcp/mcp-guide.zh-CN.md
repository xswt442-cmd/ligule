# 本地 MCP Server

Ligule CLI 可以通过标准输入输出启动本地 MCP Server。它让外部 MCP 客户端调用现有 Host 来创建或接回会话、提交任务、检查运行状态、读取记录和取消任务。

## 启动

需要 Node.js 24 或更新版本，并安装 Ligule CLI：

```sh
npm install -g ligule
```

先进入目标项目目录，交互式运行一次 `ligule`，确认信任该工作区后退出。MCP Server 必须使用相同的操作系统用户和 `LIGULE_HOME`，才能读取已有信任记录。Server 在读取项目配置前检查信任；未信任时以 `control_project_untrusted` 退出，不在 stdio 上弹出信任提示，也不提供通过 MCP 授予信任的工具。工作区信任不等于工具审批，既有 Policy 和审批拒绝规则仍然生效。

在 MCP 客户端配置中，将 `ligule` 作为 stdio 子进程启动，并为它指定一个绝对项目目录。例如：

```json
{
  "mcpServers": {
    "ligule": {
      "command": "ligule",
      "args": ["mcp-server", "--project", "/absolute/path/to/project"]
    }
  }
}
```

Windows 路径示例：

```json
{
  "mcpServers": {
    "ligule": {
      "command": "ligule",
      "args": ["mcp-server", "--project", "C:\\Work\\project"]
    }
  }
}
```

每个 MCP Server 进程只授权启动时指定的一个项目。客户端通过 MCP `tools/list` 发现十个工具及其参数 schema：

- `ligule_session_create`：在授权项目中创建会话。
- `ligule_session_open`：接回已有会话。列表中的会话需要先接回，之后才能提交任务或读取记录。
- `ligule_session_list`：有界列出授权项目中的会话。
- `ligule_session_configure`：读取会话当前/待生效的设置和实际可用选项；操控者模式可修改会话设置。
- `ligule_interaction_reply`：对真实待决的审批或提问作一次性答复；只接受原会话和请求编号。
- `ligule_session_send`：空闲时开始新一轮，运行中按顺序排入下一轮消息，也可继续或清理队列。
- `ligule_run_start`：提交一条任务，返回当前进程内的 `operationId` 和会话编号。
- `ligule_run_status`：查询任务是否仍在运行、已完成、失败或取消。
- `ligule_session_read`：分页读取会话记录。
- `ligule_run_cancel`：按 `operationId` 取消相应任务。

推荐顺序是先创建或接回会话，再读取 `ligule_session_configure`。提交任务后轮询 `ligule_run_status`；根据 `phase`、`waitingFor` 和 `pendingInteractions` 继续等待或审阅后答复。完成后用 `ligule_session_read` 查看新增记录。状态通知通过 MCP logging 尽力发送；通知不可用时轮询仍可读取同一状态。需要停止时调用 `ligule_run_cancel`。工具参数以运行中的 `tools/list` schema 为准。

## 操控者授权与会话设置

默认启动参数不包含操控者授权。此时审批请求按既有行为拒绝，Host 不注册 `ask_user_question`，配置查询仍可用，设置修改与交互答复返回 `control_operator_required`。只有本地 MCP 客户端配置明确加入 `--operator`，才能启用回复和会话设置：

```json
{"command":"ligule","args":["mcp-server","--project","/absolute/path/to/project","--operator"]}
```

`--operator` 代表本机操控者明确授权这个 stdio 客户端。它允许回答 Policy 判为 `ask` 的审批、回答真实提问，以及修改单个会话的 Mode、Policy、模型、生成参数和每轮循环上限；它不更改文件边界、工作区信任或硬拒绝规则。Policy 为 `never`、工具校验失败、工作区越界等固定拒绝不能被审批答复覆盖。审批内容展示真实工具和操作参数；如果 Host 无法完整、安全地展示请求，就会拒绝该请求。

## Agent Control 项目授权

需要让 MCP 会话使用受控 Permission 时，先在受信任的 TUI 输入 `/control create`，或在 Desktop「设置 → 外部控制」创建绑定项目的 Grant。Grant 保存默认权限、权限上限、网络默认值与上限、允许的 Policy、是否允许普通 Operator 操作及到期时间。`full-access` 和不受限网络必须在创建界面分别确认。授权只适用于 Grant 绑定的项目；它不是远程客户端身份认证，也不解除操作系统 Sandbox 限制或 Policy 硬拒绝。

使用 Grant 启动 MCP Server：

```json
{"command":"ligule","args":["mcp-server","--project","/absolute/path/to/project","--grant","GRANT_ID","--operator"]}
```

MCP 会校验项目路径与 Grant 绑定一致，并将其默认 Permission、网络和 Policy 应用于新会话。`--operator` 只能在 Grant 已允许普通 Operator 操作时使用；这时 MCP 可在 Grant 上限内改会话设置并答复真实待决的审批或提问。未提供 Grant 时，单独的 `--operator` 不会授予或提升 Permission；提供 Grant 但不启用 `--operator` 时，只能使用 Grant 默认值，不能通过 MCP 修改这些设置。Host 会持续核验撤销、到期和项目绑定；失效后拒绝后续控制并释放会话锁。

新会话可在 `ligule_session_create` 的 `initial` 中一次性设置 `mode`、`policy`、`model`、`thinking`、`outputTokens` 和 `loopIterations`。已打开会话使用 `ligule_session_configure` 的 `changes`。单次更新只能改一个类别：Mode、Policy、生成设置或循环上限；生成设置类别内部可同时改模型、思考档位和输出上限。`loopIterations` 是每轮用户任务允许的模型/工具循环次数，必须是正安全整数；默认值来自项目 `[loop].iterations`，未设置时为 64。会话覆盖不改项目配置，保存在 Session JSONL 中，并在重新接回时恢复。`loop.modelCalls` 仍使用项目配置，不会随 `loopIterations` 一起变化。混合类别的请求会被 schema 拒绝，避免部分生效。当前格式的记录会保存并恢复 Mode、Policy 覆盖、Policy 拒绝计数与强制逐次审批状态，以及模型/生成设置。运行期间的生成设置和循环上限在下一轮开始时生效，Policy 在之后的工具判定生效，不能改变已经等待中的审批。旧格式会话仍可读取，但不能修改 Permission 或 Policy。响应中的 `applies` 明确给出时机。

Node/Python 脚本调用需要逐次审批；`approval.request` 会包含规范脚本路径、SHA-256、解释器、工作区和 Permission，Operator 应向操作者展示这些信息。审批等待期间源文件或执行身份变化时，Host 拒绝执行并返回 `exec_script_binding_changed`。无法安全绑定的脚本、包装器、复合解释器调用和动态命令会 fail closed；它们不会因为 Operator 可以答复普通审批而获得绕过权限。

模型和服务选项来自当前 Host 配置。`thinking` 只列出已核实的模型能力；当前仅官方 DeepSeek Chat Completions 端点上列出的模型支持 `none/low/high/max`。兼容网关不会自动继承此能力。`effective.generation.outputTokens` 是当前请求预算；`maxOutputTokens` 是解析后的模型/服务输出上限，`contextTokens` 单独报告。例如，已核实的 DeepSeek Flash 输出上限是 393,216 Token；未知兼容端点继续使用保守默认上限。输出预算必须同时不超过服务上限和上下文窗口，否则 Host 返回稳定错误码。使用 `null` 清除模型、思考或输出上限的会话覆盖。

## 运行阶段与消息队列

`ligule_run_status` 保留 `running/done/failed/cancelled` 四种终态兼容状态，并返回阶段、等待类型、进度、待决交互及有界事件。每个操作保留最近 128 个事件；使用 `after` 游标增量读取，单次最多 50 条。若事件缓存已覆盖旧游标，`eventGap` 会提示需要从现有状态重新同步。运行和等待交互时状态仍是 `running`。

`ligule_session_send` 最多缓存 16 条下一轮消息，每条不超过 65,536 个字符。空闲会话立即开始一轮并返回 `operationId`；运行中的消息按接收顺序排队。运行正常完成后自动执行下一条，并在来源操作的事件流发布 `queue.started` 与新 `operationId`，即使新一轮很快结束也能查询。运行取消或失败会暂停队列，调用 `continue` 才继续；可用 `cancel_queued` 删除指定条目，或用 `clear_queue` 清空剩余条目。该队列只在 Server 进程内存在，重启后不恢复，也不会重放不确定的副作用。正在等待审批或提问时，排队消息不会替代交互答复。

成功结果同时提供 `structuredContent` 和 JSON 文本 `content`。工具执行失败时返回 `isError: true`，从文本 `content` 中解析 JSON 的 `code` 字段，例如 `session_locked` 或 `operation_not_found`；失败结果没有成功形状的 `structuredContent`。未知工具或不符合 schema 的参数返回 MCP 协议错误。运行状态只包含固定摘要和错误码，模型正文与工具结果通过会话记录读取。

`ligule_session_read` 默认返回最近一页，页内记录按时间从早到晚排列。用响应里的 `nextBefore` 作为下一次读取的 `before`，即可逐页向更早记录读取。单次最多返回 50 条记录；每条 `json` 是 Host 记录的 JSON 文本片段，每段最多 8192 个 UTF-16 字符。

读取一个较大的完整记录时，先用 `at` 指定该记录的事件序号，再按响应里的 `nextOffset` 继续读取同一记录：

```json
{
  "sessionId": "SESSION_ID",
  "at": 42,
  "offset": 0
}
```

把每次响应中同一 `seq` 的 `json` 片段按 `offset` 顺序拼接；当 `nextOffset` 为 `null` 时，片段已经完整，可以对拼接结果执行 `JSON.parse`。后续请求继续使用同一个 `at`，并将 `offset` 设为上一段的 `nextOffset`。`at` 与 `before` 不能同时提供。完成当前记录后，再用 `nextBefore` 翻到更早的一页。

## 项目与权限

`--project` 必须是绝对路径。会话、运行和读取都限制在启动时授权的项目内；`ligule_session_list` 返回的会话需通过 `ligule_session_open` 接回后才能操作。项目目录标识会话归属，`boundary` 仍独立限制文件工具可访问的路径。

MCP Server 使用 Ligule 已有的配置、模型服务、工具和 Policy。未启动 `--operator` 时，需要人工审批的操作会被拒绝；启动该选项后，只能答复真实待决请求。Server 不提供任意 Host RPC 或任意配置文件写入工具。它只使用本地 stdio，不开启网络监听。stdio 客户端与 Server 使用同一操作系统用户权限，请只配置可信的本地 MCP 客户端。

没有 Grant 时，`--operator` 不会授予或提升会话 Permission，也不能更改 OS 资源边界。MCP 工具调用始终经过会话的 Permission 与 Policy 判定。受限 Shell 只在平台 Sandbox 满足所需能力时运行；当前 Linux bubblewrap 的文件系统隔离报告为 `partial`，Windows 没有 OS Sandbox 后端，因此这两个平台上的 `read-only` 和 `workspace-write` 会话均不能运行 Shell。`full-access` 需要在可信交互界面单独确认；这不会让 Policy 的硬拒绝可被覆盖。

任务状态和 `operationId` 只保存在当前 Server 进程中；每个进程保留最多 256 个操作记录。达到上限后，新任务会从已结束的操作中淘汰创建时间最早的一条；被淘汰的 `operationId` 不可再查询。如果所有保留的操作都仍在运行，新任务会以容量错误拒绝。Server 退出或重启后，旧 `operationId` 不可恢复。会话记录仍由 Host 持久保存，可重新启动 Server、接回会话并读取历史，但这不会恢复旧进程中的运行状态。

一个 Server 进程最多接管 64 个不同会话。重复接回已经由该进程接管的会话不占用额外名额。达到上限后，无法再创建或接管新会话；重启 Server 才会释放这些名额。没有运行的会话也会一直占用名额到 Server 退出。

客户端断开或 Server 收到终止信号时，Server 会取消仍在运行的任务、等待 Host 调用结束并释放会话锁与扩展资源。已写入会话记录的内容仍可在重启后读取，断开不会恢复未完成的任务或旧 `operationId`。

要在 Desktop 中查看 MCP 会话，Desktop 与 MCP Server 需使用相同的 `LIGULE_HOME` 和有效会话目录。Desktop 会话侧栏会列出同一目录中的会话；Server 持有会话锁时，侧栏条目可见，但 Desktop 不能同时打开该会话。客户端断开后 Server 释放锁，用户刷新侧栏即可打开已保存的会话记录。两个进程使用不同的数据根或会话目录时，会话列表彼此独立。

工具调用和记录内容会交给 MCP 客户端。请只连接可访问该项目数据的客户端，并在需要时检查其日志和数据保留方式。
