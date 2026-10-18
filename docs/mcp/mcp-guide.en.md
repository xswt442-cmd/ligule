# Local MCP Server

The Ligule CLI can start a local MCP server over standard input and output. An external MCP client can use it to create or reopen sessions, submit work, check run status, read records, and cancel a run through the existing Host.

## Start

Use Node.js 24 or newer and install the Ligule CLI:

```sh
npm install -g ligule
```

First enter the target project directory, run `ligule` interactively, confirm workspace trust, and exit. The MCP server must use the same operating system user and `LIGULE_HOME` to read that trust record. It checks trust before reading project configuration and exits with `control_project_untrusted` for an untrusted project. It does not prompt over stdio or expose an MCP tool to grant trust. Workspace trust does not approve tool actions; existing Policy and approval denial rules still apply.

Configure your MCP client to start `ligule` as a stdio child process and provide an absolute project directory:

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

For example, on Windows:

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

Each MCP server process authorizes only the project supplied at startup. Use MCP `tools/list` to discover all ten tools and their input schemas:

- `ligule_session_create`: create a session in the authorized project.
- `ligule_session_open`: reopen an existing session. A session returned by the list tool must be opened before it can be used for a run or record read.
- `ligule_session_list`: list a bounded number of sessions in the authorized project.
- `ligule_session_configure`: read effective/pending session settings and available choices; operator mode can change session-owned settings.
- `ligule_interaction_reply`: answer one real pending approval or question, bound to its session and request ID.
- `ligule_session_send`: start a round when idle, queue the next message while running, or continue and manage the queue.
- `ligule_run_start`: submit one task and return an `operationId` scoped to the current process and the session ID.
- `ligule_run_status`: check whether the run is running, done, failed, or cancelled.
- `ligule_session_read`: read a page of session records.
- `ligule_run_cancel`: cancel the run identified by its `operationId`.

Recommended flow: create or reopen a session and read `ligule_session_configure`. After submitting work, poll `ligule_run_status`; use `phase`, `waitingFor`, and `pendingInteractions` to decide whether to wait or review and reply. Read new records with `ligule_session_read` after completion. MCP logging notifications are best-effort; polling exposes the same state when notifications are unavailable. Call `ligule_run_cancel` to stop a run. The running server's `tools/list` schemas define the arguments.

## Operator authorization and session settings

The default startup does not grant operator authority. In this mode, approval requests are denied as before, Host does not register `ask_user_question`, settings can be read, and settings changes or interaction replies fail with `control_operator_required`. Add `--operator` explicitly to the local MCP client configuration to enable replies and session settings:

```json
{"command":"ligule","args":["mcp-server","--project","/absolute/path/to/project","--operator"]}
```

`--operator` means the local operator explicitly authorizes this stdio client. It permits answering Policy decisions that are `ask`, answering real questions, and changing one session's mode, Policy, model, and generation settings. It does not change workspace trust, file boundaries, or hard denials. An approval cannot override `never`, invalid tool input, or workspace boundaries. If Host cannot present a request fully and safely for review, it denies that request.

Create a session with `initial` in `ligule_session_create` to set `mode`, `policy`, `model`, `thinking`, and `outputTokens` together. Use `changes` in `ligule_session_configure` for an existing session. A change call may update only one category: mode, Policy, or generation settings. The generation category can update model, thinking effort, and output budget together. The schema rejects mixed categories so an invalid request cannot partially apply. Settings belong to the session and do not edit configuration files. Mode and model/generation settings are stored in Session JSONL and restored when the session is reopened. A Policy override follows the Host's current runtime behavior and reverts to the project default after reopening. Generation changes made during a run take effect at the next round; Policy changes affect later tool decisions and do not resolve an approval already waiting for a reply. `applies` reports the timing.

Available models and services come from the loaded Host configuration. `thinking` only lists verified model capabilities; currently `none/low/high/max` is supported only for listed models at the official DeepSeek Chat Completions endpoint. Compatibility gateways do not inherit this capability. Output tokens must fit the service declaration, verified model ceiling, and context window; otherwise the Host returns a stable error code. Set model, thinking, or output-token overrides to `null` to clear that session override.

## Run phases and message queue

`ligule_run_status` retains the compatible `running/done/failed/cancelled` state values and returns phase, wait type, progress, pending interactions, and bounded events. Each operation retains its latest 128 events; use the `after` cursor for incremental reads, with up to 50 events per call. If the event cache has moved past a cursor, `eventGap` indicates that the client should resynchronize from current state. A run waiting for approval or a question remains `running`.

`ligule_session_send` holds at most 16 next-round messages, each up to 65,536 characters. An idle session starts a run immediately and returns its `operationId`; messages sent while running queue in arrival order. A successful run starts the next queued message automatically and publishes `queue.started` with the new `operationId` on the source operation's event stream, so the new run remains discoverable even if it finishes quickly. Cancellation or failure pauses the queue until `continue`; use `cancel_queued` to remove one item or `clear_queue` to remove all remaining items. The queue is process-local, is not restored after restart, and does not replay uncertain side effects. While an approval or question is pending, a queued message does not answer it.

Successful results provide both `structuredContent` and JSON text in `content`. A tool execution failure returns `isError: true`; parse the JSON `code` from the text `content`, such as `session_locked` or `operation_not_found`. Failed results omit the success-shaped `structuredContent`. Unknown tools and arguments that violate the schema return MCP protocol errors. Run status contains only fixed summaries and error codes; read session records for model text and tool results.

`ligule_session_read` returns the newest page by default, with records in chronological order within that page. Use the response's `nextBefore` as `before` to read earlier pages. A call returns at most 50 records. Each `json` value is a fragment of the Host record's JSON text, capped at 8,192 UTF-16 characters.

To read a large record in full, use `at` with the event sequence number, then follow `nextOffset` to fetch the rest of that same record:

```json
{
  "sessionId": "SESSION_ID",
  "at": 42,
  "offset": 0
}
```

Concatenate the `json` fragments for the same `seq` in `offset` order. When `nextOffset` is `null`, the record is complete and the concatenated text can be passed to `JSON.parse`. Continue using the same `at`, setting `offset` to the previous response's `nextOffset`. `at` and `before` cannot be supplied together. Finish the current record before using `nextBefore` to move to an earlier page.

## Project and permissions

`--project` requires an absolute path. Session, run, and read operations are restricted to the project authorized at startup. Sessions returned by `ligule_session_list` must be reopened with `ligule_session_open` before use. The project directory identifies session ownership; `boundary` remains a separate limit for paths available to file tools.

The MCP server uses Ligule's existing configuration, model service, tools, and Policy. Without `--operator`, operations that need human approval are denied. With it, only real pending requests can be answered. The server does not expose arbitrary Host RPC or configuration-file writes. It uses local stdio and does not open a network listener. The stdio client and server run with the same operating-system user permissions, so connect only trusted local MCP clients.

Run state and `operationId` values exist only in the current server process; each process retains at most 256 operation records. At capacity, a new run evicts the earliest created operation that has settled. An evicted ID can no longer be queried. If all retained operations are still running, a new run fails with a capacity error. An old `operationId` cannot be recovered after the server exits or restarts. Host persists session records, so a new server can reopen a session and read its history, but it cannot restore a run from the previous process.

One server process can take ownership of at most 64 distinct sessions. Reopening a session already owned by that process does not use another slot. Once the limit is reached, it cannot create or open another session until the server restarts. Idle sessions keep their slots until the server exits because there is no per-session close tool.

When the client disconnects or the server receives a termination signal, it cancels active runs, waits for Host calls to settle, and releases session locks and extension resources. Records already written remain available after restart; disconnect does not resume unfinished runs or preserve their old `operationId` values.

Tool calls and session contents are sent to the MCP client. Connect only clients that are allowed to access the project data, and review their logging and retention behavior when needed.
