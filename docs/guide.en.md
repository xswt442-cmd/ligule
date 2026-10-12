# ligule user guide

[简体中文](guide.zh-CN.md) · [English](guide.en.md)

ligule provides a command line, a terminal UI, and a desktop UI. All three use the same configuration and session records.

## Install and launch

The command line package requires Node.js 24 or newer. Install the version currently published on npm:

```sh
npm install -g ligule
```

Version 0.0.2 has not been released; the version in the repository does not mean that its npm package or desktop installers are available. Use a desktop installer published for your platform. The Windows desktop app requires the WebView2 runtime.

From a project directory, run `ligule run "Review the project structure and suggest improvements"` to make one request. For daily use, run `ligule tui` to open the terminal UI or launch the installed ligule desktop app. The terminal UI requires an interactive terminal; use `ligule run` in scripts and pipelines.

Run `ligule --help` to list commands. `ligule sessions` lists sessions for the current project, `ligule workspaces` lists registered workspaces, and `ligule tools`, `ligule skills`, and `ligule extensions` show loaded capabilities.

## Workspaces and data

The command line and terminal UI use the current directory as the default workspace. On first launch, the desktop app creates and registers `ligule/default-workspace` under the system Documents directory. New sessions then use the selected default workspace. Add other workspaces from the desktop sidebar to view their sessions.

Each session belongs to one workspace. The terminal UI prepares a new session when it starts. The desktop app restores the last session at launch, or prepares a new one when there is no previous session. Session records are stored in the `sessions/` directory under the data root by default.

The default data root is `~/.ligule`. Set `LIGULE_HOME` to an absolute path to move it; a relative path returns `data_root_invalid`. User configuration is in `~/.ligule/config.toml`, shared project configuration is in `.ligule/config.toml`, and local project configuration is in `.ligule/config.local.toml`. The data root also holds session records, the workspace registry, terminal input history, desktop preferences, and credential references. Desktop preferences, drafts, and queued messages are stored in `desktop.json` under the data root. WebView's `ligule.ui` value is a first-screen cache. Drafts and queues are separate between the terminal UI and desktop app.

## Configure a model service

In the desktop app, open “Model services” under “Settings” to add multiple services and models, then choose a default. The terminal UI and command line read the same configuration. To configure multiple services manually, add this block to a configuration file:

```toml
[model]
services = [
  { id = "deepseek", name = "DeepSeek", api = "chat-completions", baseURL = "https://api.deepseek.com/v1", apiKeyEnv = "DEEPSEEK_API_KEY", models = ["deepseek-chat"] },
]
selection = { provider = "deepseek", model = "deepseek-chat" }
```

Set each service's `api` to `chat-completions` or `messages`; `models` lists its available models. Put the API key in the environment variable named by `apiKeyEnv`. The desktop model services page can also save a key in the operating system credential store. A non-empty environment variable takes priority. Linux uses Secret Service and reports an error when it is unavailable. The legacy single-service fields `model.api`, `model.baseURL`, and `model.model` remain supported; if that configuration omits `apiKeyEnv`, ligule reads `LIGULE_API_KEY`.

The default service and model apply to new sessions. Use the model menu beside the composer to select a model for the current desktop session. In the terminal UI, use `/model` to list services and `/model <service> <model>` to switch. A session selection does not change the global default. If you switch models while a session is running, the change applies after the current turn.

## Sessions and input

In the terminal UI, use `/sessions` to browse sessions in the current workspace and `/resume <id> [mode]` to resume one; you can use a unique ID prefix. In the desktop app, switch sessions from the sidebar. The conversation menu provides rename, archive, restore, branch, export, view subtasks, refresh, and compact context actions.

Type `@` in the composer to find files in the current workspace. Selecting a file suggestion inserts its path into the draft without sending the message. Press Enter to send; press Shift+Enter for a new line. Messages sent while a session is running are queued and sent in order. Cancelling a turn pauses the queue. View the queue, resume sending, or move queued messages back into the draft. After reconnecting, queued messages return to the draft and are not sent automatically.

The desktop app saves drafts and queues separately for each workspace and session, and restores them when reopened. The terminal UI saves its draft and queue for each workspace and session. Both interfaces share the history of sent messages.

## Approvals and settings

The default approval mode asks before each tool call. In the terminal UI, press `y` to allow a requested call or `n` to refuse it. In the desktop app, use the Allow or Refuse buttons on the approval card. Expand the card to inspect the requested action or change.

In the terminal UI, use `/policy ask` to ask each time, `/policy auto` to select automatic decisions, or `/policy reset` to restore the configured default. Automatic decisions still follow deny rules, guards, command syntax checks, and target-address checks. Commands that cannot be verified safely fall back to asking. The tool and approval menu beside the desktop composer provides the same controls. A session override affects only that session. “Approval rules” in Settings saves the default or a project-local rule table. Saved approval modes and rules affect the next decision immediately.

Desktop Settings has General, Appearance, Model services, Approval rules, Notifications, and Keyboard shortcuts sections. When saving model settings, choose the user or project-local configuration layer. Running sessions apply model configuration changes after the current turn. Higher-priority configuration still takes precedence. If you leave a settings page with unsaved changes, the app asks whether to discard them.

## Branches and export

In the terminal UI, use `/branch` to branch from the current record or `/branch <seq>` to branch from a completed turn. In the desktop app, choose “Branch conversation” from the conversation menu to copy the current record, or use the branch action on a completed turn in the transcript. A branch creates a new session and leaves the original unchanged.

Use `/export <path>` in the terminal UI to export the current session and its subtasks as Markdown. In the desktop app, choose “Export Markdown” from the conversation menu and select a save location. The app reports the result for each file. Existing subtask files are not overwritten; the main session is written to the selected path.

In the terminal UI, press Ctrl+O to browse the full history, use `/show <seq>` to view one complete record, and `/sub <seq>` to view a subtask record. In the desktop app, expand records in the transcript or open the subtask list from the conversation menu.

## Recovery and cancellation

Cancel a running turn by pressing Esc in the terminal UI or the Stop button in the desktop app. The interface marks turns as completed, cancelled, failed, or interrupted.

When the desktop app shows a connection banner, select “Reconnect” to restart the backend and reopen the current session. Unanswered approvals and questions are voided; queued messages return to the draft. After leaving the terminal UI, use `/resume <id> [mode]` to continue a session.

`tool_outcome_unknown` means a tool call may or may not have completed when its process exited unexpectedly. Check the file or external state before deciding whether to repeat the action. `session_locked` means another process still holds the session; close that process before resuming. After leaving the terminal UI, first run `ligule tui`, then enter `/resume <id or unique prefix>`. You can also run `ligule resume <id> "<message to send>"` from the command line. `host_model_config_missing` means the model service configuration is incomplete; check the model fields in `~/.ligule/config.toml` or fill them in under desktop “Model services”. `provider_credential_missing` means the environment variable or system credential store does not contain the key. `credential_store_unavailable` means the system credential store could not be used; on Linux, check Secret Service.

## Language, appearance, and shortcuts

In desktop Settings under General, choose Follow system, 简体中文, or English. Appearance offers six palettes: Ink, Parchment, Sky, Graphite, Forest, and Dusk. You can also adjust the font size, sidebar width, and panel position. Set the CLI and terminal UI language with `--lang zh`, `--lang zh-CN`, `--lang en`, or `--lang auto`; `zh-CN` and `zh` both select Simplified Chinese.

Common terminal UI shortcuts: Enter sends; Shift+Enter or Ctrl+N inserts a new line; Esc cancels the turn; Ctrl+C exits; Ctrl+O browses history; Ctrl+R searches input history; Ctrl+G opens the draft in an external editor; Ctrl+Z and Ctrl+Y undo or redo draft edits. Use `/bind` to view or change shortcuts.

Common desktop shortcuts: Ctrl+K opens the command palette; Ctrl+B hides or shows the sidebar; Ctrl+Shift+C copies the latest answer; Enter or Ctrl+Enter sends; Shift+Enter inserts a new line. Esc closes an open panel first, then cancels a running turn. View or change shortcuts under “Keyboard shortcuts” in Settings.

The desktop app provides five kinds of system notifications: a question needs an answer, an action needs approval, a turn completes, a turn fails, or the connection is interrupted. In Settings under Notifications, enable or disable all notifications and each kind separately. Clicking a notification opens its conversation. App permission and system notification settings affect delivery. Notifications show the conversation name and status without prompts, tool commands, or keys. Real notification behavior has not yet been verified on every target platform.

When the tray is available, closing the window hides it while background sessions continue. The tray menu follows the interface language: “打开 ligule” / “Open ligule” restores the window, and “退出 ligule” / “Quit ligule” lists affected sessions and asks whether to interrupt work before quitting. If the tray is unavailable, closing the window asks for confirmation before quitting.

## Common errors

- `tui_terminal_required`: Run `ligule tui` in an interactive terminal; use `ligule run` in a script.
- `tui_dependency_missing`: Some optional terminal UI dependencies are missing. Check that npm installed optional dependencies.
- `data_root_invalid`: `LIGULE_HOME` must be an absolute path. Without it, ligule uses `~/.ligule`.
- `provider_model_required` or `provider_base_url_required`: Check the service URL, API type, and model name.
- `resume_mode_changed`: Resume with the mode the session used, or run `/resume <id> <mode>` in the terminal UI.
- Run `ligule --help` for command-line help or `/help` in the terminal UI for its commands and shortcuts.
