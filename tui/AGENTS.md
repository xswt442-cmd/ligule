# Terminal client

The [repository guide](../AGENTS.md) applies. React/Ink TUI runs with the Node Host over an in-memory protocol. Host remains authoritative for Sessions, tools, permissions, and configuration.

- `start.ts` owns Host/Ink startup and shutdown; `app.ts` owns foreground interaction. One terminal has one writable foreground Session. Switching, resuming, or branching must release the prior record lock. When dependencies or an interactive terminal are missing, report the documented error without breaking other CLI commands.
- Trust the exact normalized project root before loading its resources; rejecting trust must not create a Session. Trust changes neither policy nor path boundary.
- Render committed events via `Static`, keyed by Session; reconcile streaming fragments against durable events. Leave committed history in scrollback, with `viewport.ts` providing full-history browsing. Keep Markdown, code, and width handling consistent with existing renderers.
- Keep UI commands and completion metadata in `commands.ts`; unknown slash commands pass to Host templates. `keymap.ts` is authoritative for shortcuts and help. Model, mode, approval, and credential actions use Host protocol, never local session-file reads or direct tool execution.
- Menus and modal panels must not consume ordinary draft input; closing them preserves drafts. Handle paste as one buffer, including newlines and approval-like keys. Preserve undo/redo and ignore Enter/Tab while file suggestions are still pending.
- Approvals use real target details and distinguish allow, deny, remember, and cancel; questions accept actual user answers only. Session-bound queues pause after cancellation and never replay automatically on restart.
- Save drafts and queues before releasing Host. Report failures without discarding text. Shared input history contains sent messages only. Exports are performed by Host and report per-file results.
- Keep terminal title and clipboard/editor operations bounded and restore terminal state on exit. Synthetic frame tests do not establish keyboard, narrow-terminal, or platform behavior.

Run `pnpm --filter ligule run build` and relevant `tui/tests/` checks; use real terminals for changes to input, approval, navigation, narrow layout, editor, or clipboard behavior.
