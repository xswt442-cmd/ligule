<div align="center">
  <img src="docs/app-icon.png" alt="Ligule" width="88" height="88">
  <h1>Ligule</h1>
  <p>A command-line and terminal AI assistant built on the shared Agent Core</p>
  <p>
    <a href="README.md">简体中文</a> ·
    <a href="https://github.com/xswt442-cmd/ligule/releases/latest">Downloads and releases</a> ·
    <a href="CHANGELOG.md">Changelog</a>
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

Get the latest desktop release from [GitHub Releases](https://github.com/xswt442-cmd/ligule/releases/latest). Each version includes checksums and release notes.

| Platform | Installer |
| --- | --- |
| Windows x64 | NSIS installer (`.exe`) |
| Linux x64 | AppImage (`.AppImage`) or Debian/Ubuntu package (`.deb`) |

Install the CLI and TUI from npm:

```sh
npm install -g ligule
```

## Features

- **Shared project context:** sessions belong to workspaces, with branching from completed turns and Markdown export.
- **Controlled tool use:** configure approval rules or review calls individually; extend the assistant with files, commands, Skills, and MCP.
- **Three interfaces:** use the CLI for scripts and one-off tasks, or the TUI and desktop app for ongoing work.

## Agent framework

The Node.js Host runs the Agent Loop and manages model requests, project configuration, and append-only session records. The kernel starts with an empty tool registry; the Host assembles plugins that register tools. Every model-requested tool call passes argument validation, target resolution, and approval policy before an allowed tool executes and its result is recorded. The CLI and TUI call the Host in-process. Electron Main manages a separate Host child process for the desktop app, while the React UI communicates through a sandboxed Preload API. All three interfaces share the same Agent execution and session semantics.

## Quick start

The CLI and TUI require Node.js 24 or newer. Configure a model service as described below before your first request.

Run a one-off task in a project directory:

```sh
cd /path/to/your-project
ligule run "Review the project structure and suggest improvements"
```

Start the terminal UI:

```sh
cd /path/to/your-project
ligule
```

The desktop app prepares a default workspace on first launch. Change the default directory for new sessions in Settings.

## Configuration

Model service settings are read from `~/.ligule/config.toml` by default:

```toml
[model]
api = "chat-completions"
baseURL = "https://api.example.com/v1"
model = "model-name"
apiKeyEnv = "MODEL_API_KEY"
```

Set the environment variable named by `apiKeyEnv`. Desktop settings also support multiple services and the OS credential store. Set `LIGULE_HOME` to an absolute path to move the user data root. The workspace directory identifies the project, while `boundary` separately limits which paths file tools can access.

## Documentation

- [简体中文使用手册](docs/guide.zh-CN.md) · [User guide](docs/guide.en.md)
- [架构说明（中文）](https://github.com/xswt442-cmd/ligule/blob/main/docs/development/ARCHITECTURE.zh-cn.md) · [Architecture](https://github.com/xswt442-cmd/ligule/blob/main/docs/development/ARCHITECTURE.en.md)
- [术语表（中文）](https://github.com/xswt442-cmd/ligule/blob/main/docs/development/GLOSSARY.zh-cn.md) · [Glossary](https://github.com/xswt442-cmd/ligule/blob/main/docs/development/GLOSSARY.en.md)
- [贡献与验证（中文）](https://github.com/xswt442-cmd/ligule/blob/main/docs/development/CONTRIBUTING.zh-cn.md) · [Contributing and checks](https://github.com/xswt442-cmd/ligule/blob/main/docs/development/CONTRIBUTING.en.md)
- [Changelog](CHANGELOG.md) · [Desktop changelog](https://github.com/xswt442-cmd/ligule/blob/main/desktop/CHANGELOG.md)
- [Maintainer release procedure](https://github.com/xswt442-cmd/ligule/blob/main/docs/development/RELEASE.md)

## License

[MIT](LICENSE)
