<div align="center">
  <h1>Ligule Desktop</h1>
  <p>An Electron AI assistant built on the shared Agent Core</p>
  <p><a href="README.md">简体中文</a> · <a href="../README.en.md">Project home</a> · <a href="https://github.com/xswt442-cmd/ligule/releases/latest">Download Desktop</a></p>
</div>

## Download and platforms

Get desktop packages and checksums from [GitHub Releases](https://github.com/xswt442-cmd/ligule/releases/latest):

- **Windows x64:** NSIS installer.
- **Linux x64:** AppImage or deb.

The desktop package bundles its Node.js Host; no separate Node.js installation is needed. Desktop and npm-distributed [CLI/TUI](../tui/README.en.md) have independent product versions and share the same [Agent Core](../core/README.en.md).

## Features

- **Workspaces and sessions:** create, resume, browse, and export conversations in the graphical interface, with records managed by the Host.
- **Models and tools:** manage providers and models in Settings → Model services; choose tool modes, Permission, and Policy for sessions, and review approvals and run progress.
- **Agent Control:** create or revoke project-bound grants in Settings → Agent Control for **local stdio MCP** controllers, setting permission, network, and Policy ceilings for other agents controlling Ligule sessions.

## Permissions and execution

File/command Permission and dangerous-operation Policy apply independently. Full access and unrestricted network access require explicit authorization; controllers cannot exceed their grant. Restricted Shell execution needs sufficient OS sandbox capabilities and is denied when they are unavailable. Electron handles windows and native UI; a separate Node.js Host owns model requests, tools, and sessions.

## More information

- [Desktop user guide](../docs/guide.en.md) · [Local MCP guide](../docs/mcp/mcp-guide.en.md)
- [Desktop changelog](CHANGELOG.md)
- [Contributing and checks](../docs/development/CONTRIBUTING.en.md) · [Maintainer release procedure](../docs/development/RELEASE.md)
