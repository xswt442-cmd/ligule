# ligule

[![npm](https://img.shields.io/npm/v/ligule?label=npm&color=4d6bfe)](https://www.npmjs.com/package/ligule)
[![node](https://img.shields.io/static/v1?label=node&message=%3E%3D24&color=339933&logo=node.js&logoColor=white)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-22c55e.svg)](./LICENSE)

**开发中。** 0.0.x 是占位版本，还没有发布到 npm。`ligule` 读 /ˈlɪɡjuːl/。

自建 agent harness：内核不提供任何工具，一切能力都是插件。命令行、终端界面与桌面壳是同一份内核的三个客户端，会话记录是唯一事实源。

## 装

```sh
npm install
npm run build
npm link        # 让 ligule 这个命令可用；不想全局装就用 node dist/cli.js
```

需要 Node 24 以上。`npm run build-rg` 另外取一次固定版本的 ripgrep 给 `search` 用；没有它时 `search` 自己遍历目录，比较真实后端的那两条检查跳过。

## 配

最小的一份写在 `~/.ligule/config.toml`：

```toml
[model]
api = "chat-completions"      # 或 messages
baseURL = "https://你的端点/v1"
model = "模型名"
```

密钥只从环境变量读（默认 `LIGULE_API_KEY`，用 `model.apiKeyEnv` 改名字）。工具能读写的位置默认是命令所在目录，`boundary` 那一格可以改。配置还有四层：用户、项目、项目的本地覆盖、`--config 键.路径=值`，越靠后越优先。

## 用

```sh
ligule run "把 README 的第一段改短一点"   # 一轮问答，审批问在终端上
ligule tui                                # 终端界面，要 ink 与 react 两个可选依赖
ligule host                               # 一行一条帧的协议端点，桌面壳起的就是这一个进程
```

终端界面里的命令是 `/help`、`/mode [名字]`、`/status`、`/tools`、`/show [序号]`、`/sub [序号]`、`/compact`、`/sessions`、`/resume <id> [名字]`、`/new`、`/quit`。打 `/` 会列出候选，Tab 补全、上下键选、Esc 收起；提示模板也在这条输入框里用，展开在宿主那一侧做，画出来的是你原本敲的那一行。跑着的那一轮里回车不吞话：那一句排进队列，本轮结束后按先后发出，草稿空着时按退格收回最后一条。状态行上有 `mode:`、`policy:`、`tools:`，写了 `limits.contextTokens` 时多一段 `ctx:~估算/窗口`。跑过的会话列在 `ligule sessions` 和终端的 `/sessions`，接上某一份用 `ligule resume <会话 id> "接着做"` 或终端的 `/resume <会话 id>`，那一次判定怎么走的用 `ligule policy <会话 id>` 读出来。记录在边界下的 `.ligule/sessions/`。

## 约定

[Agent guide](AGENTS.md) 写分层、稳定码、配置各格的位置与检查怎么跑。桌面壳的说明在 [desktop/README.md](desktop/README.md)。
