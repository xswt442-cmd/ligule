# ligule

[![npm](https://img.shields.io/npm/v/ligule?label=npm&color=4d6bfe)](https://www.npmjs.com/package/ligule)
[![node](https://img.shields.io/static/v1?label=node&message=%3E%3D24&color=339933&logo=node.js&logoColor=white)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-22c55e.svg)](./LICENSE)

**开发中。** 0.0.x 是占位版本，还没有发布到 npm。`ligule` 读 /ˈlɪɡjuːl/。

自建 agent harness：内核不提供任何工具，一切能力都是插件。命令行、终端界面与桌面壳是同一份内核的三个客户端，会话记录是唯一事实源。

给实际使用者的手册有两份，按同一批能力核对：[简体中文](docs/guide.zh-CN.md) 与 [English](docs/guide.en.md)。本文件是仓库首页的最小说明。

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

终端界面里的命令是 `/help`、`/mode [名字]`、`/policy [ask|auto|reset]`、`/status`、`/tools`、`/show [序号]`、`/sub [序号]`、`/compact`、`/copy`、`/export <路径>`、`/sessions`、`/find <文字>`、`/resume <id> [名字]`、`/queue [动作]`、`/bind [<动作> <键的写法>|reset <动作>|default]`、`/branch [序号]`、`/name <文字>`、`/archive`、`/unarchive`、`/new`、`/quit`。

- 打 `/` 列出候选：Tab 补全、上下键选、Esc 收起。提示模板也在这条输入框里用。展开在宿主那一侧做。画出来的是你原本敲的那一行。
- 打 `@` 引用这个项目里的文件：候选由宿主列出来，界面自己不开盘，清单第一行说这批出自哪一个项目。Enter 或 Tab 把选中那一条换成 `@路径` 放进草稿而不发送；那一次问还没答回来时这两记键什么都不做，一条候选都没有时 Enter 照旧发这一句；Esc 收起当下这一个词。这一段文字只是草稿里的字：不发起一次工具调用，也不写进记录。宿主翻到 4000 个文件的上限时那一栏说「更深的没翻到」，不说「没有」。
- 跑着的那一轮里回车不会丢掉那一句：它排进队列，本轮结束后按先后发出。草稿空着时按退格收回最后一条。
- 你按下 Esc 打断这一轮时，排着的几条一起停下：`/queue` 说出现在走不走，`/queue continue` 才接着发，`/queue drop <序号>` 与 `/queue clear` 把那些句子收回草稿而不是丢掉。
- 没发出去的那一句与排着的几条存在 `~/.ligule/tui-input.jsonl`，按项目与每份会话分开留住，下次打开同一份会话时回到原处；排着的几条回来时是暂停的。这份文件不是事实源：读不懂的那一行跳过，会话照开。
- 上下键翻跨会话留住的那一份输入历史。Ctrl+R 在里面反查。Ctrl+G 把草稿交给 `VISUAL`（若已设置）或 `EDITOR` 指定的编辑器再读回来。Ctrl+O 可打开完整历史浏览：PageUp/PageDown 翻页，Home/End 跳到两端，Shift+↑/↓ 选择行，Ctrl+Y 复制选择，Esc 关闭；审批中的 Ctrl+O 查看或收起实际改动，Esc 取消当前运行。
- 审批那一段展开说的是实际动作与两段内容：`edit` 给出「要去掉的那一段」与「要换上的那一段」（段首是减号与加号），`write` 与 `create` 只给要写进去的那些行，`delete` 只说把哪一个文件移进回收站。没读过的正文不画；参数里没有路径就不编一个对象；其余的调用交出参数本身。桌面那一侧同一条规则，抬头那格还写出这是哪一个项目里的动作。
- 模型提问（`ask_user_question`）跟审批各走一条请求与答复：终端界面在输入里逐道回答，写编号就选中那一条，其余文本按自由回答记下；桌面壳的提问卡选中或写自由回答，再一次交出整份。它不进档位判定，也没有回答时限，只有交出答案或打断这一轮才收尾。纯命令行那一页没人替它答，所以那一路不装载这一件。
- 整段粘贴作为一个整体进草稿：里面的换行不发起一轮，那一段里若有 `y` 也不替人答复审批。要发还是由人按那一次 Enter。
- Ctrl+Z 退回草稿的上一次改动，Ctrl+Y 再把那一段拿回来。连着打的字算一段，退一次去掉一段；打下的那个空格、插到中间的字、一次粘贴、退格与删词各算一段。换会话、读回留住的那一句与发出去之后那三次是整份换掉草稿，那三处把两份栈一起清掉——Ctrl+Z 不会把另一份会话的草稿翻回来。桌面那一侧用输入框自带的撤销与重做。
- `/help` 里那一组按键与界面上每一处说出的键名读的是同一份表（`src/tui/keymap.ts`：动作、默认那串键、落在哪一个范围、一句怎么说）。说得出「Ctrl+Enter 发送」，那一条分支就一定接得住这一记按键。
- `/bind` 列出现在这一份键位；`/bind <动作> <键的写法>` 改一记，`/bind reset <动作>` 退那一条，`/bind default` 整份退回。同一范围里两记键要落同一件事会当场拒掉。改的那一份存在 `~/.ligule/tui-keys.json`，下次打开还是它；桌面那一侧在设置的「键位」那一栏里改。
- `/copy` 把最近那一条回答放进剪贴板。`/export <路径>` 把人打的这一条路径定成目的地交给宿主：读完整记录、补溢出正文、排版与落盘四件都在宿主那一侧，每条派生支线在同一目录里另写一份。
- 状态行上有 `mode:`、`policy:`、`tools:`。写了 `limits.contextTokens` 时多一段 `ctx:~估算/窗口`。终端标题画出模型、项目根与这份会话的编号。
- 跑过的会话列在 `ligule sessions` 和终端的 `/sessions`，后者可用键盘选。接上某一份用 `ligule resume <会话 id> "接着做"` 或终端的 `/resume <会话 id>`。那一次判定怎么走的用 `ligule policy <会话 id>` 读出来。
- `/find <文字>` 在这个项目根跑过的会话里找一段文字，分两组说出：这一份会话（连溢出在文件里的那一段整段正文一起读）与其他会话。一行给出是哪一份会话的第几条：那串编号开头交给 `/resume`，序号交给 `/show`。
- `/name <文字>` 给这一份会话起一个名字，`/archive` 与 `/unarchive` 决定它在列表里排在哪。这两样写成记录里的一条事实，两种界面读的是同一份，模型看不见。
- `/branch` 把这一份记录复制成一份新会话并接上去，原来那一份一个字不动。不带序号复制到此刻记录落到哪儿为止；带一个序号就复制到那一轮正常完整结束那一条，那一条用 `/show <序号>` 读得到。上一份里没配上的那次派发不会自己重跑：第一次打开新的那一份时它补成「结果未知」。分支不另开一份工作区，同一项目里的分支写的还是同一批文件。
- 完整历史浏览会从记录及溢出文件读取内容。
- 记录在边界下的 `.ligule/sessions/`。

## 约定

[Agent guide](AGENTS.md) 写分层、稳定码、配置各格的位置与检查怎么跑。桌面壳的说明在 [desktop/README.md](desktop/README.md)。
