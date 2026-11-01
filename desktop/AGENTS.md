# Desktop

The [repository guide](../AGENTS.md) applies. Electron Main/Preload own native windows, transport, and process lifecycle; the separate Node Host owns policy, configuration, credentials, tools, and sessions. Renderer rules live in [frontend/AGENTS.md](frontend/AGENTS.md).

- Main forwards opaque Host protocol frames without interpreting business fields or importing kernel modules. Keep Main/Preload in strict TypeScript and use supported sandbox APIs.
- Create windows through `electron/secure-window.ts`: sandbox, context isolation, web security, CSP, default-deny permissions, navigation restrictions, and no Node integration or webviews. Production uses `app://ligule/index.html`; development uses `http://localhost:5188/`.
- `electron/ipc.ts` is the only IPC method table. Validate the owned window, top-level frame, exact origin, and arguments. Preload exposes fixed methods and cancellable subscriptions, never raw IPC, arbitrary files, or processes. The save dialog selects a path; Host performs export.
- Packaged Node, native dependencies, and `@vscode/ripgrep` must match the target OS and architecture. Do not reuse `vendor/` across platforms. Verify Electron Fuses and the real packaged executable; a successful build alone does not prove runtime or installer safety.
- Keep acceptance evidence in ignored local directories. Validate Windows and Linux separately; never infer macOS behavior from either platform.

Use [contributing checks](../docs/development/CONTRIBUTING.en.md): `pnpm --filter ligule-desktop run build`, frontend checks, Electron security/behavior tests, runtime integrity checks, and real-window tests when behavior changes.
