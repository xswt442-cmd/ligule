# @ligule/core

`@ligule/core` is Ligule's private shared source package in the pnpm workspace. It is bundled into the two products and has no independent version, changelog, npm publication, or release tag.

The dependency direction is `tui → core ← desktop`. Core must not depend on the TUI, React, Ink, or Electron. It is not the Kernel: it contains the Kernel and its policy/tool execution path, the Host and protocol, Session storage and recovery, Model adapters, capabilities, and tools.

Build and test from the workspace root with `pnpm run build:core` and `pnpm run test:core`. Product versions and release notes live in `tui/` and `desktop/`; Core changes are included in a product's changelog only when that product's release contains the changed Core code.
