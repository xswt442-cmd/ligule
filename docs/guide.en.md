# ligule user guide

[简体中文](guide.zh-CN.md) · [English](guide.en.md)

ligule provides a command line, a terminal UI, and a desktop UI. All three use the same configuration and session records.

## Get started

- [Start your first conversation](#start-your-first-conversation)
- [Install and launch](#install-and-launch)
- [Workspaces and data](#workspaces-and-data)
- [Configure a model service](#configure-a-model-service)

## Daily use

- [Sessions and input](#sessions-and-input)
- [Approvals and settings](#approvals-and-settings)
- [Branches and export](#branches-and-export)

## Recovery and reference

- [Recovery and cancellation](#recovery-and-cancellation)
- [Language, appearance, and shortcuts](#language-appearance-and-shortcuts)
- [Common errors](#common-errors)

### Start your first conversation

1. Choose the CLI and TUI, or the desktop app. Install the CLI and TUI with `npm install -g ligule`; install the desktop package for your operating system and architecture.
2. Configure a model service: use “Settings → Model services” in the desktop app, or follow [Configure a model service](#configure-a-model-service) for the CLI and TUI.
3. From a project directory, run `ligule run "Review the project structure and suggest improvements"` for one turn or run `ligule` to open the TUI. In the desktop app, select a workspace, start a conversation, and send a message.

### Install and launch

The command line package requires Node.js 24 or newer. Install the CLI and TUI from npm:

```sh
npm install -g ligule
```

After installation, run `ligule --version` to check the CLI and TUI version. The desktop app uses Electron; install the package for your operating system and architecture.

From a project directory, run `ligule run "Review the project structure and suggest improvements"` to make one request. For daily use, run `ligule` to open the terminal UI or launch the installed ligule desktop app. `ligule tui` remains available as a compatibility command. The terminal UI requires an interactive terminal; use `ligule run` in scripts and pipelines.

Run `ligule --help` to list commands. `ligule sessions` lists sessions for the current project, `ligule workspaces` lists registered workspaces, and `ligule tools`, `ligule skills`, and `ligule extensions` show loaded capabilities.

### Workspaces and data

The command line and terminal UI use the current directory as the default workspace. On first launch, the desktop app creates and registers `ligule/default-workspace` under the system Documents directory. New sessions then use the selected default workspace. Add other workspaces from the desktop sidebar to view their sessions. The workspace menu can hide a sidebar entry or remove its registration. Clear the default selection first; removal is blocked while a session is running in that directory. Removing a registration leaves the project directory, files, and session records untouched. Add the workspace again to view its existing sessions.

Before loading project configuration, guides, or skills in a new directory, the terminal UI asks whether you trust it, with Exit selected by default. Trust and continue remembers that exact directory; subdirectories require their own confirmation. Use `/trust` for details or `/trust revoke` to revoke trust and exit. Trust does not approve tools or change approval rules or access boundaries. Project `AGENTS.md` files use the existing instruction loader and cannot grant system permissions. Each launch displays the Ligule mark, version, workspace, and help hint.

Each session belongs to one workspace. The terminal UI prepares a new session when it starts. The desktop app restores the last session at launch, or prepares a new one when there is no previous session. Session records are stored under `workspaces/<readable-workspace-path>--<short-hash>/sessions/` in the data root. The path label keeps workspace folders recognizable; the hash prevents different paths from colliding. The Desktop workspace menu for a new conversation has a Browse button that opens the system folder picker; you can also enter a path directly.

The default data root is `~/.ligule`. Set `LIGULE_HOME` to an absolute path to move it; a relative path returns `data_root_invalid`. User configuration is in `~/.ligule/config.toml`, shared project configuration is in `.ligule/config.toml`, and local project configuration is in `.ligule/config.local.toml`. The data root also holds workspace-scoped session records, the workspace registry, terminal input history, desktop preferences, and credential references. Older sessions remain discoverable in the former shared `sessions/` directory and project `.ligule/sessions/`; listing them is read-only, and opening one copies its record and sidecars into the new workspace folder while preserving the originals. Desktop preferences, drafts, and queued messages are stored in `desktop.json` under the data root. WebView's `ligule.ui` value is a first-screen cache. Drafts and queues are separate between the terminal UI and desktop app.

### Configure a model service

In the desktop app, open “Model services” under “Settings” to add multiple services and models, then choose a default. The terminal UI and command line read the same configuration. To configure multiple services manually, add this block to a configuration file:

```toml
[model]
services = [
  { id = "deepseek", name = "DeepSeek", api = "chat-completions", baseURL = "https://api.deepseek.com/v1", apiKeyEnv = "DEEPSEEK_API_KEY", models = ["deepseek-flash"] },
]
selection = { provider = "deepseek", model = "deepseek-flash" }
```

Set each service's `api` to `chat-completions` or `messages`; `models` lists its available models. Put the API key in the environment variable named by `apiKeyEnv`. The desktop model services page can also save a key in the operating system credential store. A non-empty environment variable takes priority. Linux uses Secret Service and reports an error when it is unavailable. The legacy single-service fields `model.api`, `model.baseURL`, and `model.model` remain supported; if that configuration omits `apiKeyEnv`, ligule reads `LIGULE_API_KEY`.

The default service and model apply to new sessions. Use the model menu beside the composer to select a model for the current desktop session. In the terminal UI, press Ctrl+P or use `/model` to open the model list, or use `/model <service> <model>` to switch directly. A session selection does not change the global default. If you switch models while a session is running, the change applies after the current turn.

Use `/credentials` in the terminal UI to check the current model's credential reference and source: environment, OS credential store, or not set. It never displays the key. `provider_credential_missing` means that reference has no key in the launching environment or the credential store for the current data root. Restart the terminal program after changing environment variables, or save a key through Desktop Model services. Both interfaces must use the same `LIGULE_HOME` to access the same stored credentials.

#### Model output budget

Each service under Desktop “Settings → Model services” has a model configuration table. Add or remove models and edit their display names, context windows, and maximum output tokens. Blank limits inherit existing configuration; enter full positive integers such as `128000`. Display names do not change the model ID sent to the service. Services supporting discovery can fetch an available-model list and let you choose which entries to add; existing names and limits are preserved. Discovery does not infer token limits. Apply catalog edits with “Save service”.

Per-model settings use the optional `modelSettings` list within the service. Each `id` references an ID in `models`, for example `modelSettings = [{ id = "custom-model", name = "My model", contextTokens = 128000, outputTokens = 16384 }]`. The selected model's context window controls compaction and its output budget controls actual requests. Identically named models in different services keep independent settings. Existing ID-only catalogs remain compatible.

`model.outputTokens` sets the maximum output-token budget for each request. The default remains 8192. Set `outputTokens = 16384` under `[model]`, or use the existing `config.set` interface. The value must be a positive integer within verified model limits, explicitly configured capability limits, and the context window.

The default output budget must also fit the configured context window. If the context window is smaller than that default, explicitly set an output budget no larger than the window. Invalid configurations fail explicitly rather than silently reducing the budget.

Higher built-in limits currently cover `deepseek-flash` and `deepseek-v4-pro` at the official `https://api.deepseek.com` endpoint, for Chat Completions and Anthropic-compatible Messages. Other endpoints and unverified models retain the conservative 8192 limit without a per-model declaration. A per-model `outputTokens` setting can declare a higher budget supported by a custom service; enter a value supported by that service. Declarations cannot raise verified official ceilings, configured capability limits, or the selected model's context window. An excessive budget fails with `provider_output_budget_unsupported`; an invalid value fails with `provider_output_budget_invalid`. There is no silent reduction. Switching models or services recalculates the applicable limits.

The legacy `model.capabilities.maxOutputTokens` can still only lower the adapter's declared limit: writing 16384 there does not raise the original 8192 ceiling. Use `model.outputTokens` for a higher request budget and check for a lower legacy capability override. Configuration changes apply at turn boundaries; an active turn keeps its existing budget.

Model settings are validated against the complete effective configuration before saving. A rejected setting leaves the configuration file unchanged. User-layer changes also validate the shared defaults on their own, other loaded projects, and explicitly selected session models; higher-priority project or command-line settings retain their precedence. Initial setup may save incomplete model fields so the remaining fields can be filled in.

Both APIs support `model.capabilities.streaming = false`. Requests then use ordinary JSON responses, with the same completion, output-budget, tool validation, and cancellation rules as streaming responses. This setting changes response delivery, not tool permissions or automatic retry scope.

### Sessions and input

In the terminal UI, use `/sessions` to browse sessions in the current workspace and `/resume <id> [mode]` to resume one; you can use a unique ID prefix. In the desktop app, switch sessions from the sidebar. The conversation menu provides rename, archive, restore, branch, export, view subtasks, refresh, and compact context actions.

Type `@` in the composer to find files in the current workspace. Selecting a file suggestion inserts its path into the draft without sending the message. Press Enter to send; press Shift+Enter for a new line. Messages sent while a session is running are queued and sent in order. Cancelling a turn pauses the queue. View the queue, resume sending, or move queued messages back into the draft. After reconnecting, queued messages return to the draft and are not sent automatically.

The desktop app saves drafts and queues separately for each workspace and session, and restores them when reopened. The terminal UI saves its draft and queue for each workspace and session. Both interfaces share the history of sent messages.

While running, terminal and desktop status show the phase confirmed by the Host: preparing context, requesting the model, executing tools, compacting, waiting for approval or input, or settling. Time without progress measures the interval since actual model output or tool activity; it does not prove a failure. After a command exits, the Agent may request the model again. There is no fixed inactivity timeout that automatically cancels a turn.

A response completes only after a normal protocol ending with useful text or tool calls. Truncated output, reasoning-only or blank responses, and incomplete streams fail the turn. Partial text remains in the record, and executed tools are not automatically replayed. Inspect the record before explicitly submitting another task or cancelling the active one.

| Error code | Meaning |
| --- | --- |
| `provider_output_exhausted` | The provider reached its output budget; the response is incomplete |
| `provider_empty_response` | Normal ending without useful text or tool calls |
| `provider_stream_incomplete` | Missing protocol terminator, finish reason, or complete frame |
| `provider_stream_interrupted` | Reading the response body was interrupted |
| `provider_finish_reason_invalid` | Unsupported provider finish reason |
| `provider_tool_call_invalid` | Missing or duplicated call identity, or missing tool name |
| `provider_tool_args_invalid` | Tool arguments are invalid JSON; the batch was not executed |
| `exec_script_binding_unavailable` | The script or interpreter could not be safely bound to approval, so execution was refused |
| `exec_script_binding_changed` | The script, interpreter, workspace, or Permission changed after approval, so execution was refused |
| `session_permission_format_unsupported` / `session_policy_format_unsupported` | The legacy session format cannot store this setting; the session record was not changed |

HTTP errors show the status and necessary fixed classification, without raw gateway bodies or malformed tool arguments. Retryable transport failures and configured retryable HTTP 429/5xx responses follow the configured attempt and backoff limits before a successful response body is read. An interruption after body reading begins does not automatically replay the whole request. Explicit user cancellation remains `cancelled`.

### Approvals and settings

The default approval mode asks before each tool call. In the terminal UI, press `y` to allow a requested call or `n` to refuse it. In the desktop app, use the Allow or Refuse buttons on the approval card. Expand the card to inspect the requested action or change.

In the terminal UI, use `/policy ask` to ask each time, `/policy auto` to select automatic decisions, or `/policy reset` to restore the configured default. Automatic decisions still follow deny rules, guards, command syntax checks, and target-address checks. Commands that cannot be verified safely fall back to asking. The tool and approval menus beside the desktop composer can change the current session; before sending the first message in a new conversation, you can also choose its tool mode and approval mode. Choosing “No approval” opens a confirmation first. Once enabled, tool calls no longer prompt individually; workspace boundaries, deny rules, and safety guards still apply. Commands that cannot be parsed safely, private network targets, and actions that require extra approval are denied. “Approval rules” in Settings can save the default mode to user or project-local configuration. Saved approval modes and rules affect the next decision immediately.

Permission controls the operating-system resources a session can access. Policy separately decides whether an allowed operation needs approval or must be refused. In the TUI, enter `/permission`; in Desktop, open the permissions menu beside the composer to view or change the current session's Permission. For a new conversation, choose its file/command profile and network mode before sending the first message. `read-only` denies file-tool writes; `workspace-write` allows file tools to write within the configured path boundary; `full-access` relaxes operating-system isolation for commands and requires a second confirmation. Built-in file tools remain subject to their path boundary. Network access is configured separately as `policy`, `disabled`, or `unrestricted`; unrestricted access also requires confirmation. When a new conversation starts, the Host applies the selected profile; confirmed increases are validated and recorded with their trusted-UI source. Permission status reports platform file-read, file-write, network, and process isolation capabilities, along with whether Shell is available.

Node/Python scripts are never automatically allowed. Per-call approval shows the script path, SHA-256, interpreter, workspace, and Permission; the Host refuses execution if any of them changes while approval is pending. Shell scripts, wrappers, compound commands, or dynamic commands that cannot be bound safely are refused. Git commands require a trusted workspace and per-call approval because repository configuration can run hooks, helpers, or aliases. Legacy session records remain readable but cannot change Permission or Policy; create a new session to adjust those settings.

Use `/control create` in the TUI or Settings → Agent Control in Desktop to create an Agent Control Grant for one project. A Grant sets default and maximum Permission and network access, allowed Policies, expiry, and whether ordinary Operator actions are allowed. Full access and unrestricted networking require separate confirmations. Start the MCP server with `--grant <id>` to use the Grant; `--operator` can answer ordinary approvals or change session settings within the Grant only when it allows those actions. Revoked or expired grants block further control; they do not bypass OS sandbox limits or hard Policy denials.

Shell runs only when the platform backend can meet the isolation requirements of the selected profile; it is denied when those capabilities are insufficient or the sandbox is unavailable. Linux currently uses bubblewrap; see the live capability status because filesystem isolation is reported as `partial`. Windows uses a per-run `WRITE_RESTRICTED` token for `workspace-write`, reported as `partial`; it requires explicit project trust, confirmation of the limits, and `unrestricted` network access. Windows cannot restrict command reads or network access, and existing hard links, writable ancestor `FILE_DELETE_CHILD` permissions, or concurrent ACL changes can cross the workspace boundary. It is not a container for hostile native code. Windows `read-only` uses AppContainer only when a live probe confirms the selected Shell can enter the actual workspace; otherwise Shell is unavailable in that profile. When available, AppContainer blocks workspace writes and Shell networking but may still read public operating-system files. macOS currently has no supported process-ownership or operating-system sandbox backend, so Shell is unavailable under all profiles. Under `full-access`, Shell runs with the current operating-system user's permissions and requires `unrestricted` network access and available process management. This profile does not bypass Policy denial rules or hard denials for dangerous operations. Loaded extensions are trusted code; direct operating-system access from an extension does not pass through Host Policy. Close extensions and restart Host before lowering permissions.

Desktop Settings has General, Appearance, Model services, Approval rules, Agent Control, Notifications, and Keyboard shortcuts sections. When saving model settings, choose the user or project-local configuration layer. Running sessions apply model configuration changes after the current turn. Higher-priority configuration still takes precedence. If you leave a settings page with unsaved changes, the app asks whether to discard them.

### Branches and export

In the terminal UI, use `/branch` to branch from the current record or `/branch <seq>` to branch from a completed turn. In the desktop app, choose “Branch conversation” from the conversation menu to copy the current record, or use the branch action on a completed turn in the transcript. A branch creates a new session and leaves the original unchanged.

Use `/export <path>` in the terminal UI to export the current session and its subtasks as Markdown. In the desktop app, choose “Export Markdown” from the conversation menu and select a save location. The app reports the result for each file. Existing subtask files are not overwritten; the main session is written to the selected path.

In the terminal UI, press Ctrl+O to browse the full history, use `/show <seq>` to view one complete record, and `/sub <seq>` to view a subtask record. In the desktop app, expand records in the transcript or open the subtask list from the conversation menu.

### Recovery and cancellation

Cancel a running turn by pressing Esc in the terminal UI or the Stop button in the desktop app. The interface marks turns as completed, cancelled, failed, or interrupted.

When the desktop app shows a connection banner, select “Reconnect” to restart the backend and reopen the current session. Unanswered approvals and questions are voided; queued messages return to the draft. After leaving the terminal UI, use `/resume <id> [mode]` to continue a session.

`tool_outcome_unknown` means a tool call may or may not have completed when its process exited unexpectedly. Check the file or external state before deciding whether to repeat the action. `session_locked` means another process still holds the session; close that process before resuming. After leaving the terminal UI, first run `ligule`, then enter `/resume <id or unique prefix>`. You can also run `ligule resume <id> "<message to send>"` from the command line. `host_model_config_missing` means the model service configuration is incomplete; check the model fields in `~/.ligule/config.toml` or fill them in under desktop “Model services”. `provider_credential_missing` means the environment variable or system credential store does not contain the key. `credential_store_unavailable` means the system credential store could not be used; on Linux, check Secret Service.

### Language, appearance, and shortcuts

In desktop Settings under General, choose Follow system, 简体中文, or English. Appearance offers six palettes: Ink, Parchment, Sky, Graphite, Forest, and Dusk. You can also adjust the font size, sidebar width, and panel position. Set the CLI and terminal UI language with `--lang zh`, `--lang zh-CN`, `--lang en`, or `--lang auto`; `zh-CN` and `zh` both select Simplified Chinese.

Common terminal UI shortcuts: Enter sends; Shift+Enter or Ctrl+N inserts a new line; Esc cancels the turn; Ctrl+C exits; Ctrl+O browses history; Ctrl+R searches input history; Ctrl+G opens the draft in an external editor; Ctrl+Z and Ctrl+Y undo or redo draft edits. Ctrl+P selects a model, Ctrl+T selects a tool mode, and Ctrl+A selects an approval mode. The row below the composer shows the active bindings. Use `/bind` to view or change shortcuts. Normal exit saves drafts and queues; restored queues remain paused, and `/quit` is not restored as a draft.

`/help` opens a categorized panel above the composer without writing help into the session transcript. Left and Right switch between commands, keys, and prompt templates. Up, Down, PageUp, and PageDown browse the content; Esc closes the panel and returns to the draft. Choice lists also use Up, Down, Enter, and Esc. All these bindings can be changed with `/bind`.

Common desktop shortcuts: Ctrl+K opens the command palette; Ctrl+B hides or shows the sidebar; Ctrl+Shift+C copies the latest answer; Enter or Ctrl+Enter sends; Shift+Enter inserts a new line. Esc closes an open panel first, then cancels a running turn. View or change shortcuts under “Keyboard shortcuts” in Settings.

The desktop app provides five kinds of system notifications: a question needs an answer, an action needs approval, a turn completes, a turn fails, or the connection is interrupted. In Settings under Notifications, enable or disable all notifications and each kind separately. Clicking a notification opens its conversation. App permission and system notification settings affect delivery. Notifications show the conversation name and status without prompts, tool commands, or keys. Real notification behavior has not yet been verified on every target platform.

When the tray is available, closing the window hides it while background sessions continue. The tray menu follows the interface language: “打开 ligule” / “Open ligule” restores the window, and “退出 ligule” / “Quit ligule” lists affected sessions and asks whether to interrupt work before quitting. If the tray is unavailable, closing the window asks for confirmation before quitting.

### Local MCP and permissions

`mcp.servers.<name>` supports stdio servers: `command` names one executable, `args` is an argument array, and `cwd` is an optional working directory. Values in `env` must use `${ENVIRONMENT_VARIABLE}` references. Servers start on demand. The model reads a tool definition and digest through `mcp.inspect`, then submits JSON arguments matching that definition through `mcp.call`. Changed definitions require disclosure again.

MCP calls enter Host Policy as `mcp:<server>/<tool>`. A configured server runs as an external process. The file tools' `boundary` does not provide an operating system sandbox for that process or restrict arbitrary server resources. Configure trusted servers and control their access with server-specific directory restrictions, operating system isolation, and Policy. File tool boundaries do not define external process permissions.

Cancelling a turn cancels the pending MCP request; check any side effects already produced by the server. Unexpected disconnection fails the call without automatic reconnection or replay. Check the external state, reconnect the desktop Host or restart the terminal UI, and disclose the tools again. A Skill's MCP dependency check only verifies that the server is configured; it does not establish connectivity or grant permission to call its tools.

### Common errors

- `tui_terminal_required`: Run `ligule` in an interactive terminal; use `ligule run` in a script.
- `tui_dependency_missing`: Some optional terminal UI dependencies are missing. Check that npm installed optional dependencies.
- `data_root_invalid`: `LIGULE_HOME` must be an absolute path. Without it, ligule uses `~/.ligule`.
- `provider_model_required` or `provider_base_url_required`: Check the service URL, API type, and model name.
- `resume_mode_changed`: Resume with the mode the session used, or run `/resume <id> <mode>` in the terminal UI.
- Run `ligule --help` for command-line help or `/help` in the terminal UI for its commands and shortcuts.
