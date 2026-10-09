# ligule 桌面壳

窗口、后端进程与调用帧的搬运，Rust 侧没有业务逻辑。这一格的局部约束见 [AGENTS.md](AGENTS.md)，仓库全局规则见 [../AGENTS.md](../AGENTS.md)。

```
WebView (frontend/)  ←Tauri 事件与命令→  Rust 壳  ←stdin/stdout 一行一条→  node dist/cli.js host  ←→  内核
```

## 跑起来

`desktop/package.json` 是壳的构建入口（Tauri 命令行认 `src-tauri` 是它的直接子目录），前端的构建由壳的配置去拉起。

```sh
cd desktop
npm install
npm run dev      # 前端起 Vite（5188），壳连它，改界面即时可见
npm run build    # 出 NSIS 安装包：target/release/bundle/nsis/ligule_<版本>_x64-setup.exe
```

只想看已经构建好的产物时：`cd frontend && npm run build`，再 `cd ../src-tauri && cargo run`。`tauri-build` 在编译时把 `frontend/dist` 嵌进可执行文件，改一行前端不重跑构建就看不见。

需要 PATH 上有 `node`（Windows 上还需要 WebView2 运行时，Win11 自带）。后端进程由壳起，界面不需要知道任何地址与端口：帧走这两根管道。

配置与命令行读同一份：`~/.ligule/config.toml` 里的 `[model]` 段（`api`、`baseURL`、`model`），凭据读环境变量 `LIGULE_API_KEY`。壳的工作目录决定工具能读写哪儿（边界取进程当前目录）。

`LIGULE_DESKTOP_CLI` 可以指到别的 `cli.js`，`NODE` 可以指到别的 node 可执行文件——开发时用得上。

安装包里随带一份 Node 运行时与 ligule 的运行时树，所以装到没有这份仓库、也没有 node 的机器上就能跑。怎么备出来、壳按什么顺序找后端入口，写在下面「随包带的运行时」那一节。

## 界面

`frontend/` 是一份 Vite 工程（React 加 TypeScript），构建出的 `dist/` 交给壳嵌入：`src/App.tsx` 是三栏与行的渲染，`src/protocol.ts` 收发帧，`src/rows.ts` 把会话记录投影成行，`src/slots.ts` 是与 `src/kernel/slots.js` 同一形状的槽位注册表，`src/bridge.ts` 是 Tauri 那一头的载体。

往界面加东西走注册表，不改渲染主干：一枚状态标记注册进 `header.status`，一个面板注册进 `rail.menu`。左侧「功能」菜单里有一项标着「待实现」，点开说的是缺的那件事在哪：多个窗口看同一份会话要等共享的常驻进程引入（U8）。「导出全文」那一栏开的是这台机器自己的保存对话框（`@tauri-apps/plugin-dialog`，壳只多这一条权限 `dialog:allow-save`）：界面把选定的那一条路径交给 `session.export`，读完整记录、补溢出正文、排版与落盘四件都在宿主那一侧，与终端那一条 `/export` 用的是同一份实现；对话框返回路径不等于文件已经写成，所以那一栏说的是宿主交回来的那几条路径，某一条支线读不回来时逐条说出是哪一个码。从浏览器打开这一页时那扇对话框开不出来，界面把失败那一句原样说出来，不代使用者挑一个位置。`ligule.ui` 现在这种「每一次改动重写整格」要跟着换掉：两扇窗口共用一份 WebView2 用户数据目录时读的是同一份存储，后落笔那一份会把前一扇的配色、字号与草稿、队列两张表整份盖掉（本机两扇真壳窗口量过）。「模型与端点」读的是 `config.get` 交回的那几格，四条模型字段可以在界面上改：选写进使用者默认还是本机覆盖那两层之一，先预览再保存，保存之后谁什么时候用上它、这一条又是由哪一层写着（只读的两层标得出来，命令行写着的那一条改文件盖不过它）由同一处说出来（第 92、93 步）。「审批规则」那一栏管同两层里的 `policy.mode` 与 `[[policy.rules]]`：列出现在生效的那一张表与它出自哪一层，加一条、改第几条、去掉第几条，写的还是那两层文件之一，落笔只换那一块的字节，注释与键的顺序留着（第 121 步）。顶栏那枚牌子上的档位改的是这一份会话，配置文件里那一条仍是默认，退回就退到它（第 122 步）。外观那一栏有六套具名配色，换的是颜色变量，刻度与内容列不重来（第 124 步）。后端进程退了，断连横幅上那一个「重连」让壳换一具进程再用 `session.open` 接回这一份会话。跑着的那一轮按会话记：一份窗口里可以同时开着几份会话各自的轮次（Host 那一边每份会话有自己的信号与判定链），发队首、取消、那句「这一轮结束」与状态各认自己那一份，另一份的轮次收尾不替这一份发话（方案 5.2 的队列按会话隔离）；顶栏那枚牌子说这一份自己跑了几秒，另一份还在跑时另加一枚「另一份在跑 N 份」，左侧栏给在跑的那一份挂「这一份在跑」、给刚跑完而人没看着的那一份挂「刚跑完一轮没看着」，切过去就消；这一扇窗口自己新建的那一份立刻出现在左侧栏，不用先按「刷新会话列表」。另一项目录可以写在左侧栏那一格并加进来（方案 3.2）：会话列表与正文查找按每一项目录各问一次，某一份读不回来时说得出是哪一份，那一份项目里的会话按它自己那一份目录接回来，新建时点那一段上的「在这一份项目里新建」；这一份清单存在本机偏好里，最多八条，满了退掉最早加进来的那一条。指名的目录与装载出来的根按位置比，同一目录换大小写或换分隔符不算身份不符。回答里每一段围栏代码下面有一枚「复制代码」：交出去的是那段没上色的原文，不是画面上带了标签的那一份，成与不成都在旁边说一句（剪贴板走 WebView2 自带的 `navigator.clipboard`，没加依赖）。

`src/main.tsx` 先看 `window.__LIGULE_TRANSPORT__`：页面外部挂上它，帧就从那里来，不挂就走壳的 Tauri 载体。这一处是给检查用的口子。

## 检查

```sh
cd desktop/src-tauri
cargo test
```

测的是这一层真正负责的三件事：从可执行文件位置找到后端入口（找不到要说清找过哪几层），帧在子进程两根管道之间的按行转递，以及槽位换新的那一具进程时把旧的那一份交回调用方终止——旧进程终止之后既写不进帧，也不再往窗口里送。

前端构建检查运行 `cd desktop/frontend && npm run build`，包含 TypeScript 检查与 Vite 构建。窗口交互通过 `cd desktop && npm run dev` 启动真实桌面壳，检查后端进程、转录、审批与菜单；关闭壳后检查后端与正在执行的命令退出。

不启动壳也有两条可跑的：`cd desktop/frontend && npm run check` 跑投影、协议与按键三份断言；`npm run dev` 起开发服务后打开 `dev/dev.html`，那一份界面跑的是仓库里的假宿主（`desktop/frontend/dev/`），流式、审批、稳定码、用量、会话列表、查找、分支、支线与 `@` 的文件候选都有确定形状，地址后面接 `?rows=2000&bench=1` 量一轮长转录的读数。

## 随包带的运行时

安装包自带一套 Node 与 ligule 的运行时树（D34），装到没有这份仓库的机器上也能跑。两样东西由一条脚本备出来：

```sh
node desktop/fetch-runtime.mjs
```

它按 `desktop/node-pin.json` 里钉住的版本与校验和下载 Node，只把 `node.exe` 抽到 `desktop/vendor/node/`；再把 `src/`、`package.json` 与生产依赖（按 `package.json` 的 `dependencies` 递归收，装不上的原生模块跳过——内核那一侧本来就有降级路径）拷到 `desktop/vendor/app/`。`desktop/vendor/` 不进版本控制。

`tauri.conf.json` 的 `bundle.resources` 把这两份分别挂成 `node/` 与 `app/`；壳起后端时按「`LIGULE_DESKTOP_CLI` → 随包的 `app/dist/cli.js` → 从可执行文件位置向上找 `dist/cli.js`」这一条顺序找，node 程序同理先用随包的那一份，再退 `NODE`，最后退 PATH。

## 图标

`tauri-build` 在 Windows 上生成资源时必须有 `src-tauri/icons/icon.ico`。图标是脚本画出来的，不手工存二进制：

```sh
powershell -NoProfile -ExecutionPolicy Bypass -File desktop/make-icons.ps1
node desktop/make-ico.mjs
```

源图是 `desktop/assets/app-icon.png`，改设计改那一张。第一条按它裁出 32/128/256/512 四张 PNG，另出一份 `frontend/public/icon.png` 给界面里的品牌标记与标签页图标（`public/` 下的东西由 Vite 原样拷进构建产物）；第二条把前三张装进一个 .ico 容器并读回来核对目录项与 PNG 签名。两份脚本都要带 UTF-8 BOM 保存，Windows PowerShell 5.1 按 ANSI 码页读没有 BOM 的文件，中文注释会把紧随其后的那一行代码吞掉。
