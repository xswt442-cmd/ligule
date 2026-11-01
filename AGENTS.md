# Ligule engineering guide

Follow this file and the nearest module `AGENTS.md`. Current implementation and tests take precedence over historical notes. See [architecture](docs/development/ARCHITECTURE.en.md), [contributing](docs/development/CONTRIBUTING.en.md), and the [engineering standard](.github/engineering/ENGINEERING_STANDARD.md).

## Architecture and safety

- Node Host owns business logic, project environments, sessions, and policy. The kernel executes only registered tools; clients communicate through Host protocols. Dependencies flow `tui → core ← desktop`; private Core has no separate release and must not depend on Electron, Ink, React, or TUI.
- Keep `workspaceRoot` (project identity) distinct from the filesystem tool `boundary`. Resolve network targets and command backends once, then use that same resolved target for approval and execution.
- Session JSONL is authoritative. Writable sessions need a cross-process lock; derived checkpoints are validated before use. Recovery records unknown outcomes and never replays unresolved tools.
- Configuration is layered and snapshot-based. Treat project input as untrusted; preserve the `__proto__` merge guard and public-field allowlists. `dataRoot()` owns user-data paths: `LIGULE_HOME` must be absolute. Resolve credentials from a nonempty environment variable or OS credential store; never expose values in records, logs, or configuration.
- Keep approvals, questions, events, cancellation, and tool results bound to the initiating Session and request. Reject unsupported parsing or unavailable execution backends rather than silently falling back.
- Electron Main/Preload own native transport and lifecycle; Host owns session and permission decisions.

## Development

- Use Node.js 24+ and pinned pnpm 12.9.1. Run `pnpm install --frozen-lockfile` and relevant tests; `pnpm test` is the full suite. Use `pnpm check-pack` and `pnpm verify-install` for CLI release changes. See [release procedures](docs/development/RELEASE.md) for Desktop and publication checks.
- Core and TUI runtime TypeScript uses erasable syntax; avoid `enum`, `namespace`, and parameter properties. Keep package manifests, lockfile, engine declarations, and workflow versions consistent.
- Keep generated binaries, `desktop/vendor/`, credentials, Session data, and temporary test output untracked. Preserve existing work; branch, commit, push, merge, restore, tag, and publish only with explicit authorization.
- Document implemented behavior only. Keep Simplified Chinese and English guides aligned; do not duplicate source-owned details or add private paths and one-off verification logs to tracked documents.

## Module guides

[Host](core/src/host/AGENTS.md) · [Kernel](core/src/kernel/AGENTS.md) · [Sessions](core/src/session/AGENTS.md) · [Tools](core/src/tools/AGENTS.md) · [TUI](tui/AGENTS.md) · [Desktop](desktop/AGENTS.md) · [Frontend](desktop/frontend/AGENTS.md).
