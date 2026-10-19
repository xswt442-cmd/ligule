# @ligule/core

[简体中文](README.md) · [English](README.en.md) · [项目主页](../README.md)

`@ligule/core` 是 Ligule 的**私有共享源代码包**，被 CLI/TUI 和 Desktop 集成，不单独发布 npm、版本号、Changelog 或 Tag。

Core 包含 Node.js **Host**（模型、配置、协议与会话管理）、**Kernel**（工具校验、Permission 与 Policy）、Session JSONL 存储与恢复、Provider 适配器和执行能力。依赖方向为 `tui → core ← desktop`，Core 不依赖前端或 Electron。

从仓库根目录运行 `pnpm run build:core` 和 `pnpm run test:core`。产品版本与发布记录分别由 [TUI](../tui/README.md) 和 [Desktop](../desktop/README.md) 维护。
