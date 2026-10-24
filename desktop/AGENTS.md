# Desktop

`desktop/` contains Electron Main, the sandboxed Preload, and the React Renderer. The repository root [Agent guide](../AGENTS.md) also applies. Frontend rules are in [frontend/AGENTS.md](frontend/AGENTS.md). Build and run instructions are in [Contributing and checks](../docs/development/CONTRIBUTING.en.md). The Desktop directory is not included in the npm package.

`electron/` Main manages windows, native interactions, the managed Host process, and opaque protocol frames. The separate Node 24 Host is the only business runtime and owns the Kernel, Policy, Session, configuration, and credentials. Main must not import those business modules or rewrite business fields in protocol frames.

Run the following commands from the repository root:

```sh
pnpm --filter ligule-desktop run dev
pnpm --filter ligule-desktop run build
pnpm --filter ligule-desktop-frontend run check
node --experimental-strip-types --test desktop/electron/test/host.test.ts desktop/electron/test/security.test.ts
desktop/vendor/node/node.exe desktop/electron/test/run-native-security.mjs
desktop/vendor/node/node.exe desktop/electron/test/run-native-features.mjs
desktop/vendor/node/node.exe desktop/electron/test/run-stub-model.mjs
```

Use the executable tests under `electron/test/` for acceptance. Original logs and local acceptance records belong in the ignored `desktop/testplace/readings/` directory. Verify each platform separately; Windows results do not establish acceptance on Linux or macOS.

Keep Main and Preload in strict TypeScript, using the existing TypeScript compiler; NodeNext imports use the `.js` suffix. Preload runtime code depends only on Electron APIs supported by the sandbox; `api.ts` provides types shared by both sides.

Create windows through `secure-window.ts`: explicitly enable sandboxing, context isolation, and web security; disable Node integration, webview, and insecure content. The production page is fixed at `app://ligule/index.html`; the development page is fixed at `http://localhost:5188/`. Preserve CSP, default-deny browser permissions, and navigation and external-link restrictions.

`ipc.ts` is the only Main IPC method table. Each handler validates the managed window, top-level frame, exact page origin, and parameters. Preload exposes only fixed actions and cancellable subscriptions; it does not expose dynamic channels, raw events, arbitrary file access, or process operations. The save dialog only selects a path; the Host performs file export.

Release configuration lives in `electron-builder.cjs`. Use the Node runtime, native dependencies, and optional `@vscode/ripgrep` package for the current target. Do not reuse `vendor/` across platforms or architectures. Read and verify production Fuses on the actual executable; a successful package build does not establish acceptance of the Host, process tree, window, or installer.

`fetch-runtime.mjs` prepares the packaged runtime tree from `node-pin.json`. Use its Node executable to run `check-runtime.mjs --vendor desktop/vendor`. After packaging, use the Node executable in the resources directory to run `check-runtime.mjs --resources <resource-directory>` and check the CLI, command syntax, Keyring, and real search backend. Verify security and native behavior in a real Electron window, recording the tested platforms and anything left unverified.
