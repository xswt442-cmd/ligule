<div align="center">
  <img src="tui/docs/app-icon.png" alt="Ligule" width="88" height="88">
  <h1>Ligule</h1>
  <p>A CLI, TUI, and desktop AI assistant built on a shared Agent Core</p>
  <p>
    <a href="README.md">简体中文</a> ·
    <a href="https://github.com/xswt442-cmd/ligule/releases/latest">Download Desktop</a> ·
    <a href="tui/CHANGELOG.md">CLI/TUI changelog</a>
  </p>
  <p>
    <a href="https://github.com/xswt442-cmd/ligule/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/xswt442-cmd/ligule/actions/workflows/ci.yml/badge.svg?branch=main"></a>
    <a href="https://img.shields.io/npm/v/ligule"><img alt="npm" src="https://img.shields.io/npm/v/ligule?label=CLI%20%2F%20TUI&color=4d6bfe"></a>
    <a href="https://nodejs.org"><img alt="Node.js" src="https://img.shields.io/static/v1?label=node&message=%3E%3D24&color=339933&logo=node.js&logoColor=white"></a>
    <a href="https://github.com/xswt442-cmd/ligule/releases/latest"><img alt="Desktop release" src="https://img.shields.io/github/v/release/xswt442-cmd/ligule?label=Desktop&color=657483"></a>
    <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-22c55e.svg"></a>
  </p>
</div>

## Downloads

Get the desktop app from [GitHub Releases](https://github.com/xswt442-cmd/ligule/releases/latest). Windows packages use NSIS; Linux packages include AppImage and deb.

Install the CLI and TUI from npm:

```sh
npm install -g ligule
```

## Features

- **Shared project context:** sessions belong to workspaces, with branching from completed turns and Markdown export.
- **Controlled tool use:** use files, commands, Skills, and MCP under Policy and approval rules.
- **Three interfaces:** use the CLI for scripts and one-off tasks, or the TUI and desktop app for ongoing work.

## Agent framework

The CLI/TUI and desktop app share the Agent Core. The Node.js Host manages model requests, project configuration, Policy, and session records. Model-requested tool calls pass argument validation, target resolution, and permission checks before execution. The Electron app runs a separate Host process with the same session and tool semantics.

## Quick start

The CLI and TUI require Node.js 24 or newer. Run a one-off task from a project directory:

```sh
cd /path/to/your-project
ligule run "Review the project structure and suggest improvements"
```

Run `ligule` to start the terminal UI. The desktop app prepares a default workspace on first launch; you can change it in Settings.

## Configuration

Configure services and models in Desktop Settings. The CLI/TUI use the same configuration. See the [user guide](docs/guide.en.md) for configuration fields, credential sources, and model selection. Set `LIGULE_HOME` to an absolute path to change the user data root.

## Documentation

- [简体中文使用手册](docs/guide.zh-CN.md) · [User guide](docs/guide.en.md)
- [本地 MCP 指南](docs/mcp/mcp-guide.zh-CN.md) · [Local MCP guide](docs/mcp/mcp-guide.en.md)
- [架构说明](docs/development/ARCHITECTURE.zh-cn.md) · [Architecture](docs/development/ARCHITECTURE.en.md)
- [贡献与验证](docs/development/CONTRIBUTING.zh-cn.md) · [Contributing and checks](docs/development/CONTRIBUTING.en.md)
- [CLI/TUI changelog](tui/CHANGELOG.md) · [Desktop changelog](desktop/CHANGELOG.md)
- [Maintainer release procedure](docs/development/RELEASE.md)

## License

[MIT](LICENSE)
