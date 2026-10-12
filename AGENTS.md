# Agent guide

These rules apply throughout the repository. Read the nearest local `AGENTS.md` before changing code under `src/kernel/`, `src/tools/`, `src/session/`, `src/host/`, `src/tui/`, or `desktop/`. The [architecture guide](docs/development/architecture.md) explains runtime ownership and data flow; [contributing](docs/development/contributing.md) lists development checks.

## Ownership and dependencies

- Node.js owns all business logic. CLI and TUI use the Node Host in process; the desktop Rust shell manages the process and windows and forwards protocol frames without interpreting them.
- The Host assembles the kernel from plugins and owns project environments, model providers, policy, and open sessions. The kernel has no built-in tools; registered tools call through kernel validation and policy.
- `src/kernel/` must not depend on client adapters. Put environment-sensitive operations under `src/capability/`; user-facing tool contracts belong under `src/tools/`. Keep protocol transport under `src/host/`.
- A workspace's `workspaceRoot` identifies its project environment and session ownership. `boundary` limits filesystem tools. They may differ and must remain separate.

## Runtime invariants

- Resolve a declared network target or command backend once, then pass that same result to policy and execution. Do not approve one target and execute another.
- Session JSONL is the source of truth. A writable session requires its cross-process lock; checkpoints and other summaries are derived and must be validated before use. Never replay an unresolved tool call during recovery.
- Configuration is layered and frozen into a snapshot before tools run. Expose configuration through explicit allowlists. Credentials are references: resolve a non-empty environment variable first, then the operating system credential store; Linux uses persistent Secret Service and reports failure when it is unavailable.
- `dataRoot()` is the single implementation of the user data directory. Respect absolute `LIGULE_HOME`; reject relative values. Do not construct the `.ligule` path independently elsewhere.
- A tool result, refusal, or failure must leave a result for each dispatched call in the session. Keep approval, question, cancellation, and event routing scoped to the originating session and request.
- Project configuration is untrusted input. Keep the merge protection against `__proto__`; tools receive the frozen configuration snapshot and injected logger, and must not write directly to process output.
- If command syntax cannot be parsed or its required backend is unavailable, fail closed with the existing error or approval path. Never approve a command from an incomplete parse.
- The Rust shell is transport and process lifecycle only. Do not add business rules, session ownership, or Host protocol interpretation there.

## Build, tests, and release

Use Node.js 24 or newer. `npm test` builds `dist/` before running tests; `npm run check-pack` checks the npm artifact. Desktop frontend and Rust checks are listed in [desktop/README.md](desktop/README.md). `RELEASE.md` is the source for installer targets, artifacts, and release status. CI artifacts do not mean a version has been published.

Keep `package.json`, lockfiles, `src/version.js`, Node engine declarations, and workflow versions consistent. New TypeScript modules use strict types and erasable syntax; do not add `enum`, `namespace`, or parameter properties. Generated `desktop/vendor/`, platform binaries, personal session data, credentials, and temporary test output do not belong in commits. Do not make release or publishing claims without checking the registry and GitHub Release state.

Branch changes, commits, pushes, resets, and file restoration require an explicit request. Preserve existing user changes and inspect the target before a requested Git operation.

Document current behavior and link to its maintained source. Keep the Chinese and English user guides aligned for commands, configuration keys, and stable error codes. Do not duplicate an implementation detail when a nearby source file or test is the maintained authority.

## Local guides

- [desktop/AGENTS.md](desktop/AGENTS.md) applies to the shell and frontend; its child guides cover [`frontend/`](desktop/frontend/AGENTS.md) and [`src-tauri/`](desktop/src-tauri/AGENTS.md).
- [src/kernel/AGENTS.md](src/kernel/AGENTS.md), [src/tools/AGENTS.md](src/tools/AGENTS.md), [src/session/AGENTS.md](src/session/AGENTS.md), [src/host/AGENTS.md](src/host/AGENTS.md), and [src/tui/AGENTS.md](src/tui/AGENTS.md) cover their respective directories.
