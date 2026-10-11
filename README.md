# ligule

[![npm](https://img.shields.io/npm/v/ligule?label=npm&color=4d6bfe)](https://www.npmjs.com/package/ligule)
[![node](https://img.shields.io/static/v1?label=node&message=%3E%3D24&color=339933&logo=node.js&logoColor=white)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-22c55e.svg)](./LICENSE)

ligule 提供命令行、终端界面和桌面界面。三种入口共用配置与会话记录。中文使用手册见[简体中文指南](docs/guide.zh-CN.md)，英文使用手册见[English guide](docs/guide.en.md)。

## 安装

命令行和终端界面需要 Node.js 24 或更新版本。安装 npm 当前公开版本：

```sh
npm install -g ligule
```

在项目目录中运行 `ligule run "查看项目并提出建议"` 开始对话，运行 `ligule tui` 打开终端界面。终端界面需要交互式终端。

桌面版提供 Windows x64、Linux x64、macOS Apple Silicon 和 macOS Intel 安装包。Windows 需要 WebView2 运行时。发行清单列出各平台要求和待完成的安装检查：[RELEASE.md](RELEASE.md)。

## 配置

命令行和终端界面可在 `~/.ligule/config.toml` 配置模型服务：

```toml
[model]
api = "chat-completions"
baseURL = "https://api.example.com/v1"
model = "model-name"
apiKeyEnv = "LIGULE_API_KEY"
```

将密钥放入 `apiKeyEnv` 指定的环境变量。桌面版也可以在设置中的「模型服务」填写服务，并使用系统凭据库保存密钥。`LIGULE_HOME` 可设为绝对路径以更换用户数据根。

命令行和终端界面以启动目录作为工作区；桌面版可在侧栏选择工作区。工具访问范围由 `boundary` 配置限制。会话记录和应用设置保存在用户数据根。

运行 `ligule --help` 查看命令。完整安装、配置与操作说明请参阅[简体中文指南](docs/guide.zh-CN.md)或[English guide](docs/guide.en.md)。
