<div align="center">
  <img src="docs/app-icon.png" alt="Ligule" width="88" height="88">
  <h1>Ligule</h1>
  <p>共享 Agent 内核的 CLI、TUI 与桌面 AI 助手</p>
  <p>
    <a href="README.en.md">English</a> ·
    <a href="https://github.com/xswt442-cmd/ligule/releases/latest">下载与版本记录</a> ·
    <a href="CHANGELOG.md">更新记录</a>
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

从 [GitHub Releases](https://github.com/xswt442-cmd/ligule/releases/latest) 获取最新桌面版；每个版本提供校验文件和发行说明。

| 平台 | 安装包 |
| --- | --- |
| Windows x64 | NSIS 安装程序（`.exe`） |
| Linux x64 | AppImage（`.AppImage`）或 Debian/Ubuntu 安装包（`.deb`） |

CLI 与 TUI 可通过 npm 安装：

```sh
npm install -g ligule
```

## 功能

- **共享项目上下文**：会话归属工作区，可从完整轮次创建分支并导出 Markdown。
- **可控的工具操作**：按规则或逐次审批；提供文件、命令、Skills、MCP 等扩展能力。
- **多种使用入口**：CLI 适合脚本与单次任务，TUI 和桌面版适合持续工作。

## Agent 框架

Ligule 以 Node.js Host 运行 Agent Loop，管理模型请求、项目配置和追加式会话记录。Kernel 从空工具注册表开始，由 Host 装配插件注册工具；模型发起的工具调用先经过参数校验、目标解析和审批策略，再执行获准的工具并记录结果。CLI 与 TUI 在 Node.js 进程内调用 Host；桌面版由 Electron Main 管理独立 Host 子进程，React 界面通过沙盒 Preload API 通信。三种入口因此共用同一套 Agent 执行与会话语义。

## 快速开始

CLI 与 TUI 需要 Node.js 24 或更新版本。首次使用前，请按下方「配置」设置模型服务。

在项目目录执行单次任务：

```sh
cd /path/to/your-project
ligule run "检查项目结构并提出建议"
```

启动终端界面：

```sh
cd /path/to/your-project
ligule
```

桌面版首次启动会准备默认工作区；新会话使用的默认目录可在设置中修改。

## 配置

默认从 `~/.ligule/config.toml` 读取模型服务设置：

```toml
[model]
api = "chat-completions"
baseURL = "https://api.example.com/v1"
model = "model-name"
apiKeyEnv = "MODEL_API_KEY"
```

将密钥放入 `apiKeyEnv` 指定的环境变量。桌面版还支持多服务设置和系统凭据库。设置 `LIGULE_HOME` 可将用户数据根改到另一绝对路径。工作区目录决定项目归属，`boundary` 单独限制文件工具的访问范围。

## 文档

- [使用手册（简体中文）](docs/guide.zh-CN.md) · [User guide (English)](docs/guide.en.md)
- [架构说明（中文）](docs/development/ARCHITECTURE.zh-cn.md) · [Architecture (English)](docs/development/ARCHITECTURE.en.md)
- [术语表（中文）](docs/development/GLOSSARY.zh-cn.md) · [Glossary (English)](docs/development/GLOSSARY.en.md)
- [贡献与验证（中文）](docs/development/CONTRIBUTING.zh-cn.md) · [Contributing and checks (English)](docs/development/CONTRIBUTING.en.md)
- [更新记录](CHANGELOG.md) · [桌面版更新记录](desktop/CHANGELOG.md)
- [维护者发行流程](docs/development/RELEASE.md)

## 许可证

[MIT](LICENSE)
