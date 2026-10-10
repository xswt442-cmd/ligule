# ligule user guide

A self-built agent harness under development: the kernel ships no tools, every capability is a plugin. The command line, the terminal UI and the desktop shell read the same kernel, and the session log is the single source of truth.

简体中文：[guide.zh-CN.md](guide.zh-CN.md). Engineering conventions and layering rules are in [../AGENTS.md](../AGENTS.md).

Contents: [first task in thirty seconds](#first-task-in-thirty-seconds) · [install](#install) · [configuration](#configuration) · [projects and sessions](#projects-and-sessions) · [input and queue](#input-and-queue) · [approvals and rules](#approvals-and-rules) · [model and config keys](#model-and-config-keys) · [history and branching](#history-and-branching) · [shortcuts](#shortcuts) · [recovery and troubleshooting](#recovery-and-troubleshooting) · [current limits](#current-limits)

## First task in thirty seconds

After install and configuration, run one round inside a project directory:

```sh
cd <your-project-root>
ligule run "shorten the first paragraph of README"
```

The model stops and asks you before it changes a file: `y` allows that call, `n` refuses it. When the round ends, the session log is under `<project-root>/.ligule/sessions/`.

For daily use start the terminal UI or the desktop shell; both keep the conversation going:

```sh
ligule tui      # the window inside your terminal
ligule host     # the process the desktop shell starts; frames travel over stdin and stdout
```

## Install

Node 24 or newer is required. The package is not on npm yet, so install from the repository:

```sh
npm install
npm run build     # writes dist/; the CLI and the tests run that build
npm link          # makes the ligule command available; otherwise use node dist/cli.js
```

The terminal UI needs optional dependencies that `npm install` picks up. When they are missing, `ligule tui` reports `tui_dependency_missing` and prints that list.

The ripgrep used by `ligule search` is not part of the package and is built once:

```sh
npm run build-rg
```

Without it that call reports a stable probe-failure code; it never silently switches to another search method.

The desktop shell needs Rust and Tauri, plus the WebView2 runtime on Windows (bundled with Win11):

```sh
cd desktop
npm install
npm run dev       # the Vite dev server on 5188, the shell attaches to it
npm run build     # NSIS installer, output under target/release/bundle/nsis/
```

The installer carries its own Node runtime and the kernel runtime tree, so it runs on a machine with neither this repository nor node. Shell details are in [../desktop/README.md](../desktop/README.md).

## Configuration

The command line, the terminal UI and the desktop shell read the same configuration. Four layers, lowest priority first:

| Layer | Location | Notes |
|---|---|---|
| user | `~/.ligule/config.toml` | defaults for this machine |
| project | `<project-root>/.ligule/config.toml` | committed, shared with collaborators |
| project local | `<project-root>/.ligule/config.local.toml` | not committed |
| command line | `--config key.path=value` | one TOML assignment, repeatable |

Nested tables merge key by key; arrays and scalars replace wholesale.

The directory holding the user layer is the application data root: `~/.ligule` by default, and an absolute path in the environment variable `LIGULE_HOME` moves the whole thing elsewhere. A relative value is refused on the spot (`data_root_invalid`). The auto-loaded modes, skills, prompt templates and extensions, plus the terminal UI's key overrides and drafts, and the input history both UIs share, all live under that directory. Session records and the project layers follow the project root, `~/.agents/skills/` follows the home directory, and neither moves with the data root. The default workspace the desktop creates on first use has no configuration file of its own, so the model line belongs in the user layer: written only into a project's layers, it is not readable there.

The key is never written into any layer — every key in a configuration file is readable by the tools — it comes from an environment variable only. The default name is `LIGULE_API_KEY`, renamed by `model.apiKeyEnv`.

The smallest configuration that runs; replace every angle-bracket value:

```toml
[model]
api = "chat-completions"          # or "messages"
baseURL = "https://<your-endpoint>/v1"
model = "<model-name>"
apiKeyEnv = "<name-of-the-environment-variable-holding-the-key>"

[limits]
contextTokens = 200000            # without this key no context compaction happens
```

Writable keys: `mode`, `policy`, `loop`, `limits`, `exec.shell`, `instructions`, `prompt.static`, `mcp.servers.<name>`, `extensions`, `host.sessionDirectory`. Each one is described in [model and config keys](#model-and-config-keys).

Mode manifests, skills, prompt templates and extensions each have their own directories and are not written in the configuration:

| Item | Location | How to see what loaded |
|---|---|---|
| modes | shipped `modes/`, `~/.ligule/modes/`, `<project-root>/.ligule/modes/`; a same-name file replaces the shipped one whole | `ligule tools` |
| skills | `.ligule/skills/` and `.agents/skills/` in project and user directories, in that order | `ligule skills` |
| prompt templates | `<project-root>/.ligule/prompts/` and `~/.ligule/prompts/`, searched recursively | typing `/name` in the terminal UI expands it |
| extensions | `~/.ligule/extensions/*.js` load automatically; paths in the user layer and on the command line also load; paths in the project or local layer report `extension_source_ignored` and do not load | `ligule extensions` |
| workspace registry | `workspaces.json` under the data root: one row written when a session is created or reopened, and the client's list is only a reader of it | `ligule workspaces` |

## Commands

```
ligule run <text>                 one round of question and answer, approvals asked in the terminal
ligule resume <session-id> <text> continue that session with the mode it was using
ligule tui                        the terminal UI
ligule host                       a line-per-frame protocol endpoint; this is what the desktop shell starts
ligule sessions [--json] [--project <root>]   list sessions, no kernel built
ligule policy <session-id> [--json]           how the judgements went: three counters and the rules hit
ligule workspaces [--json]                    list the registered workspaces, no kernel built
ligule tools                      list the tools this run would install
ligule skills                     list the skills this directory loads and why any was skipped
ligule extensions               list the extension files that would load and the paths refused
ligule call <tool> [json-args]    invoke one tool directly, without the model
ligule --help                     list commands and options
```

Options: `--config key.path=value` (repeatable), `--mode <name>`, `--project <root>`, `--json`. `--mode` overrides `mode` in the configuration; when neither is written the shipped `minimal` mode is used.

## Projects and sessions

Where the tools may read and write is decided by the boundary. By default it is the root you pointed at this run: wherever the command line executes (or wherever `--project` points), that is where tools read and write. A `boundary` written by any configuration layer overrides it.

Session logs live in `.ligule/sessions/` under the boundary:

```
<session-id>.jsonl              one event per line, the first line is this log's metadata
<session-id>.sub-<n>.jsonl       the derived worker's own log
<session-id>.checkpoint.json     the compacted summary and the span it replaces
result-*.json                    full tool content above the injection cap
summary-*.txt                    full summary above the injection cap
```

Command line and terminal UI:

| To do | How |
|---|---|
| start a new session | `ligule run`, or `/new` in the terminal UI |
| list sessions of this project root | `ligule sessions`, or `/sessions` (keyboard selectable) |
| reconnect to one | `ligule resume <session-id> "keep going"`, or `/resume <id> [mode-name]`; a prefix of the id is enough |
| name it | `/name <text>`: the list row reads it, the model does not |
| archive and unarchive | `/archive` and `/unarchive`: only whether the list draws it by default changes, the log stays and reconnects |
| find text in the logs | `/find <text>`: says which session and which entry; the entry number goes to `/show` |
| read one entry in full | `/show <n>`; a derived branch with `/sub <n>` |

The numbers are the stable event numbers in the session log, not screen line numbers.

The desktop shell's left rail ("sessions") groups the sessions that named a workspace when they were created; each group is titled by the display name the registry holds for it, falling back to that directory's last segment where the row never named one, and the full path hangs on the row's tooltip. Sessions that named nothing, and records written before either field existed, are listed below without a group. The rail decides placement from those two fields in the record, and never from "does this path equal the current default directory". A group collapses, and the collapsed row says how many sessions it holds. The "add a project" field takes another project's directory: that list is only which directories this window wants to see, kept in local UI preferences, and dropping one changes only what this rail draws; the durable list is `workspaces.json` in the data root, which `ligule workspaces` prints and this rail reads. Each group row carries a toggle: "set as default" makes that workspace the one new sessions fall back to, and once it is the default the same toggle reads "default" and clears the selection when pressed. "refresh the session list" re-reads, and the directories it asks include the registry's default, so a first session created there is listed without anyone naming it; "only this one" limits the search to the current session and also reads the full content spilled into files, and "new" starts a session in that workspace and records the source as named. When the interface steps back on its own instead: it first takes the project the session in view belongs to, then the default workspace from the registry; with neither, the desktop shell hands over `ligule/default-workspace` under the system documents directory, registers it as the default and creates the first session there. A browser has no shell to ask, so only there does the host use its own project environment — each of these records the source as the fallback. Archived sessions sort last and are marked; a running one is marked, one that finished while you were not looking is marked until you switch to it.

The desktop has no rename or archive entry: those two happen in the terminal UI, and the desktop reads the same log.

A window's close button hides that window, not the application: the host process, a running round, an unanswered card and the queued sentences all stay. The tray icon's two menu items bring the window back or ask to leave; in this release those two labels are written in Chinese (「打开 ligule」 and 「退出 ligule」). Before quitting, the window lists which sessions this quit would interrupt: the default action returns to the app, the other interrupts those rounds and exits. Drafts and queued sentences stay on this machine and are there when you open it again. Where the tray cannot be built, that close button quits instead, so nothing ends up hidden out of reach.

One session is held by one backend process at a time. Opening it a second time reports `session_locked`.

## Input and queue

| To do | Terminal UI | Desktop shell |
|---|---|---|
| send | Enter | Enter or Ctrl+Enter |
| newline | Shift+Enter or Ctrl+N | Shift+Enter |
| reference a file in this project | type `@`, candidates appear; Enter or Tab puts `@path` into the draft without sending | same shape |
| walk the sent lines | ↑ ↓ (with a multi-line draft the cursor moves first) | ↑ ↓ |
| reverse-search input history | Ctrl+R | not available |
| hand the draft to an external editor | Ctrl+G, using `VISUAL` when set, otherwise `EDITOR` | not available |
| paste a block | it enters the draft as one unit: the newlines inside do not start a round, a `y` inside does not answer an approval for you | same shape |
| undo and redo the draft | Ctrl+Z, Ctrl+Y | the input box's own undo and redo |

Pressing Enter while a round is running does not lose that line: it joins the queue and is sent in order after the round ends.

- With an empty draft, Backspace recalls the last queued line.
- When you press Esc to interrupt a round, the queued lines stop as well.
- `/queue` says whether they run now; `/queue continue` resumes them; `/queue drop <n>` and `/queue clear` put them back into the draft instead of discarding them.
- The unsent line and the queued ones are stored in `~/.ligule/tui-input.jsonl`, separated per project and per session, and return when you open the same session again; queued lines come back paused. This file is not the source of truth: a line it cannot read is skipped and the session still opens.
- After a reconnect the queued text is not sent automatically: it goes back to the draft, and a person presses Enter once more.

The input history both UIs share survives sessions in `~/.ligule/tui-history.jsonl`: every sentence sent from the terminal or the desktop joins that one list, newest first, at most 200 lines, and it stays out of the session log. Drafts and queued lines stay each UI's own, kept per session.

## Approvals and rules

The policy level applies to the whole run, not per tool name. Two levels can be written: `ask` asks every time, `auto` opens read, write and execution together; anything else reports `policy_mode_unknown`. Each call's judgement has three outcomes: allowed, refused, asked.

`ask_user_question` asks what the person wants rather than whether an action may run, so it keeps its own request and answer: it takes no part in the level decision, has no deadline, and ends only when the answers are submitted or the round is cancelled. Both the terminal and the desktop shell can answer it; the plain command-line entry does not carry it, because nobody is there to answer the next call.

| To do | Terminal UI | Desktop shell |
|---|---|---|
| answer this request | `y` allows, `n` refuses; Esc cancels the round | the allow and refuse buttons; Esc cancels the round |
| see the actual change | expanded inside the request box; Ctrl+O opens or collapses it | same shape, and the header names which project the action belongs to |
| answer a question from the model | write a sentence in the draft, or the number of an option; Enter records that item and the last one sends the whole set | pick an option or write free text, then use the submit button |
| change the level for this session | `/policy ask`, `/policy auto`, `/policy reset` | the badge in the top bar; reset returns to the configured default |
| see how this run judged | `ligule policy <session-id>` | the "tools and levels" panel states the current level, which layer it comes from, and the consecutive and total refusal counts |
| save a default level and rule table | `[policy]` in a configuration file | the settings "approval rules" section |

A rule table has four fields:

```toml
[policy]
mode = "ask"

[[policy.rules]]
tool = "read"
decision = "allow"

[[policy.rules]]
tool = "exec"
decision = "allow"
match = "git diff*"
reason = "read-only diff"
```

- `tool` is a tool name, or the capability name spelled `mcp:<server>/<tool>`.
- `decision` is `allow` or `deny`.
- `match` is a prefix for the command text, or a pattern containing `*`.
- For calls with no command text (`read`, `find`, `search` and the like) leave `match` out to allow the whole tool: a rule that carries `match` does not cover them and they still ask.
- When one command is read as several segments (a pipeline, for example), `ask` needs a single rule to cover every segment to stay quiet; several rules each covering one segment still ask.
- If any hit rule says `deny`, the call is refused; an `allow` written before it does not override that. This holds in both `ask` and `auto`.
- `allow` rules only take part in judgement under `ask`. `auto` opens read, write and execution together, it is not "read-only allowed". To open only the read-only tools, stay on `ask` and write one allow rule for each of read, find and search.

The top badge and `/policy` change only this session and never write a file. The settings "approval rules" section writes either the user default or the project local override, and replaces only the bytes of that block: comments and key order survive. It lists the table currently in effect and which layer it came from.

When consecutive refusals reach the threshold, the level returns to asking by itself; `ligule policy <session-id>` reads back which call was covered by which rule.

## Model and config keys

The `model` block is the endpoint: `api` (`chat-completions` or `messages`), `baseURL`, `model`, `apiKeyEnv`. The desktop's "model and endpoint" panel edits those four keys: choose the user default or the local override to write, preview, then save; the same place states when it takes effect and which layer writes that line. A key written on the command line is not overridden by editing the file.

The other keys:

| Key | What it governs |
|---|---|
| `mode` | which mode manifest to use; `--mode` overrides it |
| `policy.mode` | the default level; `/policy` and the top badge change only the current session |
| `policy.rules` | the rule table, see the previous section |
| `policy.thresholds` | the consecutive and total refusal thresholds that force asking again; defaults 3 and 20 |
| `loop` | iteration and model-call limits |
| `limits` | byte and item caps in each place, including `contextTokens` |
| `exec.shell` | `auto`, `bash`, `powershell` |
| `instructions` | the budget for the project instruction file |
| `prompt.static` | the static section of the system prompt: with nothing written in any of the four layers the shipped base prompt is used, and a layer that writes it replaces it whole |
| `mcp.servers.<name>` | `command`, `args`, `env`, `cwd` |
| `extensions` | an array of extension file paths |
| `host.sessionDirectory` | the directory session logs fall into |

Three different effective times: the level and the rule table act on the following judgements immediately; the model endpoint and the mode wait for the session's round boundary, and the UI states both "this session currently uses" and "waiting at the boundary is"; a key written by `--config` on the command line cannot be overridden by editing files.

## History and branching

| To do | Terminal UI | Desktop shell |
|---|---|---|
| browse the full history | Ctrl+O opens it; PageUp/PageDown page, Home/End jump, Shift+↑/↓ select lines, Ctrl+Y copy the selection, Esc close | the transcript scrolls, rows expand in place |
| read one entry in full | `/show <n>` | click that row |
| read a derived branch | `/sub <n>` | the "derived branches" panel |
| compact the context manually | `/compact` (requires `limits.contextTokens`) | "compact the context manually" in the command palette |
| copy the last answer | `/copy` | Ctrl+Shift+C |
| copy a code block | select it, then Ctrl+Y | the "copy code" button under each fenced block |
| export the full log | `/export <path>` | the "export full log" panel, which opens this machine's save dialog |
| branch from here | `/branch [n]` | "branch a new session from this one" in the command palette |

`/branch` without a number copies up to wherever the log has fallen; with a number it copies up to the entry where that round finished normally, and `/show <n>` reads that entry. The original log is not changed by one character. A dispatch the previous session never received is not replayed: the first time you open the new session it is filled in as "outcome unknown". A branch does not create another workspace — a branch in the same project writes the same files.

Export reads the full log, fills in the content spilled into files, and does layout and writing on the host side; every derived branch writes its own file in the same directory. The dialog returning a path does not mean the file was written: that panel states the paths the host returned, and when a branch cannot be read back, or the file name it computes already holds something (that one is left alone), it names that branch's code or path.

Interrupting a running round takes the whole child-process tree of the command with it. When the host is killed hard or crashes it cannot: that call's result is recorded as `tool_outcome_unknown` on recovery, and both the UI and the model see the same sentence — "unknown whether it happened".

## Shortcuts

Each side has one key table: the key names shown on screen and the bindings actually fired read the same source. A personal override replaces the keys of one action; the action name does not move.

Terminal UI (`/bind` lists the current table):

| Keys | Action | Scope |
|---|---|---|
| Ctrl+C | quit the UI | global |
| Ctrl+O | open the full history view; while an approval box is open, expand or collapse that change | global |
| Ctrl+G | hand the draft to the editor named by `EDITOR` or `VISUAL` | global |
| Ctrl+R | start a reverse search in input history | global |
| Esc | interrupt this round; the queued lines stop as well | global |
| Enter | send this line; joins the queue while a round runs | input |
| Shift+Enter, Ctrl+N | newline | input |
| ↑ ↓ | move the cursor when the draft has several lines, otherwise walk local input history | input |
| Backspace, Delete | recall the last queued line when the draft is empty | input |
| Ctrl+Z, Ctrl+Y | undo and redo the last draft change | input |
| Tab, ↑ ↓, Esc | complete a command | completion list |
| Enter, Tab, ↑ ↓, Esc | pick that file candidate without sending | path candidates |
| Enter, ↑ ↓, Ctrl+R, Esc | put the matched line back into the draft | reverse search |
| Enter, ↑ ↓, PageUp/PageDown, Home/End, Esc | take the session selected in the list | session list |
| ↑ ↓, PageUp/PageDown, Home/End, Shift+↑/↓, Ctrl+Y, Esc | browse and select the full history | full history |
| y, n, Esc, ↑ ↓, PageUp/PageDown, Home/End | answer the approval and read that change | approval |
| Enter, ←, Esc | answer the model's questions one item at a time; ← returns to the earlier item while the draft is empty | question |

`/bind <action> <key-spec>` changes one binding, `/bind reset <action>` drops that override, `/bind default` returns the whole table. Two keys landing on one action in the same scope are refused on the spot. Overrides are stored in `~/.ligule/tui-keys.json` and survive the next start.

Desktop shell (edited in the settings "keys" section):

| Keys | Action | Scope |
|---|---|---|
| Ctrl+K | open the command palette | window |
| Ctrl+B | collapse or expand the left rail | window |
| Ctrl+Shift+C | copy the last answer | window |
| Esc | close the open layer; only after all are closed does it interrupt the round | window |
| Enter, Ctrl+Enter | send this line; joins the queue while a round runs | input dock |
| Shift+Enter | newline | input dock |
| ↑ ↓ | walk local input history | input dock |
| Enter, Tab, ↑ ↓, Esc | pick that file candidate without sending | candidate list |

The palette holds: new session, re-read this session's log, branch a new session from this one, cancel this round, compact the context manually, open settings, collapse or expand the left rail, copy the last answer.

## Recovery and troubleshooting

| You see | Meaning | What to do |
|---|---|---|
| `session_locked` | another backend process holds this session | close the other one, or wait for it to release; after a hard kill of the lock owner the lock expires within ten seconds |
| the disconnect banner and its "reconnect" button | the backend process exited | press "reconnect": it starts a new process and takes the session back with `session.open`. Unanswered requests end as `host_restarted`, unanswered approvals and questions are voided |
| `tool_outcome_unknown` | left by a call whose host was hard-killed or crashed | treat it as "unknown whether it happened"; confirm the actual state before redoing it |
| `config_field_unknown` | the key the UI submitted is not on the host whitelist | use one of the four model fields the panel offers |
| `data_root_invalid` | `LIGULE_HOME` names a relative path | write an absolute path; without this variable the data root is `~/.ligule` |
| `workspace_registry_invalid` | the workspace registry cannot be parsed, or its default selection names an identity that is not registered | fix the field the error names, or delete the file and let session creation register the workspaces again |
| `workspace_registry_version` | the registry was written by a later version | run that version's executable, or delete the file and register again |
| `input_history_invalid` | one line of the shared input history does not read as a sentence | fix or delete the line it names, or delete the file; the next send writes it again |
| `input_history_locked` | something else is writing that history right now | send again a moment later; only two surfaces sending at once hit it |
| `cli_command_unknown` | the command name is misspelled | run `ligule --help` |
| `tui_terminal_required` | the terminal UI started on a non-interactive terminal | use `ligule run` |
| `tui_dependency_missing` | the terminal UI's optional dependencies are not installed | `npm install ink react marked highlight.js string-width` |
| `extension_source_ignored` | the project or local layer wrote an extension path | put the extension in `~/.ligule/extensions/`, or write it in the user layer or on the command line |
| `ligule resume` says the mode file changed | the manifest that session used is not the one read now | name one explicitly with `--mode <name>` or `/resume <id> <mode-name>` |
| the first line's format version does not match | that log was written by a later build | go back to that build's executable, or start a new session |

Four read-only checks build no kernel and ask no model: `ligule tools`, `ligule skills`, `ligule extensions`, `ligule workspaces`. How one run judged is read with `ligule policy <session-id>`.

When the desktop shell cannot find the backend entry point, `LIGULE_DESKTOP_CLI` points at the entry and `NODE` at a node executable; the priority order of the bundled copies is in [../desktop/README.md](../desktop/README.md).

## Current limits

| Not there yet | How to work around it |
|---|---|
| several windows on one session | one shell equals one backend process; quit that shell through its tray menu (「退出 ligule」), then take the session back in the new window. The close button only hides a window — its backend process, and the record lock it holds, stay |
| rename and archive in the desktop | use `/name`, `/archive`, `/unarchive` in the terminal UI; the desktop reads the same log |
| handing an image to the model | `read` returns text; no such tool exists, so even a multimodal endpoint only gets words |
| `ligule init` and one self-check command | copy the minimal configuration from the [configuration](#configuration) section; check what loaded with `ligule tools`, `skills` and `extensions` |
| shared UI preferences across windows | two windows on one WebView2 user-data directory read the same storage, and a whole-block rewrite keeps the last write |
| `plan`, `goal` and codemode | not provided |
| code signing, auto update, MSI and multi-architecture distribution | not invested in; the installer is an unsigned NSIS build |

## Related documents

- [../README.md](../README.md): repository front page and the minimal notes
- [../AGENTS.md](../AGENTS.md): engineering conventions, layering and stable codes
- [../desktop/README.md](../desktop/README.md): desktop shell build, checks and bundled runtime
