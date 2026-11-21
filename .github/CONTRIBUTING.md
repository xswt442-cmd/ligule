# Contributing

The detailed guides live in [`docs/development/CONTRIBUTING.en.md`](../docs/development/CONTRIBUTING.en.md) and [`docs/development/CONTRIBUTING.zh-cn.md`](../docs/development/CONTRIBUTING.zh-cn.md). This page records the rules GitHub and reviewers rely on; read the full guide for the desktop and benchmark procedures.

## Branches

Pull requests target `dev`. Maintainers review, then fast-forward `main` before a release. CI runs on pull requests and on pushes to `main` and `dev`. Tagging and publishing are maintainer actions that follow [`docs/development/RELEASE.md`](../docs/development/RELEASE.md).

## Pull request descriptions

Use [`.github/PULL_REQUEST_TEMPLATE.md`](PULL_REQUEST_TEMPLATE.md). A description states the change, the work completed, and the checks actually run, in a Simplified Chinese section and a matching English section. Deferred work belongs in an issue.

## Commit messages

Start the subject with a Conventional Commit type: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `perf:`, `build:`, `ci:`, `chore:`, or `release:`. Add a scope in parentheses when it clarifies the area (`fix(tui):`). Follow the colon with one sentence describing the change. One commit carries one type; split unrelated changes into separate commits.

## Documentation

`README.md` and `README.en.md` change together. The paired `*.zh-cn.md` and `*.en.md` guides under `docs/development/` change together, and `tui/CHANGELOG.md` and `desktop/CHANGELOG.md` each keep their Simplified Chinese and English sections in step. Tracked files contain no personal paths, credentials, private host details, or one-off verification logs. The pair declarations and the check commands live in [`AGENTS.md`](../AGENTS.md).

## Verification

From the repository root, with Node.js 24 or newer and the pinned pnpm:

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm check:syntax
```

`pnpm test` is the full suite: build, Core, TUI, cross-package integration, benchmark checks, and the engineering scripts under `.github/engineering/tests/`. For changes that affect the packaged CLI, also run `pnpm check-pack` and `pnpm verify-install`; the second installs the artifact into a clean consumer and performs a real search. The desktop checks, the MCP integration test, and the benchmark harness commands are listed in the full guide. State which checks you did not run rather than implying they passed.

## Security reports

Security findings follow [SECURITY.md](SECURITY.md).
