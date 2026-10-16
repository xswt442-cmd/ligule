# Contributing

[简体中文](CONTRIBUTING.zh-cn.md) · [English](CONTRIBUTING.en.md)

The repository contains the Node.js runtime, TUI, and Electron desktop app. Read the root [Agent guide](../../AGENTS.md) and the local `AGENTS.md` for the directory you are changing before editing it. The [architecture guide](ARCHITECTURE.en.md) describes ownership and data flow; the [glossary](GLOSSARY.en.md) defines shared terms.

## Set up and validate

Use Node.js 24 or newer. The workspace pins pnpm to 12.9.1. From the repository root, install the locked dependencies and run the core checks:

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm check-pack
pnpm verify-install
```

`pnpm test` builds `dist/` and runs the automated test suite; `pnpm check-pack` inspects the CLI npm artifact; `pnpm verify-install` installs it into a clean consumer and performs a real search. The consumer install uses npm to verify the CLI's npm installation path.

## Desktop development

Prepare the local runtime tree and Electron binary, then run the frontend checks:

```sh
pnpm run build:core
pnpm run prepare-runtime
pnpm --filter ligule-desktop exec install-electron
pnpm exec tsc -p desktop/electron/tsconfig.json
node --experimental-strip-types --test desktop/electron/test/host.test.ts desktop/electron/test/security.test.ts
pnpm --filter ligule-desktop-frontend run check
pnpm --filter ligule-desktop-frontend run build
pnpm --filter ligule-desktop run dev
```

Installer builds, real-window checks, and native platform acceptance steps are in the [desktop development guide](../../desktop/README.en.md).

## Keep changes verifiable

Document behavior from the implementation and its tests. Keep user-facing claims consistent in the Chinese and English guides, and distinguish automated coverage from platform or human verification. Do not put credentials, personal session records, or generated `desktop/vendor/` files in commits. Update `pnpm-lock.yaml` when a dependency changes.

CI reports the core tests, clean CLI consumer install, native credential checks on all four desktop targets, and Electron installer builds on Windows x64, Linux x64, macOS arm64, and macOS x64 separately. CI artifacts are validation outputs, not public releases. The Chinese maintainer release scope and procedure are documented in the [release guide](RELEASE.md).

## Related guides

The [architecture guide](ARCHITECTURE.en.md) describes the dependency direction between the kernel and adapters. The [user guide](../guide.en.md) explains CLI, TUI, and desktop workflows.
