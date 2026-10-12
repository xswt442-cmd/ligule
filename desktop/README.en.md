# Desktop development

[简体中文](README.md) · [English](README.en.md)

The desktop app has a React and TypeScript frontend in [`frontend/`](frontend/), a Rust and Tauri shell in [`src-tauri/`](src-tauri/), and a Node Host process. The frontend owns presentation and sends Host protocol calls through Tauri. The shell manages windows and forwards newline-delimited frames; business logic and session state stay in Node. See the [architecture guide](../docs/development/ARCHITECTURE.en.md) for the complete request path.

## Prerequisites

Use Node.js 24 or newer and the stable Rust toolchain. Windows builds require WebView2. Linux builds require the Tauri system libraries listed in the [CI workflow](../.github/workflows/ci.yml). macOS builds use the target runner's native architecture. Supported installer targets and verification status are listed in the [release checklist](../docs/development/RELEASE.en.md).

Install each package tree from the repository root:

```sh
npm ci
npm --prefix desktop ci
npm --prefix desktop/frontend ci
```

## Start the development app

Start the Vite frontend and Tauri shell together:

```sh
npm --prefix desktop run dev
```

The shell starts the Node Host. The frontend uses the Tauri transport in a desktop window; its `dev/` page can also run against a local fake Host for focused interface checks.

## Check the frontend

Run the frontend assertions and production build with:

```sh
npm --prefix desktop/frontend run check
npm --prefix desktop/frontend run build
```

## Check the Rust shell

From the repository root, run:

```sh
cd desktop/src-tauri
cargo fmt --check
cargo test
```

The frontend build runs TypeScript checking before Vite. The Rust tests cover process entry resolution, line-based frame forwarding, host replacement, tray and notification input rules. CI builds each installer target on its matching platform runner; those artifacts are validation outputs until a release is published.

## Build an installer

Complete these steps in order:

1. Build the core package and platform search packages:

   ```sh
   npm run build
   npm run build-rg
   ```

2. Prepare the Node runtime tree on the target platform:

   ```sh
   node desktop/fetch-runtime.mjs
   ```

3. Build the desktop installer:

   ```sh
   npm --prefix desktop run build
   ```

The app bundles a pinned Node runtime and a production runtime tree.
`fetch-runtime.mjs` downloads the Node archive named in [`node-pin.json`](node-pin.json), verifies its checksum, and copies the built app plus production dependencies into `desktop/vendor/`. The runtime tree is platform-specific and is generated locally. Tauri embeds it when building the installer. The target-specific bundle format comes from `tauri.*.conf.json`; do not reuse `desktop/vendor/` across operating systems or architectures.

The output locations and installer formats are recorded in the [release checklist](../docs/development/RELEASE.en.md). To inspect the bundled runtime before building, run `desktop/check-runtime.mjs` with the Node executable under `desktop/vendor/node/` for the current platform.

## Application icons

[`assets/app-icon.png`](assets/app-icon.png) is the source image. On Windows, regenerate the frontend and Tauri icon assets with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File desktop/make-icons.ps1
node desktop/make-ico.mjs
```

The scripts write generated files under `desktop/frontend/public/` and `desktop/src-tauri/icons/`. Review the resulting assets before committing them.
