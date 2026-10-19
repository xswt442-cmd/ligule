# @ligule/core

[简体中文](README.md) · [English](README.en.md) · [Project home](../README.en.md)

`@ligule/core` is Ligule's **private shared source package**, integrated into CLI/TUI and Desktop. It has no standalone npm publication, version, changelog, or release tag.

Core contains the Node.js **Host** (models, configuration, protocol, and sessions), **Kernel** (tool validation, Permission, and Policy), Session JSONL storage and recovery, provider adapters, and execution capabilities. Dependencies flow `tui → core ← desktop`; Core does not depend on the UI or Electron.

From the repository root, run `pnpm run build:core` and `pnpm run test:core`. Product versions and release notes belong to [TUI](../tui/README.en.md) and [Desktop](../desktop/README.en.md).
