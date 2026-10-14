# Desktop frontend

The repository [Agent guide](../../AGENTS.md) and [desktop guide](../AGENTS.md) apply here. This Vite, React, and TypeScript frontend owns presentation and user input; the Host owns business state and files.

- Use `src/protocol.ts` for Host calls. The frontend must not read or write session/configuration files, run tools, or make model requests. `src/bridge.ts` adapts the fixed Electron Preload API. `window.__LIGULE_TRANSPORT__` is a development-only test seam, accepted only when the native bridge is absent.
- Keep each run, approval, question, cancellation, and notification target bound to its originating session and request ID. Background session events must not modify the foreground session's input or pending card.
- Render transcript rows as projections of Host events. Preserve event sequence numbers for search and navigation; local status rows have no record sequence. Load pages through the Host and keep large transcripts virtualized.
- Persist preferences through `prefs.read` and `prefs.write`. Treat browser storage `ligule.ui` as a first-screen cache and migrate it only when the data-root document is absent. Writes carry the read version; a read failure or version conflict must stop automatic saving.
- Keep drafts and queues in desktop preferences, separate from TUI input state. Sent input history uses the shared Host methods.
- Tool calls and reasoning follow the selected display-detail setting. Keep approval cards informative enough to review the requested command or change. User content, paths, and tool output remain unchanged by interface localization.
- Use `src/hotkeys.ts` as the source for shortcut display and handling. Composition or candidate-selection input must not trigger send, history navigation, panel close, or cancellation.
- Use `saveExportPath` from `src/bridge.ts` and hand the chosen path to the Host export method. The frontend must not gain general filesystem access. Render per-file export outcomes separately.
- Notification preferences and session routing stay in the frontend. Notifications may contain a conversation name and state, never prompt text, tool commands, or credentials. Electron Main sends native notifications and returns click targets. Capability support is not proof of operating-system permission; display this limitation accurately.
- Unsaved configuration edits and in-progress saves must pass through `src/edit-gate.ts` before closing Settings or changing sections.

Run `pnpm --filter ligule-desktop-frontend run check` and `pnpm --filter ligule-desktop-frontend run build`. The check command runs the existing projection, protocol, keyboard, quit, edit-gate, and notification checks.
