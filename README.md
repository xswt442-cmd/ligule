# ligule

[![npm](https://img.shields.io/npm/v/ligule?label=npm&color=4d6bfe)](https://www.npmjs.com/package/ligule)
[![Node.js](https://img.shields.io/static/v1?label=node&message=%3E%3D24&color=339933&logo=node.js&logoColor=white)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-22c55e.svg)](./LICENSE)

ligule 是一个共享 Agent 内核的命令行、终端和桌面助手。三种界面共用工具执行、审批、模型请求与会话记录。当前仓库版本为 `0.0.2`；仓库版本与 CI 构建结果不代表已经发布，发行状态见[发行清单](docs/RELEASE.md)。

## 安装和启动

命令行与终端界面需要 Node.js 24 或更新版本。安装 npm 上已发布的版本：

```sh
npm install -g ligule
```

在项目目录中运行一轮：

```sh
ligule run "检查项目结构并提出建议"
```

运行 `ligule tui` 打开终端界面。TUI 需要交互式终端；脚本和管道使用 `ligule run`。桌面安装包的目标平台、系统要求和验收状态见[发行清单](docs/RELEASE.md)。

## 配置

CLI 与 TUI 默认从 `<用户数据根>/config.toml` 读取模型设置；用户数据根默认是 `~/.ligule`。下面的单服务格式继续可用：

```toml
[model]
api = "chat-completions"
baseURL = "https://api.example.com/v1"
model = "model-name"
apiKeyEnv = "MODEL_API_KEY"
```

将密钥放入 `apiKeyEnv` 指定的环境变量。桌面设置还支持保存多个服务与模型，并可把密钥写入系统凭据库。设置、配置层与生效时机见[中文使用手册](docs/guide.zh-CN.md)和[English user guide](docs/guide.en.md)。

设置 `LIGULE_HOME` 可以将用户数据根改到另一处；值必须是绝对路径。工具文件访问范围由工作区目录与 `boundary` 配置共同决定。

## 开发文档

- [架构说明](docs/development/architecture.md)：内核、Host、适配器、工具判定、Agent Loop 与会话恢复。
- [术语表](docs/development/glossary.md)：统一内核、能力、工具、模式、审批方式、工作区和记录格式的用语。
- [贡献与验证](docs/development/contributing.md)：开发命令、验证范围和指南入口。
- [桌面开发说明](desktop/README.md)：前端、Tauri 壳与随包运行时的构建方式。

## 使用手册

[简体中文](docs/guide.zh-CN.md) · [English](docs/guide.en.md)
