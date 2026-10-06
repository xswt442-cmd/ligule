# Agent guide

`ligule` is an agent harness under development. The 0.0.x line is a placeholder: the repository, the package name and the licence are claimed; the behaviour is not settled.

Design records, decisions (D) and open questions (U) live outside this repository and are not linked from here. This file states the rules a change inside this repository has to keep.

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

- Dependencies point toward `kernel/`, never away from it.
- `test/architecture.test.js` scans those directories instead of a hand-written list, so a new file is covered without anyone adding it.
- Platform-specific code belongs in `capability/` (D18).

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
- Every failure carries a stable code (`KernelError#code`). `KernelError` is a tool that did not finish, and the loop continues with that result. `KernelRuntimeError` is the kernel itself failing, and the loop stops.
- An error without a code becomes `tool_failed`, and the original goes into `cause`. The code serves the host, `detail` serves the model, and the CLI prints both.
- Every dispatched call gets an answer in the record, including one the loop chose not to run (`tool_skipped`). A missing answer invalidates every later request body.

## Build and files

- `dist/` is what runs: `bin`, `exports` and `files` point there, and the tests import it, so a green run exercised the shipped bytes.
- `tsc` runs with `allowJs` and `checkJs: false`. New modules are TypeScript under `strict`, with erasable syntax only — no `enum`, no `namespace`, no parameter properties (D47). Older JavaScript files are copied through and convert layer by layer.
- `src/` is not runnable as it stands: a `.ts` module has no `.js` twin.
- `package.json#version` and `src/index.js#VERSION` stay equal; `test/kernel.test.js` asserts it.
- The Node floor is one number written in three kinds of place: `engines.node`, the badge in `README.md`, `PRIMARY_NODE_VERSION` in each workflow. `test/runtime-version.test.js` reads all of them and asserts they agree.

## Modes

- A mode is a named assembly list (D35, D43): one TOML per mode, found in `modes/`, then `~/.ligule/modes/<name>.toml`, then `<project root>/.ligule/modes/<name>.toml`.
- The highest hit wins whole. Nothing merges across layers.
- Both fields — `tools` and `prompt` — are required, an empty list included.
- `run`, `tui` and `host` choose with `--mode <name>` over the config key `mode`, defaulting to `minimal`. `tools` and `call` read none (D44).
- A mode narrows the registry and selects prompt fragments by name. It cannot name skills, extensions or MCP servers (D46).
- A mode cannot select a disclosure entry and cannot hide one. Naming `skill` fails with `mode_tool_not_selectable`, and the narrowing step sees `kernel.selectable()` only (D63).
- An unknown fragment name fails at load with `mode_prompt_unavailable`.
- Switching is one protocol call (`mode.set`). The Host loads the list at the request and applies it at once when no round runs, otherwise when that round ends (D41, D65).
- Naming the mode in use withdraws a pending switch.
- A `mode` event enters the record only when the list differs from the last one recorded. A client that attaches to read must not write.

## Skills

- Skills come from four directories in this order: `<project root>/.ligule/skills/`, `<project root>/.agents/skills/`, `~/.ligule/skills/`, `~/.agents/skills/` (D45, D57).
- A directory holding `SKILL.md` is one root. It is not searched deeper.
- A repeated name keeps the highest and reports the ignored path.
- The model gets one tool, `skill`, with `search`, `activate` and `read`. `read` is bounded to that skill's own directory (D50).
- Names and descriptions are inlined while they fit the metadata budget, then replaced by one sentence telling the model to search (D55).
- `activate` refuses instructions whose `metadata.ligule-requires` names a capability this run does not offer (D56).
- Loading a skill registers no tool and loosens no decision (D51). Nothing on disk adds the tool or the fragment (D12).
- `ligule skills` shows what this directory would load and why anything was dropped. No protocol method grows for it (D64).

## Prompt templates

- Templates live in `<project root>/.ligule/prompts/` and `~/.ligule/prompts/`, found recursively, the project one winning (D45).
- The relative path is the command name, so `git/release/prepare.md` is `/git:release:prepare`. There is no `name` field to drift.
- Expansion happens only in the Host (D54). It covers `$ARGUMENTS` and `$1`–`$9`, and arguments split on shell quoting. An unbalanced quote is refused with `template_arguments_unbalanced`.
- Both placeholder forms are replaced in one pass.
- That one user event keeps the expanded `text` plus `raw`, `arguments`, `source` and `digest`. `session.modelView()` reads `text`, so provenance never reaches the model, and every client draws `raw`.
- A line whose first word has the shape of a command is an invocation. An unknown name is refused with `template_unknown` naming what is loaded.

## Extensions

- An extension is one ESM file whose default export is a function. The host calls it with one frozen object holding exactly `registerTool`, `registerPrompt`, `onEvent`, `request` (D37, D69).
- Sources are `~/.ligule/extensions/*.js` sorted, plus paths written in the user layer or the command line.
- A project or local layer entry is refused with `extension_source_ignored`. A repository does not decide what code this process runs (D68).
- One failing extension undoes its own registrations, reports its path, and loading continues. A throwing event handler is contained the same way (`extension_handler_failed`).
- `request()` runs through `kernel.call`, so the chain, argument validation and the record apply as they do to a model call.
- Extensions load only when a session is really built.

## Parameter schemas

- Tool parameter schemas use a subset: at the root `type` (`object`), `properties`, `required`, `description`; on a leaf `type` (`string`, `integer`, `number`, `boolean`), `description`, `minimum`, `maximum`.
- Registration rejects anything else and names every violation. The kernel validates arguments before the chain runs.
- A full external JSON Schema needs an adapter that reduces it to this subset (D14).

## Optional first-party tools

`fetch` is a first-party optional tool: the registry holds it, `minimal` hides it, `full` offers it (D48).

- It issues GET over http(s), times out at 15 seconds and reads at most 64 KB. It sends no cookie, no custom header and no credential this machine already holds.
- The target is judged by the address it resolves to, and that address is classified from its bytes. `::ffff:127.0.0.1` and `::ffff:7f00:1` are one loopback, and `::`, `0.0.0.0` and multicast land in a reserved class.
- Link-local, metadata endpoints and reserved addresses are refused. Loopback and private ranges must be asked at least once. Public ones follow the normal order (D58).
- Resolution happens once and the socket binds to the approved address. The hostname stays in the `Host` header, the TLS SNI and certificate verification.
- Every redirect is rebuilt, re-resolved, re-classified and re-judged. Only a same-origin hop continues, and a changed host or port raises `fetch_redirect_denied`.

`exec` runs under the backend the host chose (D59).

- `exec.shell` takes `auto`, `bash` or `powershell`. `auto` on Windows tries `pwsh`, then the built-in `powershell`, then Git Bash. On POSIX it tries `/bin/bash`, then `bash` on `PATH`, then `sh`.
- Probing starts no process: known locations are stat-ed and bare names are searched directory by directory. A named backend this machine lacks raises `exec_shell_unavailable` and lists what was searched; the other grammar is never substituted.
- The kernel resolves the backend once per call and hands the same object to the chain and the tool. The record carries `{kind, executable, segments}`.
- PowerShell auto-approval covers a literal command with literal arguments only (D66). `|`, sub-expressions, script blocks, splatting, the invocation operator, redirects, comments, reserved declaration forms, non-ASCII or `$`/backtick-bearing arguments and any parse error all fall back to asking.
- Two Windows PowerShell 5.1 facts shape this: `-Command` returns 1 for any failing native command while the real code stays in `$LASTEXITCODE`, and a failing cmdlet leaves `$LASTEXITCODE` alone. Appending `; exit $LASTEXITCODE` unconditionally therefore reads a cmdlet failure as the previous native command's code.
- The kernel appends that tail only when the chain read the whole line as one simple command whose name is an executable on `PATH` or a known location. `withNativeExitCode` decides, and the record carries the tail. A path with no chain gets none: the missing code is preferred over the masked failure.
- Quoted arguments passed to a native command lose `<` and `>`, so the exec tests run a temporary script file rather than `node -e`.

`subagent` is a first-party plugin tool, not a kernel concept (D61, D71).

- The derived agent runs a second loop in this process with its own kernel and its own record. The decision chain is the parent's instance, so a child can never sit at a looser level than the run that spawned it.
- Only one level exists. The child's assembly is the parent's plugin list, which has no `subagent` in it. Its record is `<parent id>.sub-<n>.jsonl` beside the parent's.
- Model-visible parameters are `task` and an optional `mode`. A name no layer holds fails with `mode_unknown`, and a run with no mode directories fails with `subagent_mode_paths_required`.
- The parent receives the child's text, its session id and the record path. One child at a time; the concurrency field is untouched (D29).
- The tool registers only when a session is built, so `ligule tools` counts nine. A branch is read with the existing action (D74).

## MCP

- MCP is stdio only, over the official TypeScript SDK (D52, D60, D70). A server is `command` plus `args`, and a `command` containing whitespace that is not a path on disk raises `mcp_command_invalid`.
- `env` values are exactly `${NAME}`. A literal credential is refused and an unset variable stays unset.
- The model sees `mcp.inspect` and `mcp.call`. Both are disclosure entries no mode can select, and neither is registered when no server is configured.
- `mcp.call` first asks whether this version was read (`mcp_not_disclosed`) and then whether it is still the version offered (`mcp_definition_stale`). Every lookup re-runs `tools/list`.
- Arguments travel as one JSON string, and the host validates them against the declaration the server sent.
- The chain, the guards and the approval prompt see `mcp:<server>/<tool>`, never `mcp.call`.
- The server's own `readOnlyHint` and `destructiveHint` are untrusted and grant no pass.
- Closing a server kills its process tree. The SDK's `close()` alone can leave the child alive, so the whole subtree is terminated (D18).

## Model providers

- Two wire shapes reach the endpoint (D13, D31), and `model.api` names which one. Only that adapter builds the body.
- Each shape declares a capability ceiling: `streaming`, `parallelToolCalls`, `maxOutputTokens`, plus `streamUsage` for Chat Completions. A config may lower it but never raise it, and an undeclared name raises `provider_capability_unknown`.
- `streamUsage` decides whether a streaming request asks for the usage line. That family reports tokens only when the body carries `stream_options:{include_usage:true}`, so a proxy that rejects it turns the flag off and the compaction pressure line falls back to the local count.
- Messages reports usage in `message_start` (input, cache reads included) and `message_delta` (output). Both adapters emit one normalized `{type:'usage', input, output}` event at the end of a stream, and emit nothing when no numbers arrived.
- Local estimation counts the complete request including `system`, `tools` and `messages`, and usage records identify this estimate as `request-v1` (D86).

## Session record

- A record is append-only JSONL. Its first line is not an event: `{kind: 'session', formatVersion, sessionId, projectRoot, createdAt, mode?}` (D73).
- A `proper-lockfile` lock directory protects each writable session across processes; the lease is stale after 10 seconds and is updated every 2 seconds (D85).
- Reading returns complete lines and reports the incomplete tail without changing the file. The writable path acquires the lock before repairing that tail, then continues numbering after the last complete event.
- A `formatVersion` newer than this build raises `session_version_unsupported`, and a header line anywhere but first raises `session_header_position`.
- An event kind this build never writes raises `session_event_unsupported` unless the event carries `ignorable`. `ignorable` is the only way to add an informational kind without breaking older readers.
- The kinds this build writes are `session`, `user`, `reasoning`, `assistant`, `tool`, `mode` and `usage`. `usage` carries `ignorable` and is still kept here: skipping it would leave a hole in a checkpoint's covered range and void a file that still matches (D82).
- A record written before the header existed reads as version 0 and never receives one afterwards. The header has no sequence number, events start at 0, and a reopened log numbers on from the last sequence it read. That is what keeps a crash's half-line from producing two events with the same number. The tail may be an incomplete UTF-8 sequence.
- Reopening through the writable path (`session.open`) closes the open tail: each assistant turn carrying a call with no result gets one appended — `kind: 'tool'`, `failed`, code `tool_outcome_unknown`, the call id and arguments, plus `recovery` naming the turn it repairs (D72). Reading the record again adds nothing, which is the whole idempotence argument. `session.read`, the listing and the interfaces report the gap and never write.
- A tool may declare `readOnly`. It is kernel-side only, never model-visible, and has no effect on the decision chain (I3). That one bit chooses the sentence a recovery writes: read-only says run it again if needed, anything else says look at the current state first (D79).
- Cancelling a running round signals the child's own process group on POSIX (`killTree` in `src/capability/exec.js`). On Windows a guardian joins a Job Object configured with `KILL_ON_JOB_CLOSE` before it starts the shell, reports the shell's exit code over native IPC, and cancelling terminates the guardian (D87).
- If the host dies abnormally, recovery records `tool_outcome_unknown` and never replays the call (D72, D79).
- Every call the chain judged leaves one field in its tool record (D77): `{capability, decision, via, level, rule?, answer?, forced?}`. `capability` names what the chain used, such as `mcp:<server>/<tool>`, and `level` names the tier in force (`auto`, `ask`, or `auto→ask` when the denial threshold forced it).
- The kernel copies only the fields listed in `VERDICT_FIELDS`. A call with no chain has no such field, and the summary invents none. The field is not model-visible (D12) and does not enter the checkpoint hash.
- `ligule policy <session-id>` reads one record and counts, per capability, calls allowed without asking, asked and refused, with the rules hit and the codes returned; `--json` gives the structured form. No counter lives in the kernel, which is why the numbers survive the run and can be re-derived.

## Checkpoints and compaction

- A checkpoint is a separate file beside the record, `<id>.checkpoint.json` (D75). It carries the covered `fromSeq` and `toSeq`, the sha256 of that segment, the summary text, the format version of the file and the version of the canonical hash input.
- Before projecting, the covered segment is re-hashed from the events. Any mismatch voids the whole file, and the projection rebuilds from the raw log (I5). The cases are a newer format version, another input version, a range with a hole, another session's id, an empty text and one changed byte inside the range, and each case names its own reason. A broken derived file never stops a run.
- The hash input is a positional whitelist of the fields that rebuild a request: `seq`, kind, and for a tool call its name and arguments, for a tool result its name, failure flag, code and content. A call id, a spill filename, a verdict field or a key this build does not know does not move it, while a real content change always does.
- Compaction never edits the log. It starts at the previous kept boundary and feeds the earlier summary into the excerpt. The summary text shares the injection cap of tool output (`limits.resultBytes`), and over the cap it spills to a file while the checkpoint keeps the reference.
- Neither a compaction nor a checkpoint carries disclosure state (D76): a resumed run inspects its definitions again and calls `skill.activate` again, while inside one run the kernel keeps what it already disclosed, because that state belongs to the process.
- Compaction has two triggers plus one manual call, and it stays off until `limits.contextTokens` is written. The ratios (0.8, 0.16) are strategy and have defaults; the window size is a fact about the model and is not guessed. A window read too large also sizes the summary request and can make it overflow.
- Pressure: after the loop assembles a request, the host counts it locally (bytes over 4), multiplies that by a factor taken from the endpoint's reported usage, and compares the result against `contextTokens × compactThresholdRatio`. An uncorrected local count reports low, so the line would never trigger.
- Length: only after an endpoint answers `provider_http_error` with text about the window does the run compact once and retry once. A second such answer, a failure about something else, or a segment with nothing left to cut leaves the original error in charge.
- The cut lands on a `user` or `assistant` event; a cut on a tool result would strand the call above it. A summary that is not smaller than the segment it replaces is never written, and `session.compact` then reports `compact_nothing_to_cut`.
- Reported usage is one record event, not a memory value (D82): `{kind:'usage', ignorable:true, input, output, estimated}`. `estimated` is the local count of the same request, which is what lets a reopened session start with the same factor instead of 1.
- `status.get` reports the window, threshold, retained budget, current estimate, factor and last reported pair, so a surface can show pressure before an endpoint refuses.
- `session.compact` is the manual path (D83). It refuses while a round runs (`compact_turn_running`) and without a window (`compact_window_unset`), otherwise it compacts once and returns the boundary. `/compact` is its only terminal entry.

## Listing and resuming

- `ligule sessions` reads the record directory and lists past runs. It builds no kernel, loads no extension and opens no session (D73).
- The first line gives the project and the start time, the last `mode` event gives the list the run used, and a dispatched call with no result is counted, so a half-finished session shows itself in the listing.
- `--json` is for scripts and `--project <root>` filters by that first line. A record whose project cannot be read belongs to no project.
- The scan reads whole files, so its cost grows linearly with the number of records and no index exists yet (U38).
- The same rows reach a client over `sessions.list`, where `projectRoot` and `limit` are both optional. No surface reads that directory itself.
- `ligule resume <id> <text>` runs one round against an existing record. The Host decides which mode list it uses when it opens that record, and the last one that took effect there continues (D78).
- A list whose content changed on disk is refused with `resume_mode_changed` naming both digests. A client that names a mode wins over both, and names one with `--mode`, the `mode` argument of `session.open`, or `<id> <name>` in the terminal.
- Falling back to the shipped `minimal` would choose the tool surface for someone who already chose one, so no path takes it silently. The comparison happens in that one place, and a client passes a name rather than computing a second answer.
- `ligule tools`, `ligule skills` and `ligule extensions` are the read-only entries for what a run would load. None of them imports extension code or starts a model call.

## Reading a record

- `session.read` returns the record of an open session, and for a session that is not open it returns only its own `<open id>.sub-<n>` branch (D74).
- Listing past sessions is `sessions.list` for a client and `ligule sessions` for a person; taking over another session is `session.open`.
- A session id becomes a file name, so an id with a path separator, a colon, a NUL byte or the shape `..` is refused with `session_id_invalid` before anything touches the directory, and a missing record is `session_not_found`.

## Host and protocol

- `src/host/` carries the protocol (D30). `protocol.js` names the operations and their argument shapes in the same subset the kernel validates, `connection.js` moves one message per line, and `host.js` owns the sessions.
- The table holds ten methods: `session.create`, `session.open`, `sessions.list`, `session.read`, `run.start`, `run.cancel`, `status.get`, `config.get`, `mode.set`, `session.compact`. Four exist only because an interface asked (`mode.set`, `session.compact`, `sessions.list`, `config.get`).
- `config.get` returns the whitelist the host lists (`model.api`, `model.baseURL`, `model.model`, `model.apiKeyEnv`). It takes no argument, so a client cannot ask for another key: the merge accepts any key a config layer writes, and keeping credentials out of files is a convention rather than a block (D13, D60).
- The Host reaches the loop through what a host may inject anyway: the provider, the ask channel, the session log. A new carrier adds a file beside `connection.js` and changes neither the table nor the kernel.
- The Host keeps session authority. A client that disconnects loses nothing, and a second process opens the same record.
- An approval for a command line carries the shell kind and the executable (D67), and a call with no command text carries neither. That keeps the request the same shape on both carriers.

## Terminal client

`src/tui/` is the second client (D33).

- It starts a Host in its own process and joins the two with the in-memory carrier (`src/host/memory.js`). It imports `host/`, React and Ink — never a kernel private interface.
- `ink` and `react` are optional dependencies: `ligule tui` reports `tui_dependency_missing` without them, and every other command works.
- Ink throws when stdin cannot do raw mode, so `App` takes an `interactive` flag and the command refuses a non-terminal with `tui_terminal_required`.
- Committed rows live in `Static`, which prints only rows past its own index, so `/show <seq>` and `/sub <seq>` redraw into the dynamic area keyed by the record's sequence number rather than a screen line (D40, D65). `Static` is keyed by the session id, so switching records replaces the whole row list.
- `src/tui/commands.ts` is the UI command table: name, description, argument hint, and whether the command works while a round runs (D81). A slash line not in that table goes to `run.start` unchanged, which is how a prompt template reaches the terminal; expansion lives in the Host (D49), so the UI must not claim the prefix.
- Typing `/` lists candidates: UI table first, Host-reported templates after. Tab completes, arrows select, Esc hides for that draft, and `/help` pads by display width (one Chinese character takes two).
- `src/tui/markdown.ts` parses Markdown with `marked` and highlights fenced code with `highlight.js` (D84).
- A tool result names what it did in its header — the capability a `mcp.call` used, an `exec` exit code, a spilled file — and the body shows `content.text`, not the envelope. The approval box sums the proposed change from the arguments instead of dumping a file.
- Input typed during a round queues in the UI, flushes in order when the round ends, and returns to the draft on Backspace. History, drafts, the queue, folds and the caret are UI state: none of them reaches the record (D81).
- The status line names mode and policy separately, adds `ctx:~estimated/window` only when a window is configured, and drops `tools:` then that segment when the terminal is narrow.
- `/sessions` lists what `sessions.list` returns with keyboard selection, and `/resume <id> [mode]` opens one; an id prefix resolves only when exactly one session of this project root starts with it. `/mode [name]` sends `mode.set`, and a switch asked for while a round runs reads `mode:a→b` (D41, D65).
- Input history is the UI's own file (`~/.ligule/tui-history.jsonl`): one sentence per line, newest first, one place per sentence, 200 lines, only sentences actually sent. The arrow keys and Ctrl+R read it.
- Ctrl+G writes the draft to a temporary file, runs `$VISUAL` or `$EDITOR` through `cross-spawn` and Ink's terminal suspension, then reads the file back.
- Ctrl+O opens a complete-history browser with paging, Home/End navigation, line selection and copy; it reads full spill files through `session.read` with `fullResults: true`. Approval Ctrl+O displays or hides the actual change, and Esc cancels the current operation.
- `/copy` hands the last assistant sentence to the machine's clipboard program: on Windows that is `clip`, and it takes UTF-16LE without a BOM. `/export <path>` writes the record as markdown, one section per sentence and one per call and result, and each delegation branch becomes its own file through the same `session.read` (D74).
- The terminal title carries model, project root and session id, with C0, DEL, C1 and bidi controls stripped first.

## Desktop

- `desktop/` is the Tauri shell. Rust opens the window, starts the Node host and moves one line per frame each way. `frontend/` is a Vite project (React, TypeScript) built by `npm run build` into `dist/`, and Tauri embeds that directory.
- Rust names no protocol method, event or error code, and `desktop/src-tauri/Cargo.toml` carries no serialization, HTTP or WebSocket dependency.
- Interface content registers into a declared slot in `desktop/frontend/src/slots.ts` instead of editing the render path. `src/main.tsx` reads `window.__LIGULE_TRANSPORT__` when a page sets one, which is how the browser check drives it without a shell.
- `desktop/` stays outside `package.json#files`.
- The installer carries its own runtime (D34). `node desktop/fetch-runtime.mjs` vendors the pinned `node.exe`, the built `dist/` tree, production dependencies and installed transitive optional dependencies into `desktop/vendor/`. This includes platform native packages when installed and omits unrelated root optional dependencies such as the terminal UI packages. That directory is never committed, and `bundle.resources` mounts them as `node/` and `app/`.
- The shell looks for the backend in this order: `LIGULE_DESKTOP_CLI`, the bundled `app/dist/cli.js`, then `dist/cli.js` walking up from the executable. It prefers the bundled node over `NODE` and `PATH`.

## Configuration

- Configuration arrives in layers: `~/.ligule/config.toml`, `<project root>/.ligule/config.toml`, `<project root>/.ligule/config.local.toml`, then `--config key.path=value`. The layers fold into one frozen snapshot (D8).
- Only plain tables merge recursively; arrays and scalars replace whole. A TOML datetime is a class instance, and a higher layer replaces it for that reason.
- The project layer can come from someone else's repository, which is why a `__proto__` key in any layer is refused (`config_key_unsafe`).
- Credentials never come from files. Every key in a config layer is readable by tools, so a key comes from the environment instead (`LIGULE_API_KEY`, renamed by `model.apiKeyEnv`).
- Tools read the snapshot the kernel passes them and log through the injected interface (`debug` and `log` required, `error` optional). Nothing under `src/` writes to an output sink directly, and a host that injects no logger gets no output.
- Sections the layers can set: `model` (`api`, `baseURL`, `model`, `apiKeyEnv`, `capabilities`, `retry`), `mode`, `policy` (`mode`, `rules`, `thresholds`), `loop` (`iterations`, `modelCalls`), `limits` (`readBytes`, `resultBytes`, `resultCount`, `scanBytes`, `scanFiles`, `execBytes`, `trashDirectory`, `skillSearchBytes`, `skillBodyBytes`, `skillFileBytes`, `fetchBytes`, `fetchTimeoutMs`, `fetchRedirects`, `promptFragmentBytes`, `contextTokens`, `compactThresholdRatio`, `compactRetainRatio`), `exec.shell`, `instructions`, `mcp.servers`, `extensions`, `host.sessionDirectory`.
- `contextTokens` has no default and gates compaction (D75).

## Dependencies and search

- Runtime and optional dependencies are listed in `package.json`. `cross-spawn` launches external editors, `proper-lockfile` protects session writes across processes (D85), and `koffi` calls the Windows Job Object API (D87).
- Optional `marked` and `highlight.js` provide terminal Markdown rendering and code highlighting (D84), and `string-width` supports terminal display width.
- `tree-sitter`, `tree-sitter-bash` and `tree-sitter-pwsh` are native addons. All three ship prebuilds for six platform and architecture combinations, which is why no compiler runs, and npm blocking their install script does not matter.
- The bash grammar loads lazily through `createRequire`. The PowerShell one is an ESM graph with a top-level await, so `require` refuses it and only a dynamic `import` works; its `main` names a directory without an extension, and it loads from `bindings/node/index.js`.
- A parser that cannot load leaves the chain asking every time and says so in the reason. `scripts/check-pack.js` parses one command line with each grammar through the installed package, because a missing addon would otherwise look like a machine that asks a lot.
- `packages/rg-*` hold no committed binaries. `npm run build-rg` downloads the ripgrep version pinned in `scripts/ripgrep-pin.json`, checks size and sha256, and writes the executable plus licence texts there.
- An unpublished name cannot enter the lockfile, and `npm ci` refuses a `package.json` the lockfile does not cover, which is why the two entries stay out of `optionalDependencies` until publish. Until then search walks the tree and the two comparison tests skip.
- `ci.yml` runs `npm run build-rg` before `npm test`, so both platforms compare the real backend with our own walk. Nothing resolves `rg` from `PATH`: a bare `ripgrepPath` resolves as a relative path and fails.

## Release

- Bump `package.json` and `VERSION` together, then tag `vX.Y.Z` on `main`. The tag drives the publish workflow, which runs `npm run build-rg` and publishes the two ripgrep platform packages before the main one.
- The first publish cannot use npm Trusted Publishing, because npm requires the package to exist before a trusted publisher binds to it. Publish `0.0.1` with a token, configure the publisher, then let the workflow take over.
- The account has 2FA, so a direct `npm publish` asks a one-time password; run it interactively or pass `--otp`. Tokens that bypass 2FA are being restricted for direct publishing, so do not reach for one. OIDC publishing is not affected by 2FA.
- `npm ci` installs from the lockfile in both workflows.

## Verify

- `npm run check-pack` packs, unpacks, checks every entry `package.json` points at, then imports the package from an empty consumer directory. It copies the transitive closure of `dependencies` and installed optional dependencies from that closure, including native platform packages, while leaving unrelated root optional dependencies out, and it refuses when a declared runtime dependency is missing. Copying all of `node_modules` would hide a tarball short at runtime.
- It refuses before packing when `dist/` is missing. Build first.
- `npm test` exercises the same `dist/`, so it cannot see a file missing from `files` or an `exports` entry the tarball lacks. Invoke the script through npm: on Windows Node refuses to launch `npm.cmd` without a shell, and the script needs `npm_execpath` for that reason.
- The first devDependency, `@modelcontextprotocol/server-filesystem`, is the test MCP server and stays out of the consumer.
- `npm test` reports `skipped 2` when no ripgrep has been built locally; those two compare the real backend with our own tree walk and cannot be faked.
- Real endpoint checks read credentials from the process environment and inspect the persisted record. Credentials are never written into repository files.
- The shell's checks sit outside `npm test`. `cd desktop/src-tauri && cargo test` covers finding the backend entry and moving frames through the child's pipes; window verification uses the actual shell and host, and frontend build checks run TypeScript and Vite.
- The terminal interaction checks use the actual Host, provider adapter, local HTTP endpoint and Ink keyboard handling. Fixtures are repository files under `test/fixtures`, pure projections are checked separately, and `ligule tui` runs the same component in a terminal.
- The desktop frontend is checked by `npm --prefix desktop/frontend run check`: three Node assertions over the projection, the frame client and the key layer, plus `tsc --noEmit` and a Vite build. It runs against the fake host in `desktop/frontend/dev/`, which speaks the frame shapes of `src/host/protocol.js` and waits for a real interface reply before an approval proceeds.
