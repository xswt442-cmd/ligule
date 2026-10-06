# Agent guide

`ligule` is an agent harness under development. The 0.0.x line is a placeholder: the repository, the package name and the licence are claimed; the behaviour is not settled.

## Layout

```
src/kernel/      tool table, decision chain, loop, prompt assembly, slot registry,
                 assembly list, mode loader, result shapes, config, log, error codes
src/capability/  path boundaries, probing, command parsing and execution, search and
                 trash backends, network target classes, instruction loading, limits
src/tools/       the three read-only tools, the four write tools, the first-party
                 optional tools, what they share, the minimal list
src/session/     the record, its format, repair, listing, checkpoint, compaction
src/model/       the two wire shapes and their HTTP layer
src/host/        the client protocol, the line carrier, the session owner
src/tui/         the terminal client
modes/           the shipped assembly lists: minimal, full
desktop/         the Tauri shell and its Vite frontend (outside package.json#files)
scripts/         build and packaging helpers
test/            checks against dist/
```

Dependencies point toward `kernel/`, never away from it. `test/architecture.test.js` scans those directories instead of a hand-written list, so a new file is covered without anyone adding it. Platform-specific code belongs in `capability/` (D18).

## Commands

```sh
npm ci              dependencies from the lockfile
npm run build       tsc → dist/
npm test            builds, then runs the suites against dist/
npm run check-pack  packs, unpacks, imports the package from an empty consumer
npm run build-rg    downloads the pinned ripgrep into packages/rg-*
```

## Invariants

- The kernel ships no tools (I1). An adapter adds one by registering it.
- The assembly list the model sees is the one the run loaded (I2).
- The decision chain is monotone: no later step relaxes an earlier refusal, and no declaration grants a pass (I3, I4).
- The session record is the only source of truth (I5). Derived files — listings, checkpoints — are rebuilt from it or discarded.
- Injected content is capped by bytes; over the cap the full text goes to a file and the record keeps a reference (I6).
- All interface content mounts through the slot registry; the host never names a plugin (I7, D25).
- Model-visible fields are name, description and parameter schema only (D12).
- Cancellation is one token shared by the tool, the provider and the loop (D20).
- Every failure carries a stable code (`KernelError#code`). `KernelError` is a tool that did not finish; the loop continues. `KernelRuntimeError` is the kernel itself failing; the loop stops. An error without a code becomes `tool_failed`, the original goes into `cause`. The code serves the host, `detail` serves the model, and the CLI prints both. Every dispatched call gets an answer in the log, including one the loop chose not to run (`tool_skipped`) — a missing answer invalidates every later request body.

## Build and files

`dist/` is what runs: `bin`, `exports` and `files` point there, and the tests import it, so a green run exercised the shipped bytes. `tsc` runs with `allowJs` and `checkJs: false`. New modules are TypeScript under `strict`, with erasable syntax only — no `enum`, no `namespace`, no parameter properties (D47). Older JavaScript files are copied through and convert layer by layer. `src/` is not runnable as it stands: a `.ts` module has no `.js` twin.

`package.json#version` and `src/index.js#VERSION` stay equal; `test/kernel.test.js` asserts it. The Node floor is one number written in three kinds of place — `engines.node`, the badge in `README.md`, `PRIMARY_NODE_VERSION` in each workflow — and `test/runtime-version.test.js` reads all of them and asserts they agree; the workflows install Node from that variable instead of repeating a number per step.

## Assembly

A mode is a named assembly list (D35, D43): one TOML per mode, found in `modes/`, then `~/.ligule/modes/<name>.toml`, then `<project root>/.ligule/modes/<name>.toml`. The highest hit wins whole; nothing merges across layers. Both fields — `tools` and `prompt` — are required, an empty list included. `run`, `tui` and `host` choose with `--mode <name>` over the config key `mode`, defaulting to `minimal`; `tools` and `call` read none (D44).

A mode narrows the registry and selects prompt fragments by name. It cannot name skills, extensions or MCP servers (D46). It cannot select a disclosure entry. It cannot hide one. Naming `skill` fails with `mode_tool_not_selectable`. The narrowing step sees `kernel.selectable()` only (D63). An unknown fragment name fails at load with `mode_prompt_unavailable`. Switching is one protocol call (`mode.set`). The Host loads the list at the request. It applies the list at once when no round runs. Otherwise it applies the list when that round ends. Naming the mode in use withdraws a pending switch (D41, D65). A `mode` event enters the record only when the list differs from the last one recorded. A client that attaches to read must not write.

Skills come from four directories in this order: `<project root>/.ligule/skills/`, `<project root>/.agents/skills/`, `~/.ligule/skills/`, `~/.agents/skills/` (D45, D57). A directory holding `SKILL.md` is one root. It is not searched deeper. A repeated name keeps the highest. It reports the ignored path. The model gets one tool, `skill`, with `search`, `activate` and `read`. `read` is bounded to that skill's own directory (D50). Names and descriptions are inlined while they fit the metadata budget. They are then replaced by one sentence telling the model to search (D55). `activate` refuses instructions whose `metadata.ligule-requires` names a capability this run does not offer (D56). Loading a skill registers no tool. It loosens no decision (D51). Nothing on disk adds neither the tool nor the fragment (D12). `ligule skills` shows what this directory would load. It shows why anything was dropped. No protocol method grows for it (D64).

Prompt templates live in `<project root>/.ligule/prompts/` and `~/.ligule/prompts/`. They are found recursively, the project one winning. The relative path is the command name. `git/release/prepare.md` is `/git:release:prepare`. There is no `name` field to drift (D45). Expansion happens only in the Host (D54). It covers `$ARGUMENTS` and `$1`–`$9`. Arguments split on shell quoting. An unbalanced quote is refused with `template_arguments_unbalanced`. Both placeholder forms are replaced in one pass. That one user event keeps the expanded `text` plus `raw`, `arguments`, `source` and `digest`. `session.modelView()` reads `text`. Provenance never reaches the model. Every client draws `raw`. A line whose first word has the shape of a command is an invocation. An unknown name is refused with `template_unknown` naming what is loaded.

An extension is one ESM file whose default export is a function. The host calls it with one frozen object holding exactly `registerTool`, `registerPrompt`, `onEvent`, `request` (D37, D69). Sources are `~/.ligule/extensions/*.js` sorted, plus paths written in the user layer or the command line. A project or local layer entry is refused with `extension_source_ignored`. A repository does not decide what code this process runs (D68). One failing extension undoes its own registrations. It reports its path. Loading continues. A throwing event handler is contained the same way (`extension_handler_failed`). `request()` runs through `kernel.call`. The chain, argument validation and the record apply as they do to a model call. Extensions load only when a session is really built. Modes select prompt fragments by name: `prompt = [...]` or `"*"`. `applyMode` narrows the model-visible list. It hands back the undo for its own narrowing.

## External capabilities

`fetch` is a first-party optional tool. The registry holds it. `minimal` hides it. `full` offers it (D48). It issues GET over http(s). It sends no cookie, no custom header and no credential this machine already holds. It times out at 15 seconds. It reads at most 64 KB. The target is judged by the address it resolves to. That address is classified from its bytes. `::ffff:127.0.0.1` and `::ffff:7f00:1` are one loopback. `::`, `0.0.0.0` and multicast land in a reserved class. Link-local, metadata endpoints and reserved addresses are refused. Loopback and private ranges must be asked at least once. Public ones follow the normal order (D58). Resolution happens once. The socket binds to the approved address. The hostname stays in the `Host` header, the TLS SNI and certificate verification. Every redirect is rebuilt, re-resolved, re-classified and re-judged. Only a same-origin hop continues. A changed host or port raises `fetch_redirect_denied`.

MCP is stdio only, over the official TypeScript SDK (D52, D60, D70). A server is `command` plus `args`. A `command` containing whitespace that is not a path on disk raises `mcp_command_invalid`. `env` values are exactly `${NAME}`. A literal credential is refused. An unset variable stays unset. The model sees `mcp.inspect` and `mcp.call`. Both are disclosure entries no mode can select. Neither is registered when no server is configured. `mcp.call` first asks whether this version was read (`mcp_not_disclosed`). It then asks whether it is still the version offered (`mcp_definition_stale`). Every lookup re-runs `tools/list`. Arguments travel as one JSON string. The host validates them against the declaration the server sent. The chain, the guards and the approval prompt see `mcp:<server>/<tool>`, never `mcp.call`. The server's own `readOnlyHint` and `destructiveHint` are untrusted. They grant no pass. Closing a server kills its process tree. `close()` alone left a test child alive for about 90 seconds.

`subagent` is a first-party plugin tool, not a kernel concept (D61, D71). The derived agent runs a second loop in this process with its own kernel and its own record. The decision chain is the parent's instance. A child can never sit at a looser level than the run that spawned it. Only one level exists. The child's assembly is the parent's plugin list, which has no `subagent` in it. Its record is `<parent id>.sub-<n>.jsonl` beside the parent's. Model-visible parameters are `task` and an optional `mode`. A name no layer holds fails with `mode_unknown`. A run with no mode directories fails with `subagent_mode_paths_required`. The parent receives the child's text, its session id and the record path. One child at a time. The concurrency field is untouched (D29). The tool registers only when a session is built. `ligule tools` counts nine. A branch is read with the existing action (D74): see Reading a record below.

`exec` runs under the backend the host chose (D59). `exec.shell` takes `auto`, `bash` or `powershell`. `auto` on Windows tries `pwsh`, then the built-in `powershell`, then Git Bash. On POSIX it tries `/bin/bash`, then `bash` on `PATH`, then `sh`. Probing starts no process. Known locations are stat-ed. Bare names are searched directory by directory. A named backend this machine lacks raises `exec_shell_unavailable` and lists what was searched. The other grammar is never substituted. The kernel resolves the backend once per call. It hands the same object to the chain and the tool. The record carries `{kind, executable, segments}`. PowerShell auto-approval covers a literal command with literal arguments only (D66). `|`, sub-expressions, script blocks, splatting, the invocation operator, redirects, comments, reserved declaration forms, non-ASCII or `$`/backtick-bearing arguments and any parse error all fall back to asking. Two platform facts the shape depends on were measured on Windows 11 with Windows PowerShell 5.1 on 2026-10-04. First: `-Command` returns 1 for any failing native command. The real code stays in `$LASTEXITCODE`. Second: a failing cmdlet leaves `$LASTEXITCODE` alone. Appending `; exit $LASTEXITCODE` unconditionally reads a failure as the previous native command's code. `Get-Process -Name nope` answers 1 without the tail and 0 with it. The kernel appends it only when the chain read the whole line as one simple command whose name is an executable on `PATH` or a known location. That name is tried with each `PATHEXT` extension. `withNativeExitCode` decides. The record carries the tail. A path with no chain gets none. Prefer the missing code over the masked failure. Quoted arguments passed to a native command lose `<` and `>`. That is why the exec tests run a temporary script file rather than `node -e`.

Two wire shapes reach the endpoint (D13, D31). `model.api` names which one. Only that adapter builds the body. Each declares a capability ceiling: `streaming`, `parallelToolCalls`, `maxOutputTokens`, plus `streamUsage` for Chat Completions. A config may lower it but never raise it. An undeclared name raises `provider_capability_unknown`. `streamUsage` decides whether a streaming request asks for the usage line. That family reports tokens only when the body carries `stream_options:{include_usage:true}`. A proxy that rejects it turns the flag off. The compaction pressure line falls back to the local count. Messages reports usage in `message_start` (input, cache reads included) and `message_delta` (output). Both adapters emit one normalized `{type:'usage', input, output}` event at the end of a stream. Local estimation counts the complete request including `system`, `tools` and `messages`; usage records identify this estimate as `request-v1` (D86). They emit nothing when no numbers arrived.

## Listing and resuming

`ligule sessions` reads the record directory and lists past runs. It builds no kernel, loads no extension and opens no session (D73). The first line gives the project and the start time. The last `mode` event gives the list the run used. A dispatched call with no result is counted, so a half-finished session shows itself in the listing. `--json` is for scripts. `--project <root>` filters by that first line. A record whose project cannot be read belongs to no project. Measured on this machine on 2026-10-05: 100, 1000 and 5000 records scan in 28, 199 and 956 ms. The scan is whole-file reads, linear. That is why no index exists yet. The same rows reach a client over `sessions.list`. No surface reads that directory itself. `projectRoot` and `limit` are both optional there.

`ligule resume <id> <text>` runs one round against an existing record. Which mode list it uses is decided by the Host when it opens that record (D78). The last one that took effect there continues. A list whose content changed on disk is refused with `resume_mode_changed` naming both digests. A client that names a mode wins over both. It names one with `--mode` on the command line, the `mode` argument of `session.open` or `<id> <name>` in the terminal. Falling back to the shipped `minimal` would choose the tool surface for someone who already chose one. No path takes it silently. The comparison happens in that one place. A client passes a name rather than computing a second answer.

`ligule tools`, `ligule skills` and `ligule extensions` are the read-only entries for what a run would load. None of them imports extension code or starts a model call.

## Reading a record

`session.read` returns the record of an open session, and for a session that is not open it returns only its own `<open id>.sub-<n>` branch (D74). Listing past sessions is `sessions.list` for a client and `ligule sessions` for a person; taking over another session is `session.open`. A session id becomes a file name, so an id with a path separator, a colon, a NUL byte or the shape `..` is refused with `session_id_invalid` before anything touches the directory, and a missing record is `session_not_found`.

## Session record

A record is append-only JSONL. Its first line is not an event: `{kind: 'session', formatVersion, sessionId, projectRoot, createdAt, mode?}` (D73). A proper-lockfile lock directory protects each writable session across processes; the lease is stale after 10 seconds and is updated every 2 seconds (D85). Reading returns complete lines and reports the incomplete tail without changing the file. The writable path acquires the lock before repairing that tail, then continues numbering after the last complete event. A `formatVersion` newer than this build raises `session_version_unsupported`. A header line anywhere but first raises `session_header_position`. An event kind this build never writes raises `session_event_unsupported` unless the event carries `ignorable`. `ignorable` is the only way to add an informational kind without breaking older readers. The kinds this build writes are `session`, `user`, `reasoning`, `assistant`, `tool`, `mode` and `usage`. `usage` carries `ignorable` and is still kept here. Skipping it would leave a hole in a checkpoint's covered range and void a file that still matches (D82). A record written before the header existed reads as version 0. It never receives one afterwards. The header has no sequence number. Events start at 0. A reopened log numbers on from the last sequence it read. That is what keeps a crash's half-line from producing two events with the same number. The tail may be an incomplete UTF-8 sequence.

A checkpoint is a separate file beside it, `<id>.checkpoint.json` (D75). It carries the covered `fromSeq` and `toSeq`, the sha256 of that segment, the summary text, the format version of the file and the version of the canonical hash input. Before projecting, the covered segment is re-hashed from the events. Any mismatch voids the whole file. The projection rebuilds from the raw log. The cases are a newer format version, another input version, a range with a hole, another session's id, an empty text and one changed byte inside the range. Each case names its own reason. A broken derived file never stops a run. The log is the source of truth (I5).

The hash input is a positional whitelist of the fields that rebuild a request: `seq`, kind, and for a tool call its name and arguments, for a tool result its name, failure flag, code and content. A call id, a spill filename, a verdict field or a key this build does not know does not move it, while a real content change always does.

Compaction never edits the log. It starts at the previous kept boundary and feeds the earlier summary into the excerpt. The summary text shares the injection cap of tool output (`limits.resultBytes`); over the cap it spills to a file and the checkpoint keeps the reference. Neither a compaction nor a checkpoint carries disclosure state (D76): a resumed run inspects its definitions again and calls `skill.activate` again, while inside one run the kernel keeps what it already disclosed, because that state belongs to the process.

Compaction has two triggers, plus one manual call. It stays off until `limits.contextTokens` is written. The ratios (0.8, 0.16) are strategy and have defaults. The window size is a fact about the model and is not guessed. A window read too large also sizes the summary request and can make it overflow. Pressure: after the loop assembles a request, the host counts it locally (bytes over 4). The host multiplies that count by a factor taken from the endpoint's reported usage. It compares the result against `contextTokens × compactThresholdRatio`. An uncorrected local count reports low, so the line would never trigger. Length: only after an endpoint answers `provider_http_error` with text about the window does the run compact once and retry once. A second such answer, a failure about something else, or a segment with nothing left to cut leaves the original error in charge. The cut lands on a `user` or `assistant` event. A cut on a tool result would strand the call above it. A summary that is not smaller than the segment it replaces is never written. That compaction would only trade history for a longer header. `session.compact` then reports `compact_nothing_to_cut`.

Reported usage is one record event, not a memory value (D82): `{kind:'usage', ignorable:true, input, output, estimated}`. `estimated` is the local count of the same request. That is what lets a reopened session start with the same factor instead of 1. `status.get` reports it under `usage`: window, threshold, retained budget, current estimate, factor, last reported pair. A surface can show pressure before an endpoint refuses. The kind is in `WRITTEN_KINDS`. `ignorable` lets an older build skip it. Skipping leaves a hole in a checkpoint's range. This build keeps it and its sequence number. `session.compact` is the manual path (D83). It refuses while a round runs (`compact_turn_running`). It refuses without a window (`compact_window_unset`). Otherwise it compacts once and returns the boundary. `/compact` is its only terminal entry.

Reopening through the writable path (`session.open`) closes the open tail: each assistant turn carrying a call with no result gets one appended — `kind: 'tool'`, `failed`, code `tool_outcome_unknown`, the call id and arguments, plus `recovery` naming the turn it repairs — so the next request body stays valid and the model reads the fact the host read. Reading the record again adds nothing, which is the whole idempotence argument; `session.read`, the listing and the interface report the gap and never write (D72).

Cancelling a running round signals the child's own process group on POSIX (`killTree` in `src/capability/exec.js`). On Windows, a guardian joins a Job Object configured with `KILL_ON_JOB_CLOSE` before it starts the actual shell. It reports the shell's exit code over native IPC. Cancelling terminates the guardian; if the host dies and disconnects, the guardian closes the Job Object as it exits. Windows process ownership and cancellation follow D87. If the host dies abnormally, recovery records `tool_outcome_unknown` and never replays the call (D72, D79).

A tool may declare `readOnly`. It is kernel-side only, never model-visible, and has no effect on the decision chain (I3). That one bit chooses the sentence: read-only says run it again if needed; anything else says look at the current state first (D79).

Every call the chain judged leaves one field in its tool record (D77): `{capability, decision, via, level, rule?, answer?, forced?}`. That field names the capability the chain used (`mcp:<server>/<tool>`, not `mcp.call`). It names whether it was allowed, asked or refused. It names the level in force (`auto`, `ask`, `auto→ask` when the denial threshold forced it). It names the rule that matched. The kernel copies only the fields listed in `VERDICT_FIELDS`. A call with no chain has no such field. The summary invents none. The field is not model-visible (D12). It does not enter the checkpoint hash. `ligule policy <session-id>` reads one record. It counts, per capability, calls allowed without asking, asked and refused, with the rules hit and the codes returned. `--json` gives the structured form. No counter lives in the kernel. That is why the numbers survive the run and can be re-derived.

## Interfaces

`src/host/` carries the protocol (D30). `protocol.js` names the operations and their argument shapes in the same subset the kernel validates. `connection.js` moves one message per line. `host.js` owns the sessions. It reaches the loop through what a host may inject anyway: the provider, the ask channel, the session log. A new carrier adds a file beside `connection.js`. It changes neither the table nor the kernel. The Host keeps session authority. A client that disconnects loses nothing. A second process opens the same record. An approval for a command line carries the shell kind and the executable (D67). A call with no command text carries neither. That keeps the request the same shape on both carriers.

`src/tui/` is the second client (D33).

- It starts a Host in its own process and joins the two with the in-memory carrier (`src/host/memory.js`), so it reads frames exactly as the shell does. It imports `host/`, React and Ink — never a kernel private interface.
- `ink` and `react` are optional dependencies: `ligule tui` reports `tui_dependency_missing` without them, every other command works.
- Ink throws rather than degrades when stdin cannot do raw mode, so `App` takes an `interactive` flag and the command refuses a non-terminal with `tui_terminal_required`.
- Committed rows live in `Static`, which prints only rows past its own index. `/show <seq>` and `/sub <seq>` therefore redraw into the dynamic area, keyed by the record's sequence number, not a screen line (D40, D65).
- `Static` is keyed by the session id: switching records replaces the whole row list, and without that key the new transcript paints nothing. This is also what made the `/new` notice invisible once the old transcript had rows.
- `src/tui/commands.ts` is the UI command table: name, description, argument hint, and whether the command works while a round runs (D81).
- A slash line not in that table goes to `run.start` unchanged, which is how a prompt template reaches the terminal. Expansion lives in the Host (D24, D49), so the UI must not claim the prefix.
- Typing `/` lists candidates: UI table first, Host-reported templates after; Tab completes, arrows select, Esc hides for that draft. `/help` flows three groups by terminal columns, padding by display width (one Chinese character takes two).
- `src/tui/markdown.ts` parses Markdown with `marked` and highlights fenced code with `highlight.js`. Tables and code highlighting are implemented (D84).
- A tool result names what it did in its header — the capability a `mcp.call` used, an `exec` exit code, a spilled file — and the body shows `content.text`, not the envelope.
- The approval box sums the proposed change from the arguments (lines in, lines replaced) instead of dumping a file.
- Input typed during a round queues in the UI, flushes in order when the round ends (an interrupt counts as ending it), and returns to the draft on Backspace. The queue enters no record (D81).
- The status line names mode and policy separately, adds `ctx:~estimated/window` only when a window is configured, and drops `tools:` then that segment when the terminal is narrow.
- `/sessions` presents what `sessions.list` returns with keyboard selection: write time to the second, the whole id, event count, last mode in force, unanswered dispatches, and the current one marked. `/resume <id> [mode]` opens one. An id prefix resolves only when exactly one session of this project root starts with it.
- `/mode [name]` sends `mode.set`; a switch asked for while a round runs reads `mode:a→b` until that round ends (D41, D65).
- Input history is the UI's own file (`~/.ligule/tui-history.jsonl`): one sentence per line, newest first, one place per sentence, 200 lines, only sentences actually sent. Saves are queued within the process, merge concurrent snapshots, and use unique temporary files before replacement. The arrow keys and Ctrl+R read it.
- Ctrl+G writes the draft to a temporary file, runs `$VISUAL` when set or `$EDITOR` otherwise through `cross-spawn` and Ink's terminal suspension, then reads back what the editor wrote.
- Ctrl+O opens a complete-history browser with paging, Home/End navigation, line selection, copy and close controls. It reads full spill files through `session.read` with `fullResults: true`. Approval Ctrl+O displays or hides the actual change; Esc cancels the current operation.
- `/copy` takes the last assistant sentence out of `session.read` to the machine's clipboard program. On Windows that program is `clip` and it takes UTF-16LE without a BOM (UTF-8 arrives as another string of characters; a BOM stays in the paste).
- `/export <path>` writes the record as markdown: one section per sentence and one per call and result, using the record's own sequence numbers. Each delegation branch goes through the same `session.read` and becomes its own file (D74).
- The terminal title carries model, project root and session id. C0, DEL, C1 and bidi controls are stripped before it is written.
- History, drafts, the queue, folds and the caret are UI state: none of them reaches the record (D81).

`desktop/` is the Tauri shell. Rust opens the window, starts the Node host and moves one line per frame each way. `frontend/` is a Vite project (React, TypeScript) built by `npm run build` into `dist/`. Tauri embeds that directory. Rust names no protocol method, event or error code. `desktop/src-tauri/Cargo.toml` carries no serialization, HTTP or WebSocket dependency. Interface content registers into a declared slot in `desktop/frontend/src/slots.ts` instead of editing the render path. `src/main.tsx` reads `window.__LIGULE_TRANSPORT__` when a page sets one. That is how the browser check drives it without a shell. `desktop/` stays outside `package.json#files`.

The installer carries its own runtime (D34). `node desktop/fetch-runtime.mjs` vendors the pinned `node.exe`, the built `dist/` tree, production dependencies and installed transitive optional dependencies into `desktop/vendor/`. This includes platform native packages when installed and omits unrelated root optional dependencies such as the terminal UI packages. That directory is never committed. `bundle.resources` mounts them as `node/` and `app/`. The shell looks for the backend in this order: `LIGULE_DESKTOP_CLI`, the bundled `app/dist/cli.js`, then `dist/cli.js` walking up from the executable. It prefers the bundled node over `NODE` and `PATH`.

## Parameter schemas

Tool parameter schemas use a subset: at the root `type` (`object`), `properties`, `required`, `description`; on a leaf `type` (`string`, `integer`, `number`, `boolean`), `description`, `minimum`, `maximum`. Registration rejects anything else and names every violation. The kernel validates arguments before the chain runs. A full external JSON Schema needs an adapter that reduces it to this subset (D14).

## Configuration

Configuration arrives in layers: `~/.ligule/config.toml`, `<project root>/.ligule/config.toml`, `<project root>/.ligule/config.local.toml`, then `--config key.path=value`. The layers fold into one frozen snapshot (D8). Only plain tables merge recursively. Arrays and scalars replace whole. A TOML datetime is a class instance. A higher layer replaces it for that reason. The project layer can come from someone else's repository. That is why a `__proto__` key in any layer is refused (`config_key_unsafe`). Credentials never come from files. Every key in a config layer is readable by tools. A key comes from the environment (`LIGULE_API_KEY`, renamed by `model.apiKeyEnv`) instead.

Tools read the snapshot the kernel passes them and log through the injected interface (`debug` and `log` required, `error` optional). Nothing under `src/` writes to an output sink directly, and a host that injects no logger gets no output.

Sections the layers can set: `model` (`api`, `baseURL`, `model`, `apiKeyEnv`, `capabilities`, `retry`), `mode`, `policy` (`mode`, `rules`, `thresholds`), `loop` (`iterations`, `modelCalls`), `limits` (`readBytes`, `resultBytes`, `resultCount`, `scanBytes`, `scanFiles`, `execBytes`, `trashDirectory`, `skillSearchBytes`, `skillBodyBytes`, `skillFileBytes`, `fetchBytes`, `fetchTimeoutMs`, `fetchRedirects`, `promptFragmentBytes`, `contextTokens`, `compactThresholdRatio`, `compactRetainRatio`), `exec.shell`, `instructions`, `mcp.servers`, `extensions`, `host.sessionDirectory`. `contextTokens` has no default and gates compaction (D75).

## Dependencies and search

Runtime and optional dependencies are listed in `package.json`. In addition to the earlier runtime dependencies, `cross-spawn` launches external editors, `proper-lockfile` protects session writes across processes (D85), and `koffi` calls the Windows Job Object API (D87). Optional `marked` and `highlight.js` provide terminal Markdown rendering and code highlighting (D84); `string-width` supports terminal display width.

`tree-sitter`, `tree-sitter-bash` and `tree-sitter-pwsh` are native addons. All three ship prebuilds for six platform and architecture combinations. That is why no compiler runs. npm blocking their install script does not matter. The bash grammar loads lazily through `createRequire`. The PowerShell one is an ESM graph with a top-level await. `require` refuses it. Only a dynamic `import` works. Its `main` names a directory without an extension. It loads from `bindings/node/index.js`. A parser that cannot load leaves the chain asking every time. It says so in the reason. `scripts/check-pack.js` parses one command line with each grammar through the installed package. A missing addon would otherwise look like a machine that asks a lot.

`packages/rg-*` hold no committed binaries. `npm run build-rg` downloads the ripgrep version pinned in `scripts/ripgrep-pin.json`. It checks size and sha256. It writes the executable plus licence texts there. An unpublished name cannot enter the lockfile. `npm ci` refuses a `package.json` the lockfile does not cover. That is why the two entries stay out of `optionalDependencies` until publish. Until then search walks the tree and the two comparison tests skip. `ci.yml` runs `npm run build-rg` before `npm test`. That lets both platforms compare the real backend with our own walk. Nothing resolves `rg` from `PATH`. A bare `ripgrepPath` resolves as a relative path and fails. The download branch has not run anywhere yet. Its first result is a CI log.

## Release

Bump `package.json` and `VERSION` together, then tag `vX.Y.Z` on `main`. The tag drives the publish workflow. That workflow runs `npm run build-rg` and publishes the two ripgrep platform packages before the main one. The first publish cannot use npm Trusted Publishing. npm requires the package to exist before a trusted publisher binds to it. Publish `0.0.1` with a token, configure the publisher, then let the workflow take over. The account has 2FA. A direct `npm publish` asks a one-time password. Run it interactively or pass `--otp`. Tokens that bypass 2FA are being restricted for direct publishing. Do not reach for one. OIDC publishing is not affected by 2FA.

`npm ci` installs from the lockfile in both workflows.

## Verify

`npm run check-pack` packs, unpacks, checks every entry `package.json` points at, then imports the package from an empty consumer directory. It copies the transitive closure of `dependencies` and installed optional dependencies from that closure, including native platform packages, while leaving unrelated root optional dependencies out. It refuses when a declared runtime dependency is missing. Copying all of `node_modules` would hide a tarball short at runtime. The first devDependency, `@modelcontextprotocol/server-filesystem`, is the test MCP server and stays out of the consumer. It refuses before packing when `dist/` is missing. Build first. `npm test` exercises the same `dist/`. That is why it cannot see a file missing from `files` or an `exports` entry the tarball lacks. Invoke the script through npm. On Windows Node refuses to launch `npm.cmd` without a shell. The script needs `npm_execpath` for that reason.

`npm test` reports `skipped 2` when no ripgrep has been built locally; those two compare the real backend with our own tree walk and cannot be faked.

Real endpoint checks read credentials from the process environment and inspect the persisted record. Credentials are never written into repository files.

The shell's checks sit outside `npm test`. `cd desktop/src-tauri && cargo test` covers finding the backend entry and moving frames through the child's pipes. Window verification uses the actual shell and host; frontend build checks run TypeScript and Vite.

The terminal interaction checks use the actual Host, provider adapter, local HTTP endpoint and Ink keyboard handling. Fixtures are repository files under `test/fixtures`; pure projections are checked separately. `ligule tui` runs the same component in a terminal.
