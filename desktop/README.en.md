# Desktop development

[简体中文](README.md) · [English](README.en.md)

The desktop app consists of the Electron Main and Preload processes in `electron/`, the React frontend in `frontend/`, and an independent Node Host. Main manages windows and the Host process; business logic and session state stay in the Node Host.

## Requirements and dependencies

Use Node.js 24 or newer. Install the repository, desktop, and frontend dependencies separately:

```sh
npm ci
npm --prefix desktop ci
npm --prefix desktop/frontend ci
```

Electron `44.7.0`, electron-builder `26.15.3`, and `@electron/fuses` `2.1.3` are pinned as development dependencies in the desktop package.

## Start the development app

Build the core package and prepare the local Node runtime and Host tree first, then start the desktop development entry from the repository root:

```sh
npm run build
node desktop/fetch-runtime.mjs
npm --prefix desktop run dev
```

The development entry compiles the Electron TypeScript, then starts Vite at the fixed address `http://localhost:5188/` and Electron. Only this entry passes `--dev` to Electron.

## Check the frontend

```sh
npm --prefix desktop/frontend run check
npm --prefix desktop/frontend run build
```

## Acceptance

Automated checks, real-window tests, and installer acceptance drivers live in `electron/test/`; run logs and acceptance notes remain in the Git-ignored `desktop/testplace/readings/` and are not distributed with the repository. Run these in order on Windows:

```sh
node node_modules/typescript/bin/tsc -p desktop/electron/tsconfig.json
node --experimental-strip-types --test desktop/electron/test/host.test.ts desktop/electron/test/security.test.ts
desktop/vendor/node/node.exe --experimental-strip-types --test desktop/electron/test/process-tree.test.ts
desktop/vendor/node/node.exe desktop/electron/test/run-native-security.mjs
desktop/vendor/node/node.exe desktop/electron/test/run-native-features.mjs
desktop/vendor/node/node.exe desktop/electron/test/run-stub-model.mjs
desktop/vendor/node/node.exe desktop/electron/test/run-packaged-smoke.mjs
powershell.exe -NoProfile -ExecutionPolicy Bypass -File desktop/electron/test/run-installer-smoke.ps1
```

Before launching Electron directly from Git Bash, run `unset ELECTRON_RUN_AS_NODE NODE_OPTIONS NODE_PATH`, otherwise the harness script is executed as a plain Node script. The real-window and installer cases only use isolated test workspaces and data roots, and write their evidence into the ignored `desktop/testplace/readings/`. `run-native-features.mjs` only offers save-dialog automation on Windows; `run-real-model.mjs` also needs the local credential record and depends on the shared-runtime streaming parser fix.

## Build the app

Build the core package and prepare the Node runtime for the current operating system and architecture:

```sh
npm run build
node desktop/fetch-runtime.mjs
```

Then run the desktop build from the repository root:

```sh
npm --prefix desktop run build
```

`npm --prefix desktop run build:dir` creates an unpacked app directory for checking `app.asar` and packaged resources. `build:win`, `build:linux`, and `build:mac` create Windows x64 NSIS, Linux x64 AppImage and deb, and a DMG for the local macOS architecture. Build the arm64 and x64 macOS targets separately on machines with the matching architecture, after preparing that machine's runtime. The build rejects architecture flags that do not match the machine or the vendored Node runtime marker. Builds do not publish, use a Developer ID certificate, or notarize the app. To let a fused arm64 macOS app launch, the build resets Electron's required ad-hoc signature.

`fetch-runtime.mjs` downloads and verifies the Node archive named in [`node-pin.json`](node-pin.json), then prepares `vendor/node/` and `vendor/app/`. The packaged Node and Host runtime tree live in the application resources directory; the app code, frontend files, and icons live in `app.asar`. The build disables Electron's RunAsNode, NODE_OPTIONS, and command-line inspection switches and requires Electron to load the app from `app.asar`. The Windows and macOS builds also enable embedded archive integrity validation.

Installers are written to `desktop/release/`. Prepare the runtime on the matching platform and architecture; do not reuse `vendor/` from another target.

## Application icons

[`assets/app-icon.png`](assets/app-icon.png) is the source image. Regenerate desktop icons on Windows with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File desktop/make-icons.ps1
node desktop/make-ico.mjs
```

The scripts write the PNG and ICO files to `desktop/icons/` and the frontend PNG to `desktop/frontend/public/`.
