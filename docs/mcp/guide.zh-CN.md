# 本地 MCP Server

Ligule CLI 可以通过标准输入输出启动本地 MCP Server。它让外部 MCP 客户端调用现有 Host 来创建或接回会话、提交任务、检查运行状态、读取记录和取消任务。

## 启动

需要 Node.js 24 或更新版本，并安装 Ligule CLI：

```sh
npm install -g ligule
```

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

每个 MCP Server 进程只授权启动时指定的一个项目。客户端可通过 MCP `tools/list` 读取七个工具的参数 schema 和说明：

- `ligule_session_create`：在授权项目中创建会话。
- `ligule_session_open`：接回已有会话。列表中的会话需要先接回，之后才能提交任务或读取记录。
- `ligule_session_list`：有界列出授权项目中的会话。
- `ligule_run_start`：提交一条任务，返回当前进程内的 `operationId` 和会话编号。
- `ligule_run_status`：查询任务是否仍在运行、已完成、失败或取消。
- `ligule_session_read`：分页读取会话记录。
- `ligule_run_cancel`：按 `operationId` 取消相应任务。

推荐顺序是先创建或接回会话，再调用 `ligule_run_start`；随后轮询 `ligule_run_status` 并用 `ligule_session_read` 读取新增记录。需要停止时调用 `ligule_run_cancel`。工具参数以运行中的 `tools/list` schema 为准。

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

MCP Server 使用 Ligule 已有的配置、模型服务、工具和 Policy。需要人工审批的操作会被拒绝；Server 不提供自动审批、Policy 修改、任意 Host RPC 或任意配置写入工具。它只使用本地 stdio，不开启网络监听，也不会因 MCP 客户端连接而提升工具权限。stdio 客户端与 Server 使用同一操作系统用户权限，请只配置可信的本地 MCP 客户端。

任务状态和 `operationId` 只保存在当前 Server 进程中；每个进程保留最多 256 个操作记录。达到上限后，新任务会从已结束的操作中淘汰创建时间最早的一条；被淘汰的 `operationId` 不可再查询。如果所有保留的操作都仍在运行，新任务会以容量错误拒绝。Server 退出或重启后，旧 `operationId` 不可恢复。会话记录仍由 Host 持久保存，可重新启动 Server、接回会话并读取历史，但这不会恢复旧进程中的运行状态。

一个 Server 进程最多接管 64 个不同会话。重复接回已经由该进程接管的会话不占用额外名额。达到上限后，无法再创建或接管新会话；重启 Server 才会释放这些名额。没有运行的会话也会一直占用名额到 Server 退出。

客户端断开或 Server 收到终止信号时，Server 会取消仍在运行的任务、等待 Host 调用结束并释放会话锁与扩展资源。已写入会话记录的内容仍可在重启后读取，断开不会恢复未完成的任务或旧 `operationId`。

工具调用和记录内容会交给 MCP 客户端。请只连接可访问该项目数据的客户端，并在需要时检查其日志和数据保留方式。
