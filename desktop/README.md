# ligule 桌面壳

窗口、后端进程与调用帧的搬运，Rust 侧没有业务逻辑（约束见 [../AGENTS.md](../AGENTS.md)）。

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

往界面加东西走注册表，不改渲染主干：一枚状态标记注册进 `header.status`，一个面板注册进 `rail.menu`。左侧「功能」菜单里有四项标着「待实现」，点开说的是缺的那件事在哪（U22、U8 与 U51，以及协议里还没有读写配置的方法）。

`src/main.tsx` 先看 `window.__LIGULE_TRANSPORT__`：页面外部挂上它，帧就从那里来，不挂就走壳的 Tauri 载体。这一处是给检查用的口子。

## 检查

```sh
cd desktop/src-tauri
cargo test
```

测的是这一层真正负责的两件事：从可执行文件位置找到后端入口（找不到要说清找过哪几层），以及帧在子进程两根管道之间的按行转递。

前端构建检查运行 `cd desktop/frontend && npm run build`，包含 TypeScript 检查与 Vite 构建。窗口交互通过 `cd desktop && npm run dev` 启动真实桌面壳，检查后端进程、转录、审批与菜单；关闭壳后检查后端与正在执行的命令退出。

不启动壳也有两条可跑的：`cd desktop/frontend && npm run check` 跑投影、协议与按键三份断言；`npm run dev` 起开发服务后打开 `dev/dev.html`，那一份界面跑的是仓库里的假宿主（`desktop/frontend/dev/`），流式、审批、稳定码、用量、会话列表与支线都有确定形状，地址后面接 `?rows=2000&bench=1` 量一轮长转录的读数。

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
