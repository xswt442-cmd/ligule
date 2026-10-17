<div align="center">
  <img src="tui/docs/app-icon.png" alt="Ligule" width="88" height="88">
  <h1>Ligule</h1>
  <p>共享 Agent Core 的 CLI、TUI 与桌面 AI 助手</p>
  <p>
    <a href="README.en.md">English</a> ·
    <a href="https://github.com/xswt442-cmd/ligule/releases/latest">桌面版下载</a> ·
    <a href="tui/CHANGELOG.md">CLI/TUI 更新记录</a>
  </p>
  <p>
    <a href="https://github.com/xswt442-cmd/ligule/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/xswt442-cmd/ligule/actions/workflows/ci.yml/badge.svg?branch=main"></a>
    <a href="https://img.shields.io/npm/v/ligule"><img alt="npm" src="https://img.shields.io/npm/v/ligule?label=CLI%20%2F%20TUI&color=4d6bfe"></a>
    <a href="https://nodejs.org"><img alt="Node.js" src="https://img.shields.io/static/v1?label=node&message=%3E%3D24&color=339933&logo=node.js&logoColor=white"></a>
    <a href="https://github.com/xswt442-cmd/ligule/releases/latest"><img alt="Desktop release" src="https://img.shields.io/github/v/release/xswt442-cmd/ligule?label=Desktop&color=657483"></a>
    <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-22c55e.svg"></a>
  </p>
</div>

## 下载

桌面版从 [GitHub Releases](https://github.com/xswt442-cmd/ligule/releases/latest) 下载。Windows 提供 NSIS 安装程序，Linux 提供 AppImage 与 deb。

CLI 与 TUI 通过 npm 安装：

```sh
npm install -g ligule
```

## 功能

- **共享项目上下文**：会话归属工作区，可从已完成轮次创建分支并导出 Markdown。
- **受控的工具操作**：使用文件、命令、Skills 与 MCP，并由 Policy 和审批规则约束。
- **三种使用入口**：CLI 适合单次任务与脚本，TUI 和桌面版适合持续工作。

## Agent 框架

Ligule 的 CLI/TUI 与桌面版共用 Agent Core。Node.js Host 管理模型请求、项目配置、Policy 和会话记录；模型发起的工具调用经过参数校验、目标解析和权限判定后执行。Electron 桌面版通过独立 Host 进程运行，使用相同的会话和工具语义。

## 快速开始

CLI 与 TUI 需要 Node.js 24 或更新版本。安装后，在项目目录执行单次任务：

```sh
cd /path/to/your-project
ligule run "检查项目结构并提出建议"
```

运行 `ligule` 可启动终端界面。桌面版首次启动会准备默认工作区；之后可在设置中调整。

## 配置

桌面版在「设置 → 模型服务」中配置服务与模型；CLI/TUI 使用同一配置。完整字段、凭据来源和模型选择方式见[使用手册](docs/guide.zh-CN.md)。`LIGULE_HOME` 可设置为绝对路径，用于更换用户数据根目录。

## 文档

- [使用手册（简体中文）](docs/guide.zh-CN.md) · [User guide (English)](docs/guide.en.md)
- [本地 MCP 指南（中文）](docs/mcp/mcp-guide.zh-CN.md) · [Local MCP guide](docs/mcp/mcp-guide.en.md)
- [架构说明](docs/development/ARCHITECTURE.zh-cn.md) · [Architecture](docs/development/ARCHITECTURE.en.md)
- [贡献与验证](docs/development/CONTRIBUTING.zh-cn.md) · [Contributing and checks](docs/development/CONTRIBUTING.en.md)
- [CLI/TUI 更新记录](tui/CHANGELOG.md) · [桌面版更新记录](desktop/CHANGELOG.md)
- [维护者发行流程](docs/development/RELEASE.md)

## 许可证

[MIT](LICENSE)
