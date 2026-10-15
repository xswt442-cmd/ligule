# Desktop development

[简体中文](README.md) · [English](README.en.md)

The desktop app consists of the Electron Main and Preload processes in `electron/`, the React frontend in `frontend/`, and an independent Node Host. Main manages windows and the Host process; business logic and session state stay in the Node Host.

## Requirements and dependencies

Use Node.js 24 or newer. The root `package.json` pins pnpm; install the workspace dependencies from the repository root with the lockfile frozen:

```sh
pnpm install --frozen-lockfile
```

Electron `44.7.0`, electron-builder `26.15.3`, `@electron/fuses` `2.1.3`, and `builder-util` `26.15.3` are pinned as desktop development dependencies. The Electron npm package does not download its platform binary automatically; install the matching binary for the current operating system and architecture with its CLI:

```sh
pnpm --filter ligule-desktop exec install-electron
```

## Start the development app

Build the core package, prepare the local Node runtime and Host tree, and install the Electron binary before starting the desktop development entry from the repository root:

```sh
pnpm --filter ligule run build
pnpm --filter ligule run prepare-runtime
pnpm --filter ligule-desktop exec install-electron
pnpm --filter ligule-desktop run dev
```

The development entry compiles the Electron TypeScript, then starts Vite at the fixed address `http://localhost:5188/` and Electron. Only this entry passes `--dev` to Electron.

## Check the frontend

```sh
pnpm --filter ligule-desktop-frontend run check
pnpm --filter ligule-desktop-frontend run build
```

## Acceptance

Automated checks, real-window tests, and installer acceptance drivers live in `electron/test/`; run logs and acceptance notes remain in the Git-ignored `desktop/testplace/readings/` and are not distributed with the repository. Install dependencies, prepare the root Host and target Node runtime, then build the desktop app to generate Electron Main, the frontend, and the target application before running real-window tests. `run-installer-smoke.ps1` also requires a Windows NSIS installer build.

`run-stub-model.mjs` launches the real Electron Main process, production Preload, `app://` window, and independent Node Host; only the model endpoint is replaced by a deterministic local stub. In an isolated project it creates a test Skill and configures a real stdio MCP fixture, then checks Skill discovery, activation and body loading, MCP tool-definition disclosure, approval for Skill activation, approval for `mcp.inspect`, approval for `mcp.call`, the real MCP child process call, and the result recorded in the session. It needs no real model credential and does not count as real-model acceptance.

```sh
pnpm exec tsc -p desktop/electron/tsconfig.json
node --experimental-strip-types --test desktop/electron/test/host.test.ts desktop/electron/test/security.test.ts
```

On Linux and macOS, use the vendored Node to check POSIX process groups and start real windows. Linux needs `xvfb-run` for a display:

```sh
desktop/vendor/node/node --experimental-strip-types --test desktop/electron/test/posix-process-tree.test.ts
# Linux
xvfb-run -a desktop/vendor/node/node desktop/electron/test/run-native-security.mjs
xvfb-run -a desktop/vendor/node/node desktop/electron/test/run-stub-model.mjs
xvfb-run -a desktop/vendor/node/node desktop/electron/test/run-packaged-smoke.mjs --app-dir <absolute-path-to-extracted-app>
# macOS
desktop/vendor/node/node desktop/electron/test/run-native-security.mjs
desktop/vendor/node/node desktop/electron/test/run-stub-model.mjs
desktop/vendor/node/node desktop/electron/test/run-packaged-smoke.mjs --app-dir <absolute-path-to-ligule.app>
```

On Windows, use the vendored Node for the Job Object and native-dialog checks, then run the isolated NSIS installer acceptance:

```powershell
desktop/vendor/node/node.exe --experimental-strip-types --test desktop/electron/test/process-tree.test.ts
desktop/vendor/node/node.exe desktop/electron/test/run-native-security.mjs
desktop/vendor/node/node.exe desktop/electron/test/run-stub-model.mjs
desktop/vendor/node/node.exe desktop/electron/test/run-native-features.mjs
desktop/vendor/node/node.exe desktop/electron/test/run-packaged-smoke.mjs
powershell.exe -NoProfile -ExecutionPolicy Bypass -File desktop/electron/test/run-installer-smoke.ps1
```

To run the real-Electron stub acceptance with Skill and MCP coverage by itself, run `desktop/vendor/node/node.exe desktop/electron/test/run-stub-model.mjs` from the repository root. It writes an evidence report and removes its own temporary project after success; a failure retains the project and logs for diagnosis.

On Linux, wrap `run-native-security.mjs`, `run-stub-model.mjs`, and `run-packaged-smoke.mjs` with `xvfb-run -a`; macOS can run them directly. `posix-process-tree.test.ts` checks controlled shutdown and the orphan Host watchdog after forced Main termination; Windows uses `process-tree.test.ts` for Job Object behavior. Save-dialog and tray automation in `run-native-features.mjs` only runs on Windows. Notification clicks have no automated acceptance entry and must be recorded as not run; tray, notification, and click behavior still need manual checks on each target system. Real-window tests use isolated workspaces and data roots.

## Build the app

Build the core package and prepare the Node runtime for the current operating system and architecture:

```sh
pnpm --filter ligule run build
pnpm --filter ligule run prepare-runtime
pnpm --filter ligule-desktop exec install-electron
```

Then run the desktop build from the repository root:

```sh
pnpm --filter ligule-desktop run build
```

`pnpm --filter ligule-desktop run build:dir` creates an unpacked app directory for checking `app.asar` and packaged resources. `build:win`, `build:linux`, and `build:mac` create Windows x64 NSIS, Linux x64 AppImage and deb, and a DMG for the local macOS architecture. Build the arm64 and x64 macOS targets separately on machines with the matching architecture, after preparing that machine's runtime. The build rejects architecture flags that do not match the machine or the vendored Node runtime marker. Builds do not publish, use a Developer ID certificate, or notarize the app. To let a fused arm64 macOS app launch, the build resets Electron's required ad-hoc signature.

`pnpm --filter ligule run prepare-runtime` verifies the pnpm version declared by the root `packageManager`, then calls `fetch-runtime.mjs` to download and verify the Node archive in [`node-pin.json`](node-pin.json) and prepare `vendor/node/` and `vendor/app/`. The packaged Node and Host runtime tree live in the application resources directory; the app code, frontend files, and icons live in `app.asar`. The build disables Electron's RunAsNode, NODE_OPTIONS, and command-line inspection switches and requires Electron to load the app from `app.asar`. The Windows and macOS builds also enable embedded archive integrity validation.

Installers are written to `desktop/release/`. Prepare the runtime on the matching platform and architecture; do not reuse `vendor/` from another target.

## Application icons

[`assets/app-icon.png`](assets/app-icon.png) is the source image. Regenerate desktop icons on Windows with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File desktop/make-icons.ps1
node desktop/make-ico.mjs
```

The scripts write the PNG and ICO files to `desktop/icons/` and the frontend PNG to `desktop/frontend/public/`.
