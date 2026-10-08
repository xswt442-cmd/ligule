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
- The kinds this build writes are `session`, `user`, `reasoning`, `assistant`, `tool`, `mode`, `usage`, `turn`, `label` and `turnContext`. `usage`, `turn`, `label` and `turnContext` carry `ignorable` and are still kept in that list: an ignorable kind is skipped by the reader, so a kind a screen has to show must be listed here as well — skipping one leaves a gap in the sequence numbers `session.read` returns (D82, D104).
- A `turn` event is written only when a round finished normally, and carries the user event that started it. Cancelled, failed, budget-exhausted and recovery-ended rounds write none. It is the branch point an interface offers, is not model-visible and takes no part in the checkpoint hash (D12, D75).
- A record written before the header existed reads as version 0 and never receives one afterwards. The header has no sequence number, events start at 0, and a reopened log numbers on from the last sequence it read. That is what keeps a crash's half-line from producing two events with the same number. The tail may be an incomplete UTF-8 sequence.
- Reopening through the writable path (`session.open`) closes the open tail: each assistant turn carrying a call with no result gets one appended — `kind: 'tool'`, `failed`, code `tool_outcome_unknown`, the call id and arguments, plus `recovery` naming the turn it repairs (D72). Reading the record again adds nothing, which is the whole idempotence argument. `session.read`, the listing and the interfaces report the gap and never write.
- A tool may declare `readOnly`. It is kernel-side only, never model-visible, and has no effect on the decision chain (I3). That one bit chooses the sentence a recovery writes: read-only says run it again if needed, anything else says look at the current state first (D79).
- Cancelling a running round signals the child's own process group on POSIX (`killTree` in `src/capability/exec.js`). On Windows a guardian joins a Job Object configured with `KILL_ON_JOB_CLOSE` before it starts the shell, reports the shell's exit code over native IPC, and cancelling terminates the guardian (D87).
- If the host dies abnormally, recovery records `tool_outcome_unknown` and never replays the call (D72, D79).
- A tool result carries `durationMs` outside the result: the monotonic clock around that tool's own run, so waiting for an approval is not counted (D94). A call that never ran (refused, malformed, skipped) and one appended by recovery carry no such field. The value is not model-visible and does not move the checkpoint hash, which is built from a positional whitelist of the fields that rebuild a request.
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
- The cut lands on a `user` or `assistant` event; a cut on a tool result would strand the call above it. The retained budget and the "must actually shrink" guard count only the events that reach the model, so reasoning, mode, usage and turn events take up none of it. A summary that is not smaller than the segment it replaces is never written, and `session.compact` then reports `compact_nothing_to_cut`.
- Reported usage is one record event, not a memory value (D82): `{kind:'usage', ignorable:true, input, output, estimated}`. `estimated` is the local count of the same request, which is what lets a reopened session start with the same factor instead of 1.
- The parameters a round ran on are one record event written right after that round's input (D104): `{kind:'turnContext', ignorable:true, userSeq, model, api, apiKeyEnv?, policy, policySource, mode?, modeDigest?}`. One per accepted input, so a round with several internal loops still keeps one. It never enters the model request or the checkpoint input. `status.get` answers what is in use and what waits at the boundary; this event answers what past rounds used, which is the reading a person needs after a mid-round change (U54).
- `status.get` reports the window, threshold, retained budget, current estimate, factor and last reported pair, so a surface can show pressure before an endpoint refuses.
- `session.compact` is the manual path (D83). It refuses while a round runs (`compact_turn_running`) and without a window (`compact_window_unset`), otherwise it compacts once and returns the boundary. `/compact` is its only terminal entry.

## Listing and resuming

- `ligule sessions` reads the record directory and lists past runs. It builds no kernel, loads no extension and opens no session (D73).
- The first line gives the project and the start time, the last `mode` event gives the list the run used, and a dispatched call with no result is counted, so a half-finished session shows itself in the listing.
- `--json` is for scripts and `--project <root>` filters by that first line. A record whose project cannot be read belongs to no project.
- The scan reads whole files, so its cost grows linearly with the number of records and no index exists yet (U38).
- The same rows reach a client over `sessions.list`, where `projectRoot` and `limit` are both optional. No surface reads that directory itself.
- `sessions.search` takes one non-blank query and answers which record each hit is in plus that event's `seq`, so a surface opens the record and jumps to that line. A blank query matches every record, so it is refused as `search_query_empty` before anything is scanned (方案 4.2).
- What a search reads is what a record holds inline: what a person and the model wrote, a call's arguments, a result's body, a refusal reason, and the name from a `label`. A record the scan cannot read is left out rather than reported twice, because that listing row already carries its code. A derived branch (`<parent>.sub-<n>`) is not searched either: nothing can resume it, so a hit there would be a line with no way to open it.
- One record gives at most three hits and the answer at most `limit` (50 by default), because a common phrase occurs hundreds of times in a long session. A hit taken from a spilled result names that file, and a search across sessions does not open it: the middle of a long result stays outside that one search (U38).
- Naming `sessionId` searches that one record and reads those spilled files too — a search inside one session has to reach the whole result (方案 4.2). Such a file is opened only when its name has the shape the kernel writes (`result-<毫秒>-8 位十六进制.json`), because that name comes out of a record and must not build a path leaving the directory. A record asks one hit per event, and the text the record keeps itself wins.
- A name and the archived flag are `label` events in the record, written by `session.label`: a later label replaces only the fact it names, so archiving keeps the name. The scan folds them into `name` and `archived`, which is why both surfaces show one answer.
- A name is trimmed, holds 1–120 characters and carries no control character, else `session_name_invalid`; a call naming neither fact is `session_label_empty`. Archiving changes only how the listing sorts and dims a row — the record stays openable, and un-archiving is the same call.
- `label` is ignorable and never projected: an older build skips it, and it is absent from the model request and from the checkpoint input.
- `ligule resume <id> <text>` runs one round against an existing record. The Host decides which mode list it uses when it opens that record, and the last one that took effect there continues (D78).
- A list whose content changed on disk is refused with `resume_mode_changed` naming both digests. A client that names a mode wins over both, and names one with `--mode`, the `mode` argument of `session.open`, or `<id> <name>` in the terminal.
- Falling back to the shipped `minimal` would choose the tool surface for someone who already chose one, so no path takes it silently. The comparison happens in that one place, and a client passes a name rather than computing a second answer.
- `ligule tools`, `ligule skills` and `ligule extensions` are the read-only entries for what a run would load. None of them imports extension code or starts a model call.

## Reading a record

- `session.read` returns the record of an open session, and for a session that is not open it returns only its own `<open id>.sub-<n>` branch (D74).
- `session.open` refuses a branch id with `session_is_branch` and names its parent: a derived record has no surface that resumes it, and opening one would keep writing on a record nobody answers for.
- A history page is asked for with `limit` and `before` (D73, 方案 4.1). `before` is the sequence number of an event in that record — stable and increasing — so walking back never repeats or skips events while new ones append at the end. Every read answers `endSeq`, the end of the snapshot it stopped at, and `hasMore`, whether older events remain. A cursor that names no event in that record is `session_cursor_invalid`, not a quiet first page. Spilled results are read only for the events a page returned.
- Listing past sessions is `sessions.list` for a client and `ligule sessions` for a person, searching them is `sessions.search`, taking over another session is `session.open`, and copying one into a new session is `session.branch`.
- A session id becomes a file name, so an id with a path separator, a colon, a NUL byte or the shape `..` is refused with `session_id_invalid` before anything touches the directory, and a missing record is `session_not_found`.
- `session.branch` copies the raw lines of a record into a new session and writes nothing to the parent: events another build marked ignorable, and fields it added, carry over, and sequence numbers continue (D73). The first line is not copied — the new record writes its own, carrying `branchOf` and `branchAt`, neither of which reaches a model request.
- The cut is the end of the record as it stands, which the Host fixes itself when the call names no `at`, or a `turn` marker whose status is `completed`. An `at` naming anything else is `session_branch_point_unavailable`: a guessed branch point is worse than none, and a record that proves no round boundary still takes the whole-record entry (方案 4.3).
- The copy goes to `<id>.jsonl.tmp` and is renamed, so a half-written branch cannot show up in a listing. A dispatch the parent left unanswered comes over as it stands and is settled when the branch is first opened, under the branch's own assembly and record lock — the branch step writes no synthetic facts and touches no parent lock (D72, D85).
- A branch copies neither a checkpoint nor a spilled result file. The copied events name the same `result-*.json`, and no path in `src/` deletes those files, so that reference cannot dangle; a checkpoint names the session it belongs to, so the branch rebuilds its projection from its own record (D75).
- Branching is not filesystem isolation: a branch of a session in one project shares that project's files. It runs no Git operation.

## Host and protocol

- `src/host/` carries the protocol (D30). `protocol.js` names the operations and their argument shapes in the same subset the kernel validates, `connection.js` moves one message per line, and `host.js` owns the sessions.
- The table holds seventeen methods: `session.create`, `session.open`, `session.close`, `session.label`, `session.branch`, `sessions.list`, `sessions.search`, `session.read`, `run.start`, `run.cancel`, `status.get`, `config.get`, `config.set`, `mode.set`, `policy.set`, `session.compact`, `paths.list`. Eleven exist only because an interface asked (`mode.set`, `policy.set`, `session.compact`, `sessions.list`, `sessions.search`, `config.get`, `config.set`, `session.close`, `session.label`, `session.branch`, `paths.list`).
- `config.get` answers with four fields the host builds by name: `model.api`, `model.baseURL`, `model.model`, `model.apiKeyEnv`. A value has to be a string to be shown, and the address keeps only its scheme, host, port and path. The answer carries two more fields: `layers` — the version and existence of each writable settings file, which is what a save has to send back — and `sources`, naming which of the four loaded layers writes each shown field (方案 7.1, D8).
- The boundary is that fixed construction, not argument checking: the parameter subset lets through keys it does not declare. The merge accepts any key a config layer writes, so handing over the whole snapshot would prove nothing about what a frame carries (D8, D13, D60).
- The Host reaches the loop through what a host may inject anyway: the provider, the ask channel, the session log. A new carrier adds a file beside `connection.js` and changes neither the table nor the kernel.
- A project environment is one project's config snapshot, provider, policy, mode directories, extension sources, MCP servers and session directory. The Host loads one per project root, keeps it, and a session reads that environment rather than the one the Host started on.
- `session.create` and `session.open` name that project in an optional `projectRoot`. A Host without a loader answers `host_project_root_unsupported`, and a loader whose layers give a different root answers `host_project_root_mismatch` — neither falls back to reading another project through the current one (D73, 方案 3.2).
- `sessions.list` and `sessions.search` scan the directory of the environment they can reach, through one place that decides it. A root that is not loaded yet, on a Host with no loader, is filtered against the current directory instead: reading the records on disk does not force a load.
- `paths.list` walks a project with the file tool's own traversal, so candidates arrive in the order the model sees when it lists a directory. Only regular files enter: a link is neither followed nor offered, which is what keeps a link pointing outside the boundary from widening what an interface can show. `.git`, `node_modules`, `dist` and `.ligule/sessions` are skipped, one answer is capped at 4000 files walked and `limit` entries (20 by default, 50 at most), and `stopped` names the reason a list is not the whole truth — `budget` when the walk stopped early, `unreadable` when one directory could not be read. An empty list with no such word is the only case that may read as nothing matching (方案 5.3).
- A saved generation choice is adopted at each session's own boundary: an idle session switches now, a running one switches after that round ends and before its next input is accepted (方案 7.3). `config.set` answers `applies` — one entry per session, `now` or `round` — and keeps the two facts of a save apart when rebuilding the provider fails: the file version landed, and no session adopted it (`failure`). Inside one round the loop, compaction and the derived executor read the same provider: each holds one forward (`currentProvider`) that resolves when it is called, so a round cannot send two request bodies to two endpoints. `status.get` carries `model` and `pendingModel`, which is what lets a screen name the saved default, the value in use and the one waiting at the boundary separately. A session opened later inherits the last adopted provider, while `config.get` keeps reporting the launch-time snapshot — what was loaded stays a fact (D8).
- `config.get` reads the project the Host was launched on, because that method names no session.
- `config.set` takes `field`, `layer` and `version`, plus `value` for a one-line field, plus `op`, `index` and the four rule cells (`ruleTool`, `ruleDecision`, `ruleMatch`, `ruleReason`) for the rule table. None of them is a path. The Host owns the field list (`EDITABLE` in `src/kernel/config-edit.ts`: the four model fields, `policy.mode`, `policy.rules`) and the layer-to-file table (`src/kernel/config-store.ts`: the user defaults and this project's local override are writable, the project-shared `config.toml`, the command line and the managed layer are not; the startup side hands the four loaded layers in, so `sources` can name which one a value came from and a write can update it). A field the command line wrote cannot be overridden by a file: that write still lands, the answer says `shadowed: true` with an empty `applies`, and no session adopts it (D8, 方案 7.1). The write replaces only the span of that one value inside the file's own text, so comments, key order and each line's ending survive; a shape that span cannot be read on one line (array, inline table, unterminated quote) is refused with `config_edit_shape_unsupported` and the file is not touched. Before landing, the whole edited text is parsed and that key is read back: a mismatch writes nothing. For the rule table the same span logic works one array-table block at a time (D100): `add` puts a new `[[policy.rules]]` block at the end of that table (before the comments attached to the next header), `update` replaces only the keys one rule carries and deletes the optional key it no longer carries, `remove` drops that block together with the comment lines sitting on top of it. Verification compares the whole table, not one item. A one-line key added to a table that so far exists only as `[[table.sub]]` is written before those blocks, never after them — declaring `[table]` after its array of tables is not valid TOML, and a reader would take the key to belong to the block above. Because a rule table replaces rather than merges (D8), a write aimed at a layer that does not hold the table in effect is refused with `config_rules_elsewhere` — an `index` means a position in the file being written, and pointing at another layer would edit a different table than the one on screen. `write_atomically` means a temporary file plus a rename, keeping the mode of a file that already existed. Compare and replace happen inside one held lock, so an edit made by another process or by the person's own editor surfaces as `config_version_stale` instead of being overwritten (方案 7.2, D8, D13). A Host launched without that store answers `layers: []` and refuses the write with `config_write_unsupported`; `ligule host` is the one entry that carries it, because the settings panel is the only surface that saves. That surface is 模型与端点: one 改 per field, a layer choice, a preview line naming the old and the new value, and the save sends back the version the panel had read (方案 7.2). The rule table and the configured default tier are the 审批规则 section, and a save there adopts the `layers` the answer carries — the next write needs the version that file now has, otherwise the panel's own second save reads as someone else's edit.
- The Host keeps session authority. A client that disconnects loses nothing, and a second process opens the same record.
- `session.close` releases one session's assembly — the MCP servers, the extension listeners, the template assembly and the record lock — and writes nothing to the record. A round that runs is not interrupted by it: the client sends `run.cancel` first, and the Host answers `run_already_running`.
- Waiting for that round is not inheriting its failure. A cancelled or broken round already left its facts in the record; the release path drops its rejection instead of reporting a release failure.
- Closing the last session of a loaded project drops that project environment; the next session of the same root loads the layers again. The project the Host launched on stays.
- An approval for a command line carries the shell kind and the executable (D67), and a call with no command text carries neither. That keeps the request the same shape on both carriers.
- An approval belongs to the session that asked, not to the one an interface is showing. A round that waits on an unanswered approval keeps waiting when the person opens another session, so switching shows that ask and answering it reaches its own round by request id (D16).
- A round that ends — answered through or cancelled — settles only its own session's approvals. Replacing the Host process settles every one of them.

## Terminal client

`src/tui/` is the second client (D33).

- It starts a Host in its own process and joins the two with the in-memory carrier (`src/host/memory.js`). It imports `host/`, React and Ink — never a kernel private interface.
- `ink` and `react` are optional dependencies: `ligule tui` reports `tui_dependency_missing` without them, and every other command works.
- Ink throws when stdin cannot do raw mode, so `App` takes an `interactive` flag and the command refuses a non-terminal with `tui_terminal_required`.
- Committed rows live in `Static`, which prints only rows past its own index, so `/show <seq>` and `/sub <seq>` redraw into the dynamic area keyed by the record's sequence number rather than a screen line (D40, D65). `Static` is keyed by the session id, so switching records replaces the whole row list.
- `src/tui/commands.ts` is the UI command table: name, description, argument hint, and whether the command works while a round runs (D81). A slash line not in that table goes to `run.start` unchanged, which is how a prompt template reaches the terminal; expansion lives in the Host (D49), so the UI must not claim the prefix.
- Typing `/` lists candidates: UI table first, Host-reported templates after. Tab completes, arrows select, Esc hides for that draft, and `/help` pads by display width (one Chinese character takes two).
- `src/tui/keymap.ts` is the terminal's binding table: action id, default key spec, the view that action belongs to, and one sentence. Dispatch asks `hit(action, input, key)`; every key name printed on screen — `/help`, both popups, the approval and history footers, the placeholder, the status line — is built from that table by `formatKeys` and `keyHint`. A hint therefore cannot claim a key dispatch does not honour. Two actions sharing a key inside one view is a conflict (`conflictsIn`) and the defaults assert none; one key landing in two views is the design, since Enter sends in the draft and picks in the candidate list (方案 6.1). A personal override lives in `~/.ligule/tui-keys.json`, read and written through the startup side so the interface names no path, and `/bind` is its only entry: it lists the current table, rebinds one action, resets one or all, and refuses a key that would land two actions in the same view instead of saving a table it cannot press.
- Typing `@` asks `paths.list` 160 ms after the typing stops and shows what the Host answered: relative paths, the project root from that answer, and one line when the walk was capped or a directory unreadable. Enter or Tab inserts the picked path and moves the caret instead of sending; while that answer is pending both keys do nothing, and with no candidate at all Enter sends the sentence. Esc hides that one word until it changes. A fragment typed there is text in the draft: it starts no tool call and writes nothing to the record (D81, 方案 5.3).
- `src/tui/markdown.ts` parses Markdown with `marked` and highlights fenced code with `highlight.js` (D84).
- A tool result names what it did in its header — the capability a `mcp.call` used, an `exec` exit code, a spilled file — and the body shows `content.text`, not the envelope. The approval box instead names the action and shows the two blocks it replaces: `describeChange` reads the arguments and returns the action, the block to remove and the block to put in, and the box marks those lines with `-` and `+`. A whole-file write gets no removed block — nothing was read, and the action sentence says a write onto an existing file is an overwrite the kernel requires reading first; a delete gets the action sentence only; arguments without a path get no invented object, and the box falls back to the arguments, which is what every other tool shows there. Paging (Ctrl+O) reads the marked blocks on past their first screen (方案 5.4).
- History, drafts, the queue, folds and the caret are UI state: none of them reaches the record (D81).
- Input typed during a round queues in the UI, flushes in order when the round ends, and returns to the draft on Backspace. Cancelling the round pauses that queue: nothing left sends until `/queue continue`, and `/queue drop <序号>` / `/queue clear` hand the text back to the draft instead of throwing it away — with a non-empty draft they refuse rather than merge two sentences (D81, 方案 5.2). A queue belongs to the session it was typed in, so switching puts it away and takes back the one that session has.
- A round the person interrupted reads 这一轮已被打断 whichever code the kernel answered with: an abort landing on a live model call reports `provider_cancelled`, between two call groups `loop_cancelled`. Both surfaces say it the same way (方案 5.2).
- A whole paste arrives on Ink's own paste channel, which switches the terminal to bracketed paste while it is open. The block goes into the draft as text, so newlines inside it start no round and a `y` inside it answers no approval (方案 5.1, 5.4).
- The draft steps back a unit at a time: Ctrl+Z restores the previous draft and caret, Ctrl+Y takes that unit back. A unit is one run of characters typed at the end — `isTypingRun` decides it from the two states alone — so one press drops a phrase rather than a glyph, while a typed space, a mid-draft insertion, a pasted block, a backspace and a word delete each stand on their own. Two stacks of 100 snapshots, holding nothing but draft and caret, living in this process: what survives an exit is the draft and the queue, not the undo history (方案 6.1, D81 边界二). Replacing the whole draft — switching session, reading back what was kept, sending — clears both stacks, so Ctrl+Z cannot drag another session's draft into view. The desktop names no key for this: its composer is a `<textarea>`, and the browser's own undo and redo already cover it.
- The status line names mode and policy separately, and adds `ctx:~estimated/window` only when a window is configured. A narrow terminal yields in one order — the project path shortens to its last segment, then `tools:`, then the context segment, then the model name, then the whole path, then the record count — so mode, the policy tier with its `(会话)` mark, and the interrupt hint always survive.
- `/sessions` lists what `sessions.list` returns with keyboard selection, and `/resume <id> [mode]` opens one; an id prefix resolves only when exactly one session of this project root starts with it. `/find <文字>` prints one line per hit, each naming the id prefix `/resume` takes and the `seq` `/show` takes; it asks twice — once across the project's records and once naming the record it is in, so that one group reaches whole spilled results while the other reads only what the records keep. Switching closes the session it left, so one terminal holds one assembly and one record lock. `/name <文字>`, `/archive` and `/unarchive` write the session's own facts through `session.label` and read the answer back from the Host. `/mode [name]` sends `mode.set`, and a switch asked for while a round runs reads `mode:a→b` (D41, D65). `/policy [ask|auto|reset]` sends `policy.set`: the tier a session overrides lives only in that session's chain, the settings file keeps the default, and the status line marks an override with `(会话)`.
- `/branch [序号]` copies the record and takes over what it wrote, on the same path `/resume` uses: naming no sequence sends no `at`, and a sequence the terminal cannot read as an integer is refused there instead of becoming a request (方案 4.3). It is unavailable while a round runs, because switching carries the person away from that round's events.
- The session id and the transcript rows change in the same render. `Static` decides by index which rows it still has to print, so an `await` between those two state updates loses the resumed record off the screen.
- Input history is the UI's own file (`~/.ligule/tui-history.jsonl`): one sentence per line, newest first, one place per sentence, 200 lines, only sentences actually sent. The arrow keys and Ctrl+R read it.
- A draft that was never sent and the sentences still queued live in `~/.ligule/tui-input.jsonl`, one line per session keyed by project root and session id (D81, 方案 5.1). The write is throttled 400 ms after the last keystroke and the exit waits for whatever is in flight; a line the reader cannot parse is skipped, because this file is a convenience, not a source of fact. Queued sentences come back paused (方案 5.2). Both operations are handed in from the startup side, so the interface never names a path.
- Ctrl+G writes the draft to a temporary file, runs `$VISUAL` or `$EDITOR` through `cross-spawn` and Ink's terminal suspension, then reads the file back.
- Ctrl+O opens a complete-history browser with paging, Home/End navigation, line selection and copy; it reads full spill files through `session.read` with `fullResults: true`. Approval Ctrl+O displays or hides the actual change, and Esc cancels the current operation.
- `/copy` hands the last assistant sentence to the machine's clipboard program: on Windows that is `clip`, and it takes UTF-16LE without a BOM. `/export <path>` writes the record as markdown, one section per sentence and one per call and result, and each delegation branch becomes its own file through the same `session.read` (D74).
- The terminal title carries model, project root and session id, with C0, DEL, C1 and bidi controls stripped first. The startup side writes an empty title on the way out, in the same cleanup that flushes history, drafts and key overrides, so a tab whose process has gone stops claiming to be this program; a stdout that no longer accepts the write does not hold up releasing the host.

## Desktop

- `desktop/` is the Tauri shell. Rust opens the window, starts the Node host and moves one line per frame each way. `frontend/` is a Vite project (React, TypeScript) built by `npm run build` into `dist/`, and Tauri embeds that directory.
- Rust names no protocol method, event or error code, and `desktop/src-tauri/Cargo.toml` carries no serialization, HTTP or WebSocket dependency.
- The shell has four commands: `host_send`, `host_stop`, `host_restart`, `app_quit`. `host_restart` runs the same start path, which hands back the previous child and terminates it, so only one process ever writes frames into the window. Which session to take back is the interface's decision, carried by `session.open` (D30).
- Interface content registers into a declared slot in `desktop/frontend/src/slots.ts` instead of editing the render path. `src/main.tsx` reads `window.__LIGULE_TRANSPORT__` when a page sets one, which is how the browser check drives it without a shell.
- The desktop transcript holds only the pages it read: the first `session.read` asks for the newest page, and 「显示更早」 asks for the page before that cursor. The whole record stays on the Host side.
- Only the rows inside the viewport are in the DOM (`react-virtuoso`). A prepended page shifts the viewport's first index by the number of rows added, so the row being read stays where it was.
- The desktop rail reads those two fields: a name becomes that row's title, an archived session sinks below its group and dims — it is not hidden, so it stays openable and un-archivable. The desktop writes no label yet; the naming entry there belongs with the dialog work.
- The display tier chooses which kinds of row enter that list (`shownIn`), rather than hiding rows with CSS: the viewport measures every row it is given, and a row hidden by style measures as nothing (D90, U48).
- Every transcript row carries the sequence number of the record event it was projected from, so a search hit names a row that exists; rows the interface writes itself carry none.
- The row at the top of the viewport is remembered per session, by that sequence number. Opening that session again lands there when the row is inside the page in hand; otherwise the view stays at the end — reading pages or widening the display tier just to restore a position is not done, and a position that cannot land writes nothing to the transcript.
- A page that arrives after the person switched away is dropped: it changes neither the rows nor the cursor, so an older answer cannot land in another session's transcript (方案 6.2).
- The rail's search box asks `sessions.search` once the typing settles (300 ms) and re-asks on Enter, which is also the retry handle when the answer fails. A 「只看这一份」 chip names the record that session is writing, and that read reaches the spilled files. A hit opens its session and lands on its row: that read walks back pages until the event is in hand, and hands the rows and the landing target over in one batch, because a `scrollToIndex` issued in the frame after the data grows loses to the viewport sticking at its last row. Landing remounts the viewport at that row (D97 scale aside, this is the `react-virtuoso` mount-time position) and marks that row for 2.5 s.
- A hit whose row the display tier filters out raises the tier to `detailed` and lands; a hit with no row at all — a `label` — says so in the transcript instead of waiting for a jump that never comes.
- The composer behaves like the terminal's: a sentence typed while a round runs joins that session's queue (UI state, never the record) and shows in a band above the input with 收回 per item and 全部收回 for the band; the send button reads 排到后面 there. Cancelling pauses the band, and 继续 is a separate press. Items are keyed per session, so another session's queue neither shows nor sends here (方案 5.2).
- Which session a running round belongs to is interface state, and there can be more than one at a time: the composer, the 取消 handle, the 「这一轮结束」 row, the draft that comes back after a lost request and `status.get`'s answer all belong to that round's own session, so a background session finishing neither sends another session's queued sentence nor paints in this one's transcript. The top bar says how many *other* sessions are running, and the rail marks a session that is running or that ended a round while it was not being looked at (方案 3.1、5.2).
- The rail can list a second project directory, typed into its own box and kept in `projects` inside `ligule.ui` — the interface's storage, never the configuration file, so it enters no model context and no project business config (D90). A session's record, lock and tool directory follow the root that session names on `session.open` or `session.create`; roots are compared by position, so the same directory spelled differently is one project (方案 3.2).- `desktop/frontend/src/hotkeys.ts` is that surface's binding table in the same shape as the terminal's: an action id, its default key spec, the view it lands in (window, composer, candidate list), and one sentence. `actionOf(event, view)` decides what a press does, and the palette notes, button titles, the composer placeholder and the 快捷键 panel are built from the same table instead of naming a key twice (方案 6.1). Cmd and Ctrl are one modifier here, because the shell runs on Windows and the carrier reports both. Personal overrides live in the `keys` table of `ligule.ui` and the settings dialog's 键位 section edits them: the next key pressed becomes that action's key, Esc cancels the capture, and while a capture is open the window layer takes no global key at all. A rebinding that would land two actions in one view is refused and named, and never reaches storage.
- The same `@` rule reaches the other surface: `desktop/frontend/src/mentions.ts` holds the two judgements the terminal's `commands.ts` holds, and the band above the input draws the Host's answer with an 插入 button per row. Its project line names the root that answer carried rather than the one the interface remembers, since a session that has not read its record header knows no root.
- The draft and the queued sentences are saved under the same `ligule.ui` key in two tables keyed by the project root the record header names, then by session id (D90, 方案 5.1). A session that has nothing left to keep drops out of both tables instead of leaving an empty row; a save that the machine's storage refuses says so once in the transcript, because the text is still on screen and must not read as saved.
- While an input method is composing, Enter commits the candidate, arrows walk the candidates and Esc cancels the word — so those three reach no interface action: no send, no history walk, no panel close, no cancelled round. The check reads `isComposing` and the keyCode 229 that browsers keep after `compositionend`, in one place (`hotkeys.ts`) that both the composer and the window layer call (方案 5.1, 5.4).
- The approval card's expandable body derives the same three fields in `desktop/frontend/src/rows.ts` (`changeOf`, `changeBody`) from the same rule the terminal follows, so the summary line and the `-`/`+` blocks cannot disagree. Its header names the project that call will touch: `approval.request` carries that root with the ask, so a card for a session that is not the one on screen names its own project rather than none (方案 5.4).
- Answering an approval moves focus off the button that took the press, since Enter on a focused button presses it again — one way a decision can land that nobody made. A round that ends with its own session still holding unanswered asks adds a row saying how many and that they settled as 不允许; before that the column simply went quiet, which read as though nothing had been asked.
- Reconnecting after the Host was killed waits out the dead writer's lease instead of failing. That lease expires within ten seconds (`SESSION_LOCK_STALE_MS`), and a 重连 pressed inside the window used to end with 那份会话接不上：session_locked and the banner still up — which also read, wrongly, as if Enter had never reached the button. The interface now retries the open once a second for up to twelve seconds and only then leaves the failure on screen, and the in-flight flag clears on every path so one failed press cannot block the next. `session.acquire` itself still answers `session_locked` at once: two live windows reaching for one record should hear that immediately rather than after a wait.
- Only a `turn` event whose status is `completed` becomes a row, and that row is the one carrying 「从这里分支」; the number it hands over is that event's own `seq`, the same one the rows were stamped with. The palette's 「分支这一份会话」 sends no `at`, which is the whole-record copy. Both entries then land on the new session and tell the rail to re-read the directory, because that record is the one the Host just wrote (方案 4.3).
- `desktop/frontend/package.json` is the frontend's own list and never joins the npm package. `react-virtuoso` is pinned exactly, which costs about 61 kB in the bundle (19 kB gzipped).
- `desktop/` stays outside `package.json#files`.
- The installer carries its own runtime (D34). `node desktop/fetch-runtime.mjs` vendors the pinned `node.exe`, the built `dist/` tree, production dependencies and installed transitive optional dependencies into `desktop/vendor/`. This includes platform native packages when installed and omits unrelated root optional dependencies such as the terminal UI packages. That directory is never committed, and `bundle.resources` mounts them as `node/` and `app/`.
- The shell looks for the backend in this order: `LIGULE_DESKTOP_CLI`, the bundled `app/dist/cli.js`, then `dist/cli.js` walking up from the executable. It prefers the bundled node over `NODE` and `PATH`.

## Configuration

- Configuration arrives in layers: `~/.ligule/config.toml`, `<project root>/.ligule/config.toml`, `<project root>/.ligule/config.local.toml`, then `--config key.path=value`. The layers fold into one frozen snapshot (D8).
- Only plain tables merge recursively; arrays and scalars replace whole. A TOML datetime is a class instance, and a higher layer replaces it for that reason.
- The project layer can come from someone else's repository, which is why a `__proto__` key in any layer is refused (`config_key_unsafe`).
- Credentials never come from files. Every key in a config layer is readable by tools, so a key comes from the environment instead (`LIGULE_API_KEY`, renamed by `model.apiKeyEnv`).
- Tools read the snapshot the kernel passes them and log through the injected interface (`debug` and `log` required, `error` optional). Nothing under `src/` writes to an output sink directly, and a host that injects no logger gets no output.
- Sections the layers can set: `model` (`api`, `baseURL`, `model`, `apiKeyEnv`, `capabilities`, `retry`), `mode`, `policy` (`mode`, `rules`, `thresholds`), `loop` (`iterations`, `modelCalls`), `limits` (`readBytes`, `resultBytes`, `resultCount`, `scanBytes`, `scanFiles`, `execBytes`, `trashDirectory`, `skillSearchBytes`, `skillBodyBytes`, `skillFileBytes`, `fetchBytes`, `fetchTimeoutMs`, `fetchRedirects`, `promptFragmentBytes`, `contextTokens`, `compactThresholdRatio`, `compactRetainRatio`), `exec.shell`, `prompt` (`static`; when no layer writes it the shipped base prompt in `src/kernel/base-prompt.ts` supplies the static segment — D102), `instructions`, `mcp.servers`, `extensions`, `host.sessionDirectory`.
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
