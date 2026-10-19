<div align="center">
  <img src="docs/app-icon.png" alt="Ligule" width="72" height="72">
  <h1>Ligule CLI / TUI</h1>
  <p>A command-line and interactive terminal AI assistant built on the shared Agent Core</p>
  <p><a href="README.md">简体中文</a> · <a href="../README.en.md">Project home</a> · <a href="https://www.npmjs.com/package/ligule">npm</a></p>
  <p>
    <a href="https://img.shields.io/npm/v/ligule"><img alt="npm" src="https://img.shields.io/npm/v/ligule?label=CLI%20%2F%20TUI&color=4d6bfe"></a>
    <a href="https://nodejs.org"><img alt="Node.js" src="https://img.shields.io/static/v1?label=node&message=%3E%3D24&color=339933&logo=node.js&logoColor=white"></a>
  </p>
</div>

## Install and run

Requires **Node.js 24 or newer**. CLI and TUI ship in the same npm package:

```sh
npm install -g ligule
```

Run a one-off task in a project directory:

```sh
ligule run "Review the project structure and suggest improvements"
```

Run `ligule` to open the interactive TUI for ongoing conversations, session and approval review, and model or tool-mode selection.

## Terminal workflows

- **CLI:** one-off command-line tasks and automation.
- **TUI:** choose models with `/model`, and manage session Permission and approval Policy separately with `/permission` and `/policy`.
- **Agent Control:** use `/control` to create, view, and revoke project-bound grants so other agents can control Ligule through local MCP. Grant ceilings and hard Policy denials remain in force.

## Local MCP

Start the stdio MCP server for a trusted project:

```sh
ligule mcp-server --project /path/to/project
```

Write access is not granted by default. Once a grant has been created with `/control`, select it in the MCP client's configuration using `--grant <id>`. Add `--operator` only when ordinary approval replies are delegated; neither option allows permissions beyond the grant. Restricted Shell execution is still denied without sufficient OS sandbox support.

## Configuration and links

CLI/TUI shares the [Agent Core](../core/README.en.md) session and tool semantics with [Desktop](../desktop/README.en.md). For model settings, credentials, MCP configuration, and permissions, see:

- [User guide](docs/guide.en.md) · [Local MCP guide](../docs/mcp/mcp-guide.en.md)
- [CLI/TUI changelog](CHANGELOG.md)
- [Contributing and checks](../docs/development/CONTRIBUTING.en.md)

[MIT](LICENSE)
