# Agent guide

These rules apply throughout the repository. Read the nearest local `AGENTS.md` before changing code under `core/src/`, `tui/src/`, or `desktop/`. The [architecture guide](docs/development/ARCHITECTURE.en.md) explains runtime ownership and data flow; [contributing](docs/development/CONTRIBUTING.en.md) lists development checks.

## Ownership and dependencies

- Node.js owns all business logic. CLI and TUI use the Node Host in process; Electron Main manages windows and the Host process while forwarding protocol frames without interpreting them.
- The Host assembles the kernel from plugins and owns project environments, model providers, policy, and open sessions. The kernel has no built-in tools; registered tools call through kernel validation and policy.
- Dependencies point `tui → core ← desktop`. Core is the private shared source package; it has no product version, changelog, tag, or release. Core must not import TUI, React, Ink, or Electron.
- `core/src/kernel/` must not depend on client adapters. Put environment-sensitive operations under `core/src/capability/`; model-callable tool contracts belong under `core/src/tools/`. Keep protocol transport under `core/src/host/`.
- A workspace's `workspaceRoot` identifies its project environment and session ownership. `boundary` limits filesystem tools. They may differ and must remain separate.

## Runtime invariants

- Resolve a declared network target or command backend once, then pass that same result to policy and execution. Do not approve one target and execute another.
- Session JSONL is the source of truth. A writable session requires its cross-process lock; checkpoints and other summaries are derived and must be validated before use. Never replay an unresolved tool call during recovery.
- Configuration is layered and frozen into a snapshot before tools run. Expose configuration through explicit allowlists. Credentials are references: resolve a non-empty environment variable first, then the operating system credential store; Linux uses persistent Secret Service and reports failure when it is unavailable.
- `dataRoot()` is the single implementation of the user data directory. Respect absolute `LIGULE_HOME`; reject relative values. Do not construct the `.ligule` path independently elsewhere.
- A tool result, refusal, or failure must leave a result for each dispatched call in the session. Keep approval, question, cancellation, and event routing scoped to the originating session and request.
- Project configuration is untrusted input. Keep the merge protection against `__proto__`; tools receive the frozen configuration snapshot and injected logger, and must not write directly to process output.
- If command syntax cannot be parsed or its required backend is unavailable, fail closed with the existing error or approval path. Never approve a command from an incomplete parse.
- Electron Main and Preload own desktop transport, native interactions, and process lifecycle. Keep session ownership, policy, and Host protocol semantics in Node.

## Build, tests, and release

Use Node.js 24 or newer and the workspace-pinned pnpm 12.9.1. Install development dependencies with `pnpm install --frozen-lockfile`; run the full module and integration suites with `pnpm test`, and check the npm artifact with `pnpm check-pack` and `pnpm verify-install`. Prepare the Desktop runtime with `pnpm run prepare-runtime`, then install Electron's platform binary with `pnpm --filter ligule-desktop exec install-electron`. Desktop build and acceptance commands are listed in [desktop/README.en.md](desktop/README.en.md). Use npm for clean-consumer checks of CLI tarballs. [docs/development/RELEASE.md](docs/development/RELEASE.md) is the maintainer reference for release scope and procedure. CI artifacts do not mean a version has been published.

Keep product manifests, `pnpm-lock.yaml`, `tui/src/version.ts`, Node engine declarations, and workflow versions consistent. Runtime source in `core/src/` and `tui/src/` is strict TypeScript and uses erasable syntax; do not add `enum`, `namespace`, or parameter properties. Generated `desktop/vendor/`, platform binaries, personal session data, credentials, and temporary test output do not belong in commits. Do not make release or publishing claims without checking the registry and GitHub Release state.

Branch changes, commits, pushes, resets, and file restoration require an explicit request. Preserve existing user changes and inspect the target before a requested Git operation.

Document current behavior and link to its maintained source. Keep the Chinese and English user guides aligned for commands, configuration keys, and stable error codes. Do not duplicate an implementation detail when a nearby source file or test is the maintained authority.

## Local guides

- [desktop/AGENTS.md](desktop/AGENTS.md) applies to the Electron shell and frontend; its child guide covers [`frontend/`](desktop/frontend/AGENTS.md).
- [core/src/kernel/AGENTS.md](core/src/kernel/AGENTS.md), [core/src/tools/AGENTS.md](core/src/tools/AGENTS.md), [core/src/session/AGENTS.md](core/src/session/AGENTS.md), [core/src/host/AGENTS.md](core/src/host/AGENTS.md), and [tui/AGENTS.md](tui/AGENTS.md) cover their respective directories.
