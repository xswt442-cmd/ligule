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

终端界面里的命令是 `/help`、`/mode [名字]`、`/status`、`/tools`、`/show [序号]`、`/sub [序号]`、`/compact`、`/copy`、`/export <路径>`、`/sessions`、`/find <文字>`、`/resume <id> [名字]`、`/name <文字>`、`/archive`、`/unarchive`、`/new`、`/quit`。

- 打 `/` 列出候选：Tab 补全、上下键选、Esc 收起。提示模板也在这条输入框里用。展开在宿主那一侧做。画出来的是你原本敲的那一行。
- 跑着的那一轮里回车不会丢掉那一句：它排进队列，本轮结束后按先后发出。草稿空着时按退格收回最后一条。
- 上下键翻跨会话留住的那一份输入历史。Ctrl+R 在里面反查。Ctrl+G 把草稿交给 `VISUAL`（若已设置）或 `EDITOR` 指定的编辑器再读回来。Ctrl+O 可打开完整历史浏览：PageUp/PageDown 翻页，Home/End 跳到两端，Shift+↑/↓ 选择行，Ctrl+Y 复制选择，Esc 关闭；审批中的 Ctrl+O 查看或收起实际改动，Esc 取消当前运行。
- `/copy` 把最近那一条回答放进剪贴板。`/export <路径>` 把这一份记录写成 markdown。每条派生支线另写一份。
- 状态行上有 `mode:`、`policy:`、`tools:`。写了 `limits.contextTokens` 时多一段 `ctx:~估算/窗口`。终端标题画出模型、项目根与这份会话的编号。
- 跑过的会话列在 `ligule sessions` 和终端的 `/sessions`，后者可用键盘选。接上某一份用 `ligule resume <会话 id> "接着做"` 或终端的 `/resume <会话 id>`。那一次判定怎么走的用 `ligule policy <会话 id>` 读出来。
- `/find <文字>` 在这个项目根跑过的会话里找一段文字，分两组说出：这一份会话（连溢出在文件里的那一段整段正文一起读）与其他会话。一行给出是哪一份会话的第几条：那串编号开头交给 `/resume`，序号交给 `/show`。
- `/name <文字>` 给这一份会话起一个名字，`/archive` 与 `/unarchive` 决定它在列表里排在哪。这两样写成记录里的一条事实，两种界面读的是同一份，模型看不见。
- 完整历史浏览会从记录及溢出文件读取内容。
- 记录在边界下的 `.ligule/sessions/`。

## 约定

[Agent guide](AGENTS.md) 写分层、稳定码、配置各格的位置与检查怎么跑。桌面壳的说明在 [desktop/README.md](desktop/README.md)。
