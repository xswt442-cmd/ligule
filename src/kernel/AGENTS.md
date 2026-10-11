# Kernel

Rules for `src/kernel/`: the tool table, decision chain, loop, prompt assembly, slot registry, assembly list, mode loader, result shapes, config, log and error codes. The repository-wide rules in [../../AGENTS.md](../../AGENTS.md) apply here too; this file states what only this directory has to keep.

## Data root

- `dataRoot()` in `config-file.js` is the one place that builds the per-user directory (D110). Nothing under `src/kernel/` joins `.ligule` onto the home directory by hand, and the tests take a home parameter the same way the loaders do.
- An absolute `LIGULE_HOME` wins. A blank one reads as unset, and a relative one fails with `data_root_invalid` — the root never moves with the working directory.
- The user config layer, `modes/`, `skills/`, `prompts/` and `extensions/` are read under it. `~/.agents/skills/` and everything under the project boundary keep their own anchors.
- 桌面偏好保存在 `<data root>/desktop.json`。`readPrefs` 返回完整文档及其 SHA-256 版本；文件不存在时返回空文档与空版本。`savePrefs` 在跨进程锁内比较传入版本，拒绝格式错误或超限的文档，再原子替换文件并保留原权限；新文件权限为 `0600`。

## Workspaces

- A workspace is one real directory (D110). Its identity is that directory, not a spelling of it: `workspaceIdentity()` resolves, follows what the platform resolves the path to, folds Windows drive letters and case, and drops trailing separators. Same-directory aliases give one identity, so nothing registers or caches them twice.
- The registry is `<data root>/workspaces.json` (`registryPathOf`): a version, the default selection, and one entry per identity carrying the directory, the display name, the time it was first seen and the time it was last seen. Registering a known identity updates the last-seen time and the name, and never adds a second row.
- Registering is one read-modify-write, so it holds a `proper-lockfile` lease (5-second stale, `workspace_registry_locked` when it cannot be had) and writes through a randomly named `wx` stand-in removed in a `finally`: two hosts on one machine keep both rows and leave no file behind. Tests run under a per-process fake home (`test/hooks/isolated-data-root.mjs`, `--import` in `npm test`) for that reason — an injected `userHome` must keep working, so the hook moves the home, not `LIGULE_HOME`.
- Recency drops nothing. A client's list is a reader of this file; closing a panel removes no workspace (D110, 方案 5.5.1).
- `setDefaultWorkspace()` writes the default selection and nothing else: it registers that directory first, so the stored identity always names a row that exists, and `null` clears the selection while keeping every row. `registerWorkspace()` never touches that field.
- A file that cannot be parsed is `workspace_registry_invalid`, and a version this build cannot read is `workspace_registry_version`. Neither reads as an empty registry: an empty answer would lose the list.
- `workspace_directory_required` refuses an empty argument. A directory that is not there still gets an absolute identity — whether a working directory exists is decided where it is loaded, not here.

## Input history

- `<data root>/tui-history.jsonl` (`src/kernel/input-history.ts`: `historyPathOf`, `pushHistory`, `loadHistory`, `rememberHistory`, `flushHistory`) is the one history both interfaces write (方案 5.5.6): one JSON-encoded sentence per line, newest first, at most 200 lines, only sentences that were actually sent. It is not part of any session record and never reaches a model request. The name says `tui` while both interfaces share that one file: a machine that already has a history must keep reading it. Over the client protocol these are `history.read` (the whole list) and `history.append` (one sentence that was sent, answered with the list after the write).
- A save rewrites the whole file through a randomly named `wx` stand-in removed in a `finally`, inside a `proper-lockfile` lease (5-second stale, `input_history_locked` naming the file when it cannot be had). It names only the sentences this call added: inside the lease the base is what the file holds at that moment, the new sentences go in front of it, and the limit drops the oldest. A caller's own older snapshot reinserted as the base would push another surface newest sentence behind its own and, at the limit, drop the other surface off the file entirely. `rememberHistory` answers with the list as written and that is the list the interface shows — the Host returns it from `history.append`, the terminal client adopts it.
- `input_history_invalid` names the line that cannot be read; a file that is not there is an empty history, not an error. The terminal's own filter over these lines (`SEARCH_ROWS`, `searchHistory`) stays in `src/tui/history.ts`, since it is a screen concern.

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

- `model-services.ts` 验证 `model.services` 服务清单及 `model.selection` 默认选择；单服务的四个字段继续可读。服务含稳定编号、显示名、接口类型、地址、凭据引用及模型列表，拒绝未知字段和重复编号。
- `config-edit.ts` 使用原版 `toml-eslint-parser` 取得 TOML 1.1 节点与跨度，`smol-toml` 验证完整语义。受管服务值内部有注释或使用不支持的节点形状时拒绝替换并保留原文。
- `credentials.ts` 延迟加载 `@napi-rs/keyring`。非空环境变量优先；系统账户按应用数据根与凭据引用隔离。Linux 显式选择持久化 Secret Service，不静默回退。密钥不进入配置、会话、导出或日志。

- Two wire shapes reach the endpoint (D13, D31), and `model.api` names which one. Only that adapter builds the body.
- Each shape declares a capability ceiling: `streaming`, `parallelToolCalls`, `maxOutputTokens`, plus `streamUsage` for Chat Completions. A config may lower it but never raise it, and an undeclared name raises `provider_capability_unknown`.
- `streamUsage` decides whether a streaming request asks for the usage line. That family reports tokens only when the body carries `stream_options:{include_usage:true}`, so a proxy that rejects it turns the flag off and the compaction pressure line falls back to the local count.
- Messages reports usage in `message_start` (input, cache reads included) and `message_delta` (output). Both adapters emit one normalized `{type:'usage', input, output}` event at the end of a stream, and emit nothing when no numbers arrived.
- Local estimation counts the complete request including `system`, `tools` and `messages`, and usage records identify this estimate as `request-v1` (D86).

