# Desktop frontend

The [repository guide](../../AGENTS.md) and [Desktop guide](../AGENTS.md) apply. React/Vite owns presentation; Host is authoritative for business state, permissions, and files.

- Send requests through `src/protocol.ts` and the fixed Preload adapter in `src/bridge.ts`. The frontend must not call tools, access session/configuration files, or request models directly. The development-only transport hook is unavailable when the native bridge exists.
- Bind streaming, approvals, questions, cancellations, and notifications to their original Session and request ID. Background events must not alter foreground drafts or pending cards.
- Render transcripts from Host events; retain sequence identity, paginate and virtualize large histories, and keep local-only status rows out of record indexing.
- Read and write preferences with Host version checks. Browser storage is only a first-screen cache; failures and version conflicts must not trigger automatic overwrites. Desktop drafts/queues are separate from shared sent-input history.
- Honor the selected tool/reasoning detail level and show actual approval targets and failure states. Do not alter user content while localizing UI labels. Keep shortcut display and handling consistent with `src/hotkeys.ts`; input composition cannot submit or cancel.
- Use the Preload save dialog to select export paths and show each Host export outcome. Native notifications may show a session name and state, never prompt text, commands, or credentials.
- Use `src/edit-gate.ts` to protect unsaved settings and in-progress saves when navigating or closing the UI.

Run `pnpm --filter ligule-desktop-frontend run check` and `pnpm --filter ligule-desktop-frontend run build`; verify changed controls through the actual frontend tests and desktop UI.
