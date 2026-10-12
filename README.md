# ligule

[![npm](https://img.shields.io/npm/v/ligule?label=npm&color=4d6bfe)](https://www.npmjs.com/package/ligule)
[![Node.js](https://img.shields.io/static/v1?label=node&message=%3E%3D24&color=339933&logo=node.js&logoColor=white)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-22c55e.svg)](./LICENSE)

[简体中文](README.md) · [English](README.en.md)

<p align="center"><img src="docs/app-icon.png" alt="ligule 应用图标" width="112"></p>

ligule 是一个为项目工作、共享同一套 Agent 内核的 AI 助手，提供三种入口。三种入口共用工具执行、审批、模型请求和会话记录。

## 能力概览

- **连续处理项目任务**：会话归属工作区，支持从完整轮次创建分支和导出 Markdown。
- **掌控工具操作**：按规则或逐次审批工具调用；检查点压缩上下文，会话记录支持恢复。
- **按习惯选择入口**：CLI 提供脚本命令；TUI 和桌面版共用同一套 Agent 内核。

## 选择入口

| 入口 | 适合场景 | 启动方式 |
|---|---|---|
| CLI | 脚本、管道和单次任务 | `ligule run "检查项目结构并提出建议"` |
| TUI | 在终端持续对话与管理会话 | `ligule` |
| Desktop | 使用工作区侧栏、图形设置和会话操作 | 安装对应平台的桌面包后启动 |

CLI 与 TUI 需要 Node.js 24 或更新版本。TUI 需要交互式终端；脚本和管道使用 `ligule run`。桌面包的平台、系统要求和验证状态见[发行清单](docs/development/RELEASE.zh-cn.md)。

## 快速开始

首次使用前，请先配置模型服务，配置位置见下方「配置与数据」。

安装 CLI 和 TUI：

```sh
npm install -g ligule
```

### 命令行

```sh
cd /path/to/your-project
ligule run "检查项目结构并提出建议"
```

### 终端界面

```sh
cd /path/to/your-project
ligule
```

### 桌面界面

在 [GitHub Releases](https://github.com/xswt442-cmd/ligule/releases)下载。桌面版首次启动会准备默认工作区；也可以在设置中更改新会话使用的默认目录。

## 配置与数据

默认从 `~/.ligule/config.toml` 读取模型服务设置。最小配置示例：

```toml
[model]
api = "chat-completions"
baseURL = "https://api.example.com/v1"
model = "model-name"
apiKeyEnv = "MODEL_API_KEY"
```

把密钥放入 `apiKeyEnv` 指定的环境变量。桌面设置还支持多个服务与模型，并可将密钥保存到系统凭据库。设置 `LIGULE_HOME` 可将用户数据根改为另一绝对路径。工作区目录决定项目归属，`boundary` 单独限制文件工具可以访问的范围。

## 文档

- [简体中文使用手册](docs/guide.zh-CN.md) · [English user guide](docs/guide.en.md)
- [架构说明（中文）](docs/development/ARCHITECTURE.zh-cn.md) · [Architecture (English)](docs/development/ARCHITECTURE.en.md)
- [术语表（中文）](docs/development/GLOSSARY.zh-cn.md) · [Glossary (English)](docs/development/GLOSSARY.en.md)
- [贡献与验证（中文）](docs/development/CONTRIBUTING.zh-cn.md) · [Contributing and checks (English)](docs/development/CONTRIBUTING.en.md)
- [维护者发行清单（中文）](docs/development/RELEASE.zh-cn.md) · [Release checklist (English)](docs/development/RELEASE.en.md)

## LICENSE

[MIT](./LICENSE)
