<div align="center">
  <h1>Ligule Desktop</h1>
  <p>共享 Agent Core 的 Electron 桌面 AI 助手</p>
  <p><a href="README.en.md">English</a> · <a href="../README.md">项目主页</a> · <a href="https://github.com/xswt442-cmd/ligule/releases/latest">下载桌面版</a></p>
</div>

## 下载与支持平台

在 [GitHub Releases](https://github.com/xswt442-cmd/ligule/releases/latest) 获取桌面安装包和校验文件：

- **Windows x64**：NSIS 安装程序。
- **Linux x64**：AppImage 或 deb。

桌面安装包自带 Node.js Host，无须单独安装 Node.js。Desktop 与 npm 发行的 [CLI/TUI](../tui/README.md) 分别维护版本；业务执行使用同一套 [Agent Core](../core/README.md)。

## 主要功能

- **工作区与会话**：通过图形界面新建、继续、查看和导出对话；使用 Host 管理会话记录。
- **模型与工具**：在「设置 → 模型服务」管理 Provider 与模型；在会话中选择工具模式、Permission 和 Policy，查看审批与运行进度。
- **Agent Control（外部控制）**：在「设置 → 外部控制」为**本地 stdio MCP** 创建或撤销项目专属 Grant，定义权限、网络和 Policy 上限，供其他 Agent 控制 Ligule 会话。

## 权限与执行

文件/命令 Permission 与危险操作 Policy 分别生效。完整访问和不受限网络需要明确授权，Agent Control 控制者不能超过 Grant 的上限。受限 Shell 需要操作系统提供足够的 Sandbox 能力；不满足时会拒绝执行。Electron 负责窗口与本机交互，模型请求、工具和会话由独立 Node.js Host 处理。

## 更多信息

- [桌面版使用手册](../docs/guide.zh-CN.md) · [本地 MCP 指南](../docs/mcp/mcp-guide.zh-CN.md)
- [Desktop 更新记录](CHANGELOG.md)
- [贡献与验证](../docs/development/CONTRIBUTING.zh-cn.md) · [维护者发行流程](../docs/development/RELEASE.md)
