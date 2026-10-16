# 更新记录 / Changelog

本文件只记录 CLI/npm 产品中面向使用者的重要变化。桌面安装包和应用变化单独记录在 `desktop/CHANGELOG.md`。

This file records user-visible changes for the CLI/npm product only. Desktop installer and application changes are recorded separately in `desktop/CHANGELOG.md`.

## [Unreleased]

### 简体中文

### English

## [0.0.4] - 2026-10-14

### 简体中文

#### 终端界面与工作区

- 改进 TUI 的工作区信任提示与访问边界处理，让在项目目录中进行文件和命令操作时的授权决策更清楚。
- 优化会话控制与状态反馈，便于在终端中继续对话、取消操作和恢复已有会话；会话数据仍由共享 Host 维护。

#### 稳定性与使用方式

- 完善启动失败时的提示与排查信息，帮助识别工作区、终端环境或模型配置相关的问题。
- CLI 与 TUI 仍通过同一个 npm 包分发：在交互式终端运行 `ligule` 打开 TUI，单轮任务使用 `ligule run "任务内容"`；继续沿用现有的工具审批和会话恢复能力。

### English

#### Terminal UI and workspaces

- Improved workspace trust prompts and access-boundary handling in the TUI, making authorization decisions clearer before filesystem and command operations in a project.
- Refined session controls and status feedback for continuing conversations, cancelling operations, and resuming sessions; the shared Host continues to own session data.

#### Reliability and usage

- Improved startup failure messages and troubleshooting guidance for issues involving the workspace, terminal environment, or model configuration.
- CLI and TUI remain part of the same npm package: run `ligule` in an interactive terminal for the TUI or `ligule run "task"` for one-off requests. Existing tool approval and session recovery capabilities remain available.

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
