# ligule

[![npm](https://img.shields.io/npm/v/ligule?label=npm&color=4d6bfe)](https://www.npmjs.com/package/ligule)
[![Node.js](https://img.shields.io/static/v1?label=node&message=%3E%3D24&color=339933&logo=node.js&logoColor=white)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-22c55e.svg)](./LICENSE)

[简体中文](README.md) · [English](README.en.md)

<p align="center"><img src="docs/app-icon.png" alt="ligule app icon" width="112"></p>

ligule is an AI assistant for project work that shares one Agent kernel across three interfaces. All three share tool execution, approvals, model requests, and session records.

## What you can do

- **Keep project work in context:** sessions belong to workspaces, with branching from completed turns and Markdown export.
- **Control tool actions:** apply approval rules or review calls one at a time; checkpoints compact context, and session records support recovery.
- **Choose an interface:** use the CLI for scripts; the TUI and desktop app share the same Agent kernel.

## Choose an interface

| Interface | Best for | Start with |
|---|---|---|
| CLI | Scripts, pipelines, and one-off tasks | `ligule run "Review the project structure and suggest improvements"` |
| TUI | Ongoing conversations and session management in a terminal | `ligule` |
| Desktop | Workspace sidebar, visual settings, and session actions | Install the desktop package for your platform |

The CLI and TUI require Node.js 24 or newer. The TUI requires an interactive terminal; use `ligule run` in scripts and pipelines. Desktop targets, system requirements, and verification status are listed in the [release checklist](docs/development/RELEASE.en.md).

## Quick start

Before your first request, configure a model service as described under “Configuration and data” below.

Install the CLI and TUI:

```sh
npm install -g ligule
```

### Command line

```sh
cd /path/to/your-project
ligule run "Review the project structure and suggest improvements"
```

### Terminal UI

```sh
cd /path/to/your-project
ligule
```

### Desktop app

Download the desktop installer from [GitHub Releases](https://github.com/xswt442-cmd/ligule/releases). On first launch, the desktop app prepares a default workspace. You can change the default directory for new sessions in Settings.

## Configuration and data

Model service settings are read from `~/.ligule/config.toml` by default. Minimal example:

```toml
[model]
api = "chat-completions"
baseURL = "https://api.example.com/v1"
model = "model-name"
apiKeyEnv = "MODEL_API_KEY"
```

Set the environment variable named by `apiKeyEnv`. Desktop settings also support multiple services and models, and can store keys in the system credential store. Set `LIGULE_HOME` to an absolute path to move the user data root. The workspace directory identifies the project; `boundary` separately limits which paths file tools can access.

## Documentation

- [简体中文使用手册](docs/guide.zh-CN.md) · [English user guide](docs/guide.en.md)
- [架构说明（中文）](docs/development/ARCHITECTURE.zh-cn.md) · [Architecture (English)](docs/development/ARCHITECTURE.en.md)
- [术语表（中文）](docs/development/GLOSSARY.zh-cn.md) · [Glossary (English)](docs/development/GLOSSARY.en.md)
- [贡献与验证（中文）](docs/development/CONTRIBUTING.zh-cn.md) · [Contributing and checks (English)](docs/development/CONTRIBUTING.en.md)
- [维护者发行清单（中文）](docs/development/RELEASE.zh-cn.md) · [Release checklist (English)](docs/development/RELEASE.en.md)

## License

[MIT](./LICENSE)
