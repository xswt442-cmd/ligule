<div align="center">
  <img src="docs/app-icon.png" alt="Ligule" width="72" height="72">
  <h1>Ligule CLI / TUI</h1>
  <p>共享 Agent Core 的命令行与交互式终端 AI 助手</p>
  <p><a href="README.en.md">English</a> · <a href="../README.md">项目主页</a> · <a href="https://www.npmjs.com/package/ligule">npm</a></p>
  <p>
    <a href="https://img.shields.io/npm/v/ligule"><img alt="npm" src="https://img.shields.io/npm/v/ligule?label=CLI%20%2F%20TUI&color=4d6bfe"></a>
    <a href="https://nodejs.org"><img alt="Node.js" src="https://img.shields.io/static/v1?label=node&message=%3E%3D24&color=339933&logo=node.js&logoColor=white"></a>
  </p>
</div>

## 安装与启动

需要 **Node.js 24 或更新版本**。CLI 和 TUI 使用同一个 npm 包：

```sh
npm install -g ligule
```

在项目目录中执行单次任务：

```sh
ligule run "检查项目结构并提出建议"
```

自动化调用可添加 `--json`，从标准输出读取机器可读的运行终态：

```sh
ligule run --json "检查项目结构并提出建议"
```

结果包含 `status`、Host 持久 Session 终态事件中的 `state`、`sessionId`、Host 返回或接受事件记录的 `runId` 和模型调用计数；失败时输出稳定 `errorCode` 并以非零状态退出。未能验证终态事件时 `state` 为 `unknown`。回答正文、提示词和工具内容不会写入 JSON 输出。

CLI 单轮任务默认只读。只有明确使用 `ligule run --allow-full-access "..."` 才会为本次运行启用本机完整文件、进程和网络权限；Shell 命令以当前操作系统用户身份执行，不提供 OS 沙箱。此标志仅适用于 `run`，不能通过项目配置或模型调用启用。它不会绕过 Policy 审批、规则拒绝或危险命令硬拒绝。

运行 `ligule` 打开交互式 TUI，可进行持续对话、查看会话与审批，并选择模型及工具模式。

## 终端工作方式

- **CLI**：适合命令行中的一次性任务与自动化调用。
- **TUI**：通过 `/model` 选择模型，`/permission` 与 `/policy` 分别管理 Session 权限和审批规则。
- **Agent Control（外部控制）**：使用 `/control` 创建、查看和撤销项目专属 Grant，允许其他 Agent 通过本地 MCP 控制 Ligule；Grant 上限与 Policy 硬拒绝仍然生效。

## 本地 MCP

以当前受信任项目为目标启动 stdio MCP Server：

```sh
ligule mcp-server --project /path/to/project
```

默认不授予写入权限。已通过 `/control` 创建授权后，可在 MCP 客户端配置中指定 `--grant <id>`，需要代答**普通审批**时再选择 `--operator`；两者都不会自行赋予超出 Grant 的权限。受限 Shell 在缺少足够 OS Sandbox 时仍会拒绝执行。

## 配置与链接

CLI/TUI 与 [Desktop](../desktop/README.md) 共享 [Agent Core](../core/README.md) 的会话及工具语义。模型配置、凭据来源、MCP 配置和权限详见：

- [使用手册](docs/guide.zh-CN.md) · [本地 MCP 指南](../docs/mcp/mcp-guide.zh-CN.md)
- [CLI/TUI 更新记录](CHANGELOG.md)
- [贡献与验证](../docs/development/CONTRIBUTING.zh-cn.md)

[MIT](LICENSE)
