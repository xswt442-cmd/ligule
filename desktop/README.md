# ligule 桌面壳

窗口、后端进程与调用帧的搬运，Rust 侧没有业务逻辑（[../AGENTS.md](../AGENTS.md) 与 `ligule-set/decisions.md` 的 D24、D30）。

```
WebView (frontend/)  ←Tauri 事件与命令→  Rust 壳  ←stdin/stdout 一行一条→  node src/cli.js host  ←→  内核
```

## 跑起来

```sh
cd desktop/src-tauri
cargo run
```

需要 PATH 上有 `node`（Windows 上还需要 WebView2 运行时，Win11 自带）。后端进程由壳起，界面不需要知道任何地址与端口：帧走这两根管道。

配置与命令行读同一份：`~/.ligule/config.toml` 里的 `[model]` 段（`api`、`baseURL`、`model`），凭据读环境变量 `LIGULE_API_KEY`。壳的工作目录决定工具能读写哪儿（边界取进程当前目录）。

`LIGULE_DESKTOP_CLI` 可以指到别的 `cli.js`，`NODE` 可以指到别的 node 可执行文件——开发时用得上。

## 界面

`frontend/` 是静态文件，没有构建步骤，也没有框架：`index.html` 摆三栏，`styles.css` 是视觉系统，`app.js` 把记录画成行、把审批摆出来、把状态读成几枚标记，`protocol.js` 收发帧，`slots.js` 是与 `src/kernel/slots.js` 同一形状的槽位注册表。

往界面加东西走注册表，不改 `app.js`：一类记录注册进 `conversation.rows`，一枚状态标记注册进 `header.status`，一个面板注册进 `rail.menu`。左侧「功能」菜单里有四项标着「待实现」，点开说的是缺的那件事在哪（U22、U8、U21，以及协议里还没有读写配置的方法）。

## 检查

```sh
cd desktop/src-tauri
cargo test
```

测的是这一层真正负责的两件事：从可执行文件位置找到后端入口（找不到要说清找过哪几层），以及帧在子进程两根管道之间的按行转递。

窗口与界面另有两条：

```sh
powershell -NoProfile -ExecutionPolicy Bypass -File testplace/check-desktop-window.ps1
node testplace/serve-frontend.mjs
```

第一条起真壳，数它带起来的后端进程数、截一张窗口图，并在强杀壳之后确认没有孤儿进程留下来；抢不到前台焦点时它不打字，只截窗口。第二条把 `frontend/` 服务成本地页面，配合 `testplace/check-desktop-frontend.mjs`（帧由页面里的假 Host 生成）看行的次序、审批卡、四个展示档位与菜单面板——壳打不进字的时候，界面那一条就靠它。

## 图标

`tauri-build` 在 Windows 上生成资源时必须有 `src-tauri/icons/icon.ico`。图标是脚本画出来的，不手工存二进制：

```sh
powershell -NoProfile -ExecutionPolicy Bypass -File desktop/make-icons.ps1
node desktop/make-ico.mjs
```

源图是 `desktop/assets/app-icon.png`，改设计改那一张。第一条按它裁出 32/128/256/512 四张 PNG，另出一份 `frontend/icon.png` 给界面里的品牌标记与标签页图标；第二条把前三张装进一个 .ico 容器并读回来核对目录项与 PNG 签名。两份脚本都要带 UTF-8 BOM 保存，Windows PowerShell 5.1 按 ANSI 码页读没有 BOM 的文件，中文注释会把紧随其后的那一行代码吞掉。
