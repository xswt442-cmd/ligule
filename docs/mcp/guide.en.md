# Local MCP Server

The Ligule CLI can start a local MCP server over standard input and output. An external MCP client can use it to create or reopen sessions, submit work, check run status, read records, and cancel a run through the existing Host.

## Start

Use Node.js 24 or newer and install the Ligule CLI:

```sh
npm install -g ligule
```

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

Each MCP server process authorizes only the project supplied at startup. Use MCP `tools/list` to discover the seven tools, their input schemas, and descriptions:

- `ligule_session_create`: create a session in the authorized project.
- `ligule_session_open`: reopen an existing session. A session returned by the list tool must be opened before it can be used for a run or record read.
- `ligule_session_list`: list a bounded number of sessions in the authorized project.
- `ligule_run_start`: submit one task and return an `operationId` scoped to the current process and the session ID.
- `ligule_run_status`: check whether the run is running, done, failed, or cancelled.
- `ligule_session_read`: read a page of session records.
- `ligule_run_cancel`: cancel the run identified by its `operationId`.

Recommended flow: create or reopen a session, call `ligule_run_start`, then poll `ligule_run_status` and use `ligule_session_read` to read new records. Call `ligule_run_cancel` when the run should stop. The running server's `tools/list` schemas define the tool arguments.

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

The MCP server uses Ligule's existing configuration, model service, tools, and Policy. Operations that need human approval are denied. The server does not expose automatic approval, Policy changes, arbitrary Host RPC, or arbitrary configuration writes. It uses local stdio and does not open a network listener; an MCP connection does not raise tool permissions. The stdio client and server run with the same operating-system user permissions, so connect only trusted local MCP clients.

Run state and `operationId` values exist only in the current server process; each process retains at most 256 operation records. At capacity, a new run evicts the earliest created operation that has settled. An evicted ID can no longer be queried. If all retained operations are still running, a new run fails with a capacity error. An old `operationId` cannot be recovered after the server exits or restarts. Host persists session records, so a new server can reopen a session and read its history, but it cannot restore a run from the previous process.

One server process can take ownership of at most 64 distinct sessions. Reopening a session already owned by that process does not use another slot. Once the limit is reached, it cannot create or open another session until the server restarts. Idle sessions keep their slots until the server exits because there is no per-session close tool.

When the client disconnects or the server receives a termination signal, it cancels active runs, waits for Host calls to settle, and releases session locks and extension resources. Records already written remain available after restart; disconnect does not resume unfinished runs or preserve their old `operationId` values.

Tool calls and session contents are sent to the MCP client. Connect only clients that are allowed to access the project data, and review their logging and retention behavior when needed.
