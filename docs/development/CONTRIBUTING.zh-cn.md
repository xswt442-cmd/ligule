# 贡献与验证

[简体中文](CONTRIBUTING.zh-cn.md) · [English](CONTRIBUTING.en.md)

仓库包含 Node.js 运行时、TUI 和 Electron 桌面应用。开始修改前，请阅读仓库根目录的 [Agent 指南](../../AGENTS.md)及目标目录中的 `AGENTS.md`。[架构说明](ARCHITECTURE.zh-cn.md)介绍组件归属和数据流；[术语表](GLOSSARY.zh-cn.md)统一项目用语。

## 安装与验证

使用 Node.js 24 或更新版本；仓库固定使用 pnpm 12.9.1。从仓库根目录安装锁定的依赖并运行核心检查：

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm check:syntax
pnpm check-pack
pnpm verify-install
```

`pnpm test` 会构建 `dist/` 并运行自动化测试；`pnpm check-pack` 检查 CLI npm 包产物；`pnpm verify-install` 会将该产物安装到干净的消费者环境并运行真实搜索。消费者安装使用 npm，以验证 CLI 的 npm 安装路径。

`tests/mcp-server.test.js` 通过真实 SDK stdio 客户端、本地 HTTP 模型端点、持久 Session 记录、Policy 与子进程验证外控。可单独运行 `node --test --import ./test/hooks/isolated-data-root.mjs tests/mcp-server.test.js`。`test/helpers/mcp-control.mjs` 独立客户端接受明确的已安装 CLI 和 SDK 路径，可在检出目录之外检查相同控制调用。工具与权限语义见 [MCP 指南](../mcp/mcp-guide.zh-CN.md)。确定性模型端点测试不代表真实外部模型服务验收。

## 桌面开发

准备本机运行树、Electron 二进制和前端检查：

```sh
pnpm run build:core
pnpm run prepare-runtime
pnpm --filter ligule-desktop exec install-electron
pnpm exec tsc -p desktop/electron/tsconfig.json
node --experimental-strip-types --test desktop/electron/test/host.test.ts desktop/electron/test/security.test.ts
pnpm --filter ligule-desktop-frontend run check
pnpm --filter ligule-desktop-frontend run build
pnpm --filter ligule-desktop run dev
```

安装包构建、真实窗口和各平台原生验收步骤见[桌面开发说明](DESKTOP.zh-cn.md)。

## 让改动可核验

从实现和测试描述行为。保持中文与英文使用手册中的用户可见行为一致，并区分自动化覆盖、平台验证和人工验证。提交中不要加入凭据、个人会话记录或生成的 `desktop/vendor/` 文件。依赖变动要同时更新包清单和 `pnpm-lock.yaml`。

CI 分开报告核心测试、CLI 干净消费者安装、四种目标平台的原生凭据检查，以及 Windows x64、Linux x64、macOS arm64 和 macOS x64 的 Electron 安装包构建。CI 构建产物用于验证，不等于公开发行。维护者发行范围和流程见[发行说明](RELEASE.md)。

## 相关文档

[架构说明](ARCHITECTURE.zh-cn.md)介绍内核和适配器的依赖方向；[使用手册](../guide.zh-CN.md)介绍 CLI、TUI 和桌面端的用户操作。
