# Terminal client

This directory contains the React and Ink terminal client. It connects to the Host in the same process over an in-memory transport. The repository root [Agent guide](../AGENTS.md) also applies here.

## Responsibilities and entry points

- `start.ts` starts the Host and Ink, and connects input history, drafts, queues, shortcuts, the editor, and the terminal title. On exit, it waits for file writes and releases the Host.
- `app.ts` manages the foreground session and interactive view. Session, model, tool, approval, question, and export operations go through the Host protocol; the UI does not execute tools or read session files directly.
- A terminal has one foreground session. Creating, resuming, or branching a session releases the previous session's record lock. Multiple terminals may run concurrently, but they cannot write to the same session at the same time.
- Ink and React are optional dependencies. If they are missing, report `tui_dependency_missing`; if the terminal is non-interactive, report `tui_terminal_required`. Other commands remain available.
- Before loading project configuration and resources, the CLI uses `trust.ts` to ask whether to trust the current directory. `trust-store.ts` remembers only that exact normalized directory. Declining trust must not create a Host or session. `/trust revoke` revokes trust and exits; trust does not change Policy or path boundaries.

## Transcript and input

- Render committed content with `Static`, keyed by session ID. Update the session ID and transcript rows in the same render so rows are not skipped by index. Keep the main screen in terminal scrollback; Ctrl+O opens the full history browser, whose paging, row selection, and copying are managed by `viewport.ts`.
- Session records are the source of truth. Replace streamed fragments when their corresponding records arrive, and show each terminal turn state once. Clear uncommitted streamed content after cancellation or failure.
- Use `marked` for Markdown, `highlight.js` for code, and `string-width` for display width. Show model text, tool output, and paths unchanged; select system labels in Chinese or English through `locale`.
- `commands.ts` holds UI commands and completion metadata. Pass unknown slash commands unchanged to `run.start`; the Host handles prompt templates. `/model` reads the public service list and changes the session selection through `model.select`; a change during a run takes effect after the turn.
- `keymap.ts` is the shared source for actions, keys, and help. Validate personal overrides for format and conflicts within the same view; show the effective key binding in the UI.
- The welcome area and transcript share one `Static`. `help.ts` provides categorized help data, and `panels.ts` shows pageable help and selection lists above the input. While a panel is open, ordinary input does not enter the draft; closing it preserves the draft. Keep the panel input listener attached so it does not lose the first key after appearing.
- Show the model, tool mode, and approval controls below the input. Ctrl+P, Ctrl+T, and Ctrl+A are the defaults. The startup code enumerates mode files through `mode-options.ts`, and `mode.set` still validates the selection. `/credentials` reads only the current service's credential reference and source; it never displays a secret.
- Route whole-buffer pastes through Ink's paste channel into the draft. Newlines in a paste must not send a message, and a pasted `y` must not approve a tool. Ctrl+Z/Ctrl+Y undo and redo the current draft; replacing the entire draft clears its undo history.
- `@` lists project files and inserts path references without calling tools or writing session records. Debounce file-list requests by 160 milliseconds; late results must not replace a newer query. Enter and Tab must not send while candidates have not returned.

## Waiting, queues, and saving

- Approval views show only the current session's operation and actual changes; do not invent details from an unread file. Handle allow-once, refusal, and cancellation separately. Page through complete change details when needed.
- Collect answers one question at a time. Numbers select only explicit options; other text is a free-form answer. An empty Enter means no answer. Submit the complete answer set at the end. Questions do not time out; cancellation ends the wait.
- Queue new messages by session while a run is active. Cancellation pauses the queue; `/queue continue` resumes it. Recalling or clearing queued messages returns their text to the draft without losing input.
- Input history is shared by both clients; drafts and queues are saved separately by each client, and restored queues remain paused. The startup data-root facilities determine storage locations; the UI must not hard-code a user directory.
- On normal exit, save the current draft and queue before releasing the Host. Do not restore `/quit` as an unsent draft. If saving fails, keep the UI open and explain the error.
- Ctrl+G uses `$VISUAL`, then `$EDITOR`, and yields the terminal through Ink. `/copy` uses the platform clipboard facility. Full acceptance for this release covers local Windows only.
- `/export` passes the user's absolute target path to the Host; relative paths are resolved from the startup directory. Show the write, skip, or failure result for each file, and do not report partial success as total failure.
- Set the terminal title from the actual model, workspace, and session ID, filtering control characters. Clear the title on exit; a title-output failure must not prevent Host cleanup.

## Verification

From `tui/`, run `npm run build`, then run:

```sh
node --test --import ../test/hooks/isolated-data-root.mjs test/tui.test.js test/tui-browse.test.js test/tui-keys.test.js test/tui-output.test.js
```

Rendering checks must wait for a completed frame and the expected state. When changing UI wording, update the corresponding assertions; do not hide an incorrect result by extending the wait.

Also verify model requests, cancellation and paused queues, history browsing, input methods, pasting, the editor, and clipboard behavior in a real terminal. Synthetic input does not replace checks with a real keyboard, screen reader, or other platforms.
