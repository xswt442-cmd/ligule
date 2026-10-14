# 更新记录 / Changelog

本文件只记录 CLI/npm 产品中面向使用者的重要变化。桌面安装包和应用变化单独记录在 `desktop/CHANGELOG.md`。

This file records user-visible changes for the CLI/npm product only. Desktop installer and application changes are recorded separately in `desktop/CHANGELOG.md`.

## [Unreleased]

### 简体中文

- 改进 TUI 的工作区信任、会话控制和启动错误提示。

### English

- Improve TUI workspace trust, session controls, and startup error guidance.

## [0.0.3] - 2026-10-12

### 简体中文

#### 新增

- 新增共享 Agent 内核的命令行、终端界面和桌面界面，并提供工具、插件、技能与扩展入口。
- 新增按工作区归属的会话、已完成轮次分支、Markdown 导出、消息队列、输入恢复、检查点压缩和中断恢复。
- 桌面版新增多模型服务设置、系统凭据、待审批和待回答提醒、托盘与通知设置。
- CI 新增 Windows x64、Linux x64、macOS arm64 和 macOS x64 桌面安装包构建。

#### 变更

- 在交互式终端直接运行 `ligule` 会打开终端界面；单轮命令使用 `ligule run`。
- 会话记录默认保存在 `~/.ligule`，并支持使用 `LIGULE_HOME` 指定数据根。

#### 修复

- 取消工具调用时会终止其拥有的进程树；会话锁阻止多个进程同时写入同一记录。
- 恢复时不会重放没有记录结果的工具调用，并会将结果标记为未知。

### English

#### Added

- Added CLI, TUI, and desktop interfaces over one Agent kernel, with tools, plugins, skills, and extensions.
- Added workspace-owned sessions, branches from completed turns, Markdown export, message queues, input recovery, checkpoint compaction, and interrupted-turn recovery.
- Added desktop settings for multiple model services and system credentials, plus approval, question, tray, and notification controls.
- Added CI builds for Windows x64, Linux x64, macOS arm64, and macOS x64 desktop installers.

#### Changed

- Running `ligule` in an interactive terminal opens the TUI; use `ligule run` for a single request.
- Session records default to `~/.ligule`; set `LIGULE_HOME` to choose another data root.

#### Fixed

- Cancelling a tool call terminates its owned process tree; session locks prevent concurrent writers to one record.
- Recovery does not replay tool calls without recorded results and marks their outcomes as unknown.

## [0.0.1] - 2026-09-29

### 简体中文

初始公开版本。完整记录见 [v0.0.1 GitHub Release](https://github.com/xswt442-cmd/ligule/releases/tag/v0.0.1)。

### English

Initial public release. See the [v0.0.1 GitHub Release](https://github.com/xswt442-cmd/ligule/releases/tag/v0.0.1) for its published record.
