# Architecture

[简体中文](ARCHITECTURE.zh-cn.md) · [English](ARCHITECTURE.en.md)

The workspace has three source modules: `core/` is the shared Agent Core, `tui/` is the CLI/TUI product, and `desktop/` is the Electron product. Dependencies point `tui → core ← desktop`; Core itself keeps Kernel, Host, Session, Model, Policy, and Tools as distinct concepts. The products ship independently through npm `ligule` and GitHub Releases. Core has no independent release. The [kernel](../../core/src/kernel/kernel.ts) executes registered tools and applies the decision chain. The [Host](../../core/src/host/host.ts) assembles that kernel with a project environment, model provider, session log, and client protocol.

This guide is for contributors reading or changing the repository. It explains component ownership, dependency direction, one request's execution path, and session recovery. The linked source files remain authoritative for protocol fields and module details.

## Runtime and execution

- [Runtime map](#runtime-map)
- [Kernel, plugins, tools, and capabilities](#kernel-plugins-tools-and-capabilities)
- [One Agent Loop turn](#one-agent-loop-turn)

## Session data and recovery

- [Session records and recovery](#session-records-and-recovery)
- [Session data flow](#session-data-flow)

## Host and clients

- [Host protocol and clients](#host-protocol-and-clients)
- [Related guides](#related-guides)

### Runtime map

```mermaid
flowchart LR
  CLI[CLI] -->|in process| Host[Node Host]
  TUI[React and Ink] -->|in memory protocol| Host
  External[Local MCP client] -->|stdio MCP| MCP[MCP adapter]
  MCP --> Control[Process-local control]
  Control --> Host
  Web[React desktop UI] <-->|sandboxed Preload and IPC| Main[Electron Main]
  Main <-->|newline-delimited frames| Child[Node Host process]
  Child --> HostLogic[Host and kernel]
  Host --> Project[Project environment]
  Host --> Loop[Agent Loop]
  Host --> Session[Session JSONL]
  Loop --> Provider[Model provider]
  Loop --> Kernel[Kernel]
  Kernel --> Policy[Decision chain]
  Kernel --> Registry[Tool registry]
  Registry --> Tool[Registered tools]
  Tool --> Capability[Platform and I/O capabilities]
  Provider --> Endpoint[HTTP model endpoint]
```

`ligule run` and the default `ligule` invocation (or the compatible `ligule tui` command) create a Host in the Node process that owns the interface. The TUI sends protocol messages over an in-memory connection. The desktop frontend communicates with Electron Main through a fixed sandboxed Preload API; Main forwards protocol frames to the independent Node Host and manages windows, native interactions, and process lifecycle. The Host owns sessions, project state, policy, and model requests. See the [CLI](../../tui/src/cli.ts), [TUI adapter](../../tui/src/tui/start.ts), [frame transport](../../core/src/host/connection.ts), [Electron IPC](../../desktop/electron/ipc.ts), and [Preload API](../../desktop/electron/preload.ts).

The [project environment loader](../../core/src/host/environment.ts) supplies configuration layers and extension sources to CLI and Desktop Host entries. The [provider factory](../../core/src/host/provider.ts) validates the selected model wire format, capabilities and retry settings; an unconfigured Host accepts settings requests and rejects model runs explicitly. The [session mode transaction](../../core/src/host/session-mode.ts) owns restriction installation, prompt fragments, rollback, and the persisted mode fact. Host keeps session locks, active turns, routing and resource cleanup. TUI record projection lives in [transcript.ts](../../tui/src/tui/transcript.ts); Desktop's [stream buffer](../../desktop/frontend/src/session-stream.ts) separates partial output by session.

`ligule mcp-server --project <absolute-root>` exposes local control tools through the [MCP adapter](../../core/src/host/mcp-server.ts). The [control facade](../../core/src/host/control.ts) calls the same Host, tracks process-local operations, and limits session operations to the project authorized at startup. By default, it denies operations that require approval. With `--operator`, clients can reply to real pending approvals and questions and change supported session settings; hard denials cannot be overridden. Trusted TUI/Desktop clients can create project-bound [Agent Control Grants](../../core/src/host/agent-control.ts); `--grant <id>` bounds session Permission, network access, and Policy to the Grant's defaults and ceilings, which the Host revalidates on requests. Disconnect cancels runs and releases session locks. Session JSONL persists session records, while operation IDs and the message queue exist only in the current process. See the [MCP user guide](../mcp/mcp-guide.en.md).

### Kernel, plugins, tools, and capabilities

The kernel starts with an empty tool registry. The Host installs plugins through the [assembly loader](../../core/src/kernel/assembly.ts); a plugin registers tools and returns cleanup actions. The selected [tool mode](../../core/src/kernel/modes.ts) restricts which registered tools enter the model manifest and selects named prompt fragments. It does not implement tools or provide an approval decision.

A tool is the model-callable contract: a name, description, JSON parameter schema, and execution function. Its implementation may call code under [`core/src/capability/`](../../core/src/capability/), which performs environment-sensitive work such as path checks, shell selection, process management, network resolution, or clipboard access. A capability implementation is not automatically a model-callable tool. When policy records a `capability` label, that value names the operation used for that decision.

Every model tool call passes through [`kernel.call`](../../core/src/kernel/kernel.ts). The kernel checks registration and arguments, resolves declared command or network targets, then asks the decision chain to evaluate the call. The chain applies restrictions, guards, configured rules, automatic approval checks, and user approval in its defined order ([policy implementation](../../core/src/kernel/policy.ts)). Only an allowed call reaches the tool implementation. The kernel records the verdict and a result for completed, rejected, or failed calls; the model manifest contains only the tool name, description, and parameter schema.

The Host keeps Permission and Policy as separate per-session state. Before Policy runs, Permission checks each tool's resource-access category for reads, writes, command execution, network, or external processes. Policy then decides whether to ask for approval or refuse. The interactive TUI and Desktop can change session Permission; enabling `full-access` and `unrestricted` network requires separate confirmation. Command execution probes the selected Shell and platform capabilities through [`permission-capabilities.ts`](../../core/src/capability/permission-capabilities.ts). Linux uses bubblewrap and reports its measured filesystem isolation. When a restricted command uses Node from a hidden directory, the sandbox read-only maps only that executable and the distribution's npm/Corepack files to a fixed path; the user home and package-manager caches remain hidden. Windows `workspace-write` uses a per-run `WRITE_RESTRICTED` token and temporary workspace ACLs; it is `partial`, requires explicit project trust, risk confirmation, and unrestricted network access, and cannot confine reads or network. Hard links, writable ancestor `FILE_DELETE_CHILD` permissions, and concurrent ACL changes remain escape risks. Windows `read-only` uses AppContainer only if the selected Shell can enter the actual workspace; otherwise Kernel preflight refuses it. When available, it blocks workspace writes and Shell networking, while public readable system files remain visible. Project scripts and Git commands require workspace trust; Git commands also require per-call approval because repository configuration can run hooks, helpers, or aliases. `full-access` Shell runs with the current operating-system user's permissions and requires unrestricted networking and available process management. MCP `--operator` does not manage Permission, and Policy hard denials cannot be overridden by approval.

The default `minimal` mode also offers `managed_process` for commands such as development servers that must outlive one tool call. Start commands use the `exec` capability and retain its Permission, Script Binding, workspace trust, and Policy checks, including existing `exec` deny rules. Start requires an HTTP loopback readiness URL and returns a Session-scoped handle, port, and readiness state; status, bounded logs, and explicit stop are scoped to the same Session. Logs return at most 16 KiB. Ordinary `exec` still waits for the command to finish and lets Guardian clean descendants. Managed processes stay in the Guardian/Job Object process tree and stop on run cancellation, Permission change, Session/Host close, or Grant revocation; Grants revoked or expired elsewhere are revalidated once per second. The readiness URL only limits Host probing; the command and active platform Permission determine the actual listen address and network access.

The [Agent Loop](../../core/src/kernel/loop.ts) performs one user turn and any model/tool iterations it requires:

1. Append the user event and the effective turn settings to the session.
2. Render the system prompt, build the registered tool manifest, and project the session into model messages.
3. If configured, compact the request before sending it or once after a provider reports an oversized request.
4. Stream a model response and append its reasoning, text, and tool calls to the session.
5. Run each tool call through the kernel, append its result, then continue the loop when the model requested more work.
6. Append one terminal turn event for completion, cancellation, or failure.

The [model adapters](../../core/src/model/) implement the supported HTTP message formats. The Host selects a provider from the effective model service and reads credentials only when making a request.

HTTP adapters require their protocol terminator and a supported finish reason. They emit a `finish` event; the Loop rejects output exhaustion and empty responses before declaring completion. Complete tool-call batches are parsed and schema-checked before execution. Schema refusals become tool results that the model can handle; invalid provider JSON or an incomplete stream fails the turn without replaying tools. Compaction summaries apply the same completion checks before writing a checkpoint.

`model.outputTokens` is the request budget, distinct from legacy capability reductions. Services retain their compatible string `models` list and optionally attach `modelSettings` entries keyed by model ID. The selected entry supplies its display name, context window, and request output budget. A per-model output declaration can raise the conservative default for an unknown endpoint; it cannot raise verified endpoint/model ceilings or explicit capability reductions. Legacy configurations without that declaration retain their conservative ceiling. The [budget resolver](../../core/src/model/output-budget.ts) validates the effective limits; the same selected context window controls Host compaction. Provider reconstruction and session generation adoption keep changes at turn boundaries.

Host run progress is ephemeral, scoped to one active session/run, and derived from Loop, compaction, and approval/input events. `status.get` and `progress` notifications expose phase/timestamps/counts; TUI and Desktop display that shared state. Activity notifications are coalesced while the Host snapshot retains actual event times. Terminal cleanup clears progress. No progress heartbeat is written into Session JSONL, and no default inactivity timer cancels runs.

### One Agent Loop turn

```mermaid
sequenceDiagram
  actor User
  participant Adapter as CLI / TUI / desktop adapter
  participant Host as Node Host
  participant Loop as Agent Loop
  participant Session as Session record
  participant Provider as Model service
  participant Kernel as Kernel and policy chain
  participant Tool as Tool and platform capability
  User->>Adapter: Submit a message
  Adapter->>Host: run.start
  Host->>Session: Append user event and turn settings
  Host->>Loop: Run with session, provider, and kernel
  Loop->>Session: Read model view
  Loop->>Provider: Send prompt, tool manifest, and messages
  Provider-->>Loop: Stream text, reasoning, and tool calls
  Loop->>Session: Append assistant content and tool calls
  alt The model requests a tool
    Loop->>Kernel: Validate and request a verdict
    Kernel->>Kernel: Check restrictions, rules, and approval
    opt User approval is required
      Kernel->>Host: Wait for approval in this session
      Host-->>Adapter: approval.request
      Adapter-->>User: Show approval card
      User-->>Adapter: Allow or refuse
      Adapter->>Host: approval.respond
      Host-->>Kernel: Return the verdict
    end
    Kernel->>Tool: Run an allowed tool
    Tool-->>Kernel: Return result
    Kernel->>Session: Record verdict and tool result
    Loop->>Provider: Continue with the tool result
  else The model completes the turn
    Loop->>Session: Append completed, cancelled, or failed status
  end
  Host-->>Adapter: Status, events, and final result
  Adapter-->>User: Show session updates
```

The loop appends the user input and effective turn settings, builds the model view, streams a response, and records each assistant event. Tool calls pass through kernel validation and policy before execution. The loop records their results and continues while the model requests more work. It appends one terminal status when the turn completes, is cancelled, or fails.

### Session records and recovery

The append-only [session JSONL record](../../core/src/session/session.ts) is the source of truth for a conversation. Its first line identifies the record and project; later lines hold user and assistant messages, tool calls and results, turn state, model selection, Permission, Policy overrides, denial counters, and other events. Policy snapshots are ignorable to older readers and stay out of model messages and checkpoints. Session locks prevent two processes from writing the same record at once.

By default, records and sidecars live at `dataRoot()/workspaces/<readable-path>--<stable-hash>/sessions/`. Read-only listing and search include the former shared and project-local locations without migrating files; opening a legacy session copies it into the workspace folder and preserves the source.

The model view is a projection of the record, not a second transcript. Reasoning, labels, turn metadata, and usage remain available for display or recovery but are excluded from model messages where the projection rules require it. A branch copies a record or a prefix ending at a completed turn; it leaves the parent unchanged.

Checkpoints are derived files. Before using one, ligule verifies its format, covered sequence range, and digest against the session events. If validation fails or the checkpoint is absent, it rebuilds the model view from the JSONL record ([checkpoint validation](../../core/src/session/checkpoint.ts)). Compaction writes a checkpoint and never rewrites the record ([compaction](../../core/src/session/compaction.ts)). Oversized tool output is stored in a sidecar file; the record retains the reference needed to read or export the complete result.

When a session is reopened, recovery repairs dispatched tool calls that have no recorded result with an explicit unknown outcome. It does not replay them. This preserves a valid model projection without repeating an operation whose external effect may already have happened.

### Session data flow

```mermaid
flowchart TD
  Config[User and project configuration] --> Environment[Project environment snapshot]
  Environment --> Provider[Model service and credential lookup]
  Environment --> Policy[Approval rules and tool mode]
  Client[CLI / TUI / desktop UI] --> Protocol[Host protocol]
  Protocol --> Host[Node Host]
  Host --> Log[Append-only session JSONL]
  Host --> Loop[Agent Loop]
  Log --> Projection[Model message projection]
  Projection --> Loop
  Loop --> Provider
  Loop --> Kernel[Kernel policy and tool execution]
  Kernel --> Log
  Log --> Checkpoint[Validated checkpoint]
  Log --> Spill[Tool-result sidecar]
  Log --> Export[Export and history browsing]
  Spill --> Export
```

Configuration layers are combined into a snapshot while the Host creates a project environment. The session JSONL is the source for messages and tool outcomes. Checkpoints and spill files contain derived data that can be validated or retrieved. History browsing and export read the record and available sidecars; a UI cache is not the source of session facts. The user data root and project workspace separately own user-level data and project attribution.

Configuration edits hold the target file lock through version checking, TOML editing, effective-configuration validation, and atomic replacement. The Host validates model changes before persistence, including shared defaults without project overrides, shared user changes in other loaded projects, and explicit session model selections. Rejected edits do not modify the file. Valid changes still apply at the existing session turn boundary. Both streaming SSE and non-streaming JSON adapters emit the same completion, usage, text, reasoning, and tool-call events into the Loop.

### Host protocol and clients

The Host protocol defines methods, request parameters, approval requests, question requests, and notifications in one [protocol table](../../core/src/host/protocol.ts). [`connection.ts`](../../core/src/host/connection.ts) carries newline-delimited JSON messages. The Host validates method parameters before dispatch and owns all session state; clients use protocol methods to create or open sessions, start and cancel turns, read records, answer requests, and change supported settings.

The CLI's single-turn commands call the Host directly. The TUI uses the same protocol over an in-memory connection. The desktop UI uses a TypeScript client through the fixed Preload API and Electron IPC; Main forwards frames without interpreting Host methods or session data. These transports differ, while the Host methods and kernel behavior remain shared.

### Related guides

The [glossary](GLOSSARY.en.md) defines shared terms. [Contributing and checks](CONTRIBUTING.en.md) lists development commands and validation scope. The [user guide](../guide.en.md) explains CLI, TUI, and desktop workflows.
