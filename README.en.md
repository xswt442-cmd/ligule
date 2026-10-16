# Ligule

Ligule is a shared-core agent harness with two products: the `ligule` CLI/TUI published to npm and the Electron Desktop app distributed through GitHub Releases.

## Workspace

- [`core/`](core/) — private shared Agent Core: Kernel, Host, Session, Model, Policy, capabilities, and tools.
- [`tui/`](tui/) — CLI and terminal UI, published as [`ligule`](https://www.npmjs.com/package/ligule).
- [`desktop/`](desktop/) — Electron Desktop product and its independent GitHub Release line.
- [`docs/`](docs/) — shared architecture, development, release, and user documentation.
- [`tests/`](tests/) and [`test/`](test/) — cross-product acceptance and shared test support.

The dependency direction is `tui → core ← desktop`. Core is private source shared by both products; it has no independent release, version, tag, or changelog.

## Development

Requires Node.js 24 and pnpm 12.9.1.

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm test
```

See [release rules](docs/development/RELEASE.md), [architecture](docs/development/ARCHITECTURE.en.md), and [contributing](docs/development/CONTRIBUTING.en.md).

## Products

- CLI/TUI: install with `npm install -g ligule`; run `ligule` for the interactive TUI or `ligule run "task"` for one round. See [TUI README](tui/README.en.md).
- Desktop: see [Desktop README](desktop/README.en.md).
