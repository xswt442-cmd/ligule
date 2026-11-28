# Testing and checks

[简体中文](TESTING.zh-CN.md) · [English](TESTING.en.md)

This page supplements the core commands in [CONTRIBUTING.md](../../.github/CONTRIBUTING.md) with package tests, documentation linters, desktop build checks, and benchmark commands.

## Core and integration tests

- Core tests live under `core/tests/`, TUI tests under `tui/tests/`, and cross-package integration tests under `tests/`.
- Tests are TypeScript (`*.test.ts`) and run with Node.js 24 type stripping. `pnpm build` typechecks Core, TUI, integration, and benchmark projects.
- `tests/mcp-server.test.ts` exercises external control using a real SDK stdio client, a local HTTP model endpoint, persistent Session records, Policy decisions, and child processes. Run it directly with:

```sh
node --experimental-strip-types --test --import ./tests/hooks/isolated-data-root.ts tests/mcp-server.test.ts
```

The standalone client in `tests/helpers/mcp-control.mjs` accepts explicit installed CLI and SDK paths so the same control calls can be checked outside the checkout. See the [Agent Control via MCP guide](../agent-control/guide.en.md) for tool and permission semantics. A deterministic model endpoint does not count as a real external model service test.

## Documentation and standard checks

Documentation changes use the skills under `.agents/skills/`: `mydocs` checks reader tasks, content ownership, and full-document consistency, while `myshuohua` checks formal technical Chinese. Run these checks before review, fix every `error`, and resolve each `warning`:

```sh
node .agents/skills/mydocs/scripts/lint-docs.mjs README.md README.en.md docs
node .agents/skills/myshuohua/scripts/lint-shuohua.mjs README.md README.en.md docs tui/CHANGELOG.md desktop/CHANGELOG.md core/README.md tui/README.md desktop/README.md
node .github/engineering/scripts/sync-community.mjs --check .
node --experimental-strip-types --test --test-reporter=./scripts/test-summary-reporter.mjs tests/docs.test.ts
```

## Desktop development and checks

Prepare the local runtime tree and Electron binary, then run the frontend and Electron checks:

```sh
pnpm run build:core
pnpm run prepare-runtime
pnpm --filter ligule-desktop exec install-electron
pnpm exec tsc -p desktop/electron/tsconfig.json
node --experimental-strip-types --test desktop/electron/tests/host.test.ts desktop/electron/tests/security.test.ts
pnpm --filter ligule-desktop-frontend run check
pnpm --filter ligule-desktop-frontend run build
pnpm --filter ligule-desktop run dev
```

Desktop frontend check scripts live under `desktop/frontend/tests/checks/`; development support stays under `desktop/frontend/dev/`. Cross-platform installers, real-window checks, and native acceptance require the matching Electron runtime. Confirm that the build target and runtime architecture match the operating system, and report platform coverage from checks actually run.

## Benchmarks

- `pnpm run bench:perf` runs the deterministic harness scenarios and writes raw samples plus JSON/Markdown summaries under `testplace/benchmarks/`, recording the Git SHA and platform.
- `pnpm run bench:agent` runs the frozen `terminal-bench@2.0` plan through the Harbor adapter. It requires Docker, a CLI tarball, provider settings, the frozen dataset, and a Node 24 Linux runtime for images without Node.
- A blocked prerequisite is reported as `BLOCKED`, never as a score. See [evals/perf/README.md](../../evals/perf/README.md) and [evals/agent/README.md](../../evals/agent/README.md).

## CI coverage

The default CI run covers the core tests, `pnpm check:dependencies`, and clean CLI consumer install on Windows and Linux, plus Desktop runtime and window checks on Windows x64 and Linux x64. A manually dispatched run can also check native credentials and Desktop compatibility on macOS arm64 and x64; those macOS jobs are allowed to fail. The regular CI workflow does not build installers; the [Desktop release workflow](../../.github/workflows/desktop-publish.yml) builds Windows and Linux installers when dispatched for a reviewed release tag. See [maintainer release procedure](RELEASE.md) for recovery steps.
