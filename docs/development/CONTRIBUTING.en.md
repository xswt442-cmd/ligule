# Contributing

[简体中文](CONTRIBUTING.zh-cn.md) · [English](CONTRIBUTING.en.md)

The repository contains the Node.js runtime, TUI, and Tauri desktop app. Read the root [Agent guide](../../AGENTS.md) and the local `AGENTS.md` for the directory you are changing before editing it. The [architecture guide](ARCHITECTURE.en.md) describes ownership and data flow; the [glossary](GLOSSARY.en.md) defines shared terms.

## Set up and validate

Use Node.js 24 or newer. From the repository root, install the locked dependencies and run the core checks:

```sh
npm ci
npm test
npm run check-pack
```

`npm test` builds `dist/` and runs the automated test suite. `check-pack` inspects the npm artifact. The release workflow also installs the packed artifact into a clean consumer and tests the host binary provided by `@vscode/ripgrep`.

For the desktop frontend, install its dependencies and run its checks and build:

```sh
npm --prefix desktop/frontend ci
npm --prefix desktop/frontend run check
npm --prefix desktop/frontend run build
```

Rust shell checks run with `cargo fmt --check` and `cargo test` from `desktop/src-tauri/`. To launch the complete desktop app during development, install `desktop/` dependencies and run `npm --prefix desktop run dev`; the shell starts the Node Host and embeds the frontend build for production packages.

## Keep changes verifiable

Document behavior from the implementation and its tests. Keep user-facing claims consistent in the Chinese and English guides, and distinguish automated coverage from platform or human verification. Do not put credentials, personal session records, or generated `desktop/vendor/` files in commits. Update a lockfile with its package manifest when a dependency changes.

The CI workflow checks the core package on Windows and Linux, exercises native credential storage on all four desktop targets, and builds the desktop installers on Windows x64, Linux x64, macOS arm64, and macOS x64. CI build artifacts are validation outputs; they are not public releases. The release workflow and current release state are documented in the [release checklist](RELEASE.en.md).

## Related guides

The [architecture guide](ARCHITECTURE.en.md) describes the dependency direction between the kernel and adapters. The [user guide](../guide.en.md) explains CLI, TUI, and desktop workflows.
