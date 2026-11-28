# 测试与验证说明

[简体中文](TESTING.zh-CN.md) · [English](TESTING.en.md)

本页补充 [贡献指南](../../.github/CONTRIBUTING.md) 中的核心命令，列出各模块测试、文档检查、桌面构建与基准测试入口。

## 核心与跨模块测试

- Core 包测试位于 `core/tests/`，TUI 测试位于 `tui/tests/`，跨模块集成测试位于根目录 `tests/`。
- 测试使用 TypeScript（`*.test.ts`），由 Node.js 24 类型剥离直接运行。`pnpm build` 类型检查 Core、TUI、集成与 Benchmark 项目。
- MCP 外控集成测试通过真实 SDK stdio 客户端、本地 HTTP 模型端点、持久 Session 记录、Policy 与子进程验证外控。单独运行命令如下：

```sh
node --experimental-strip-types --test --import ./tests/hooks/isolated-data-root.ts tests/mcp-server.test.ts
```

`tests/helpers/mcp-control.mjs` 独立客户端接受明确的已安装 CLI 与 SDK 路径，可在检出目录外检查相同控制调用。语义细节见 [Agent Control（MCP）指南](../agent-control/guide.zh-CN.md)。确定性模型端点测试不代表真实外部模型服务验收。

## 文档与规范检查

文档修改使用 `.agents/skills/` 中的 Skill。`mydocs` 检查读者任务、内容归属与全文一致性，`myshuohua` 检查正式技术中文。提交前运行以下检查，修复全部 `error` 并处理 `warning`：

```sh
node .agents/skills/mydocs/scripts/lint-docs.mjs README.md README.en.md docs
node .agents/skills/myshuohua/scripts/lint-shuohua.mjs README.md README.en.md docs tui/CHANGELOG.md desktop/CHANGELOG.md core/README.md tui/README.md desktop/README.md
node .github/engineering/scripts/sync-community.mjs --check .
node --experimental-strip-types --test --test-reporter=./scripts/test-summary-reporter.mjs tests/docs.test.ts
```

## 桌面开发与检查

准备本机运行树、Electron 二进制和前端检查：

```sh
pnpm run build:core
pnpm run prepare-runtime
pnpm --filter ligule-desktop exec install-electron
pnpm exec tsc -p desktop/electron/tsconfig.json
node --experimental-strip-types --test desktop/electron/tests/host.test.ts desktop/electron/tests/security.test.ts
pnpm --filter ligule-desktop-frontend run check
pnpm --filter ligule-desktop-frontend run build
pnpm --filter ligule-desktop run dev
```

桌面前端检查脚本位于 `desktop/frontend/tests/checks/`，开发辅助文件位于 `desktop/frontend/dev/`。跨平台安装包、真实窗口和平台原生验收使用对应平台的 Electron 运行时。运行验收前确认构建目标、运行时架构与当前操作系统一致，并只按实际执行结果记录平台覆盖情况。

## 基准测试

- `pnpm run bench:perf` 运行确定性的 Harness 场景，原始样本与 JSON/Markdown 摘要写入 `testplace/benchmarks/`。报告记录 Git SHA 与平台。
- `pnpm run bench:agent` 通过 Harbor 适配器运行冻结的 `terminal-bench@2.0` 计划。运行需要 Docker、CLI tarball、提供方设置、冻结数据集，以及为无 Node 镜像准备的 Node 24 Linux 运行时。
- 缺少前置条件时基准测试报告 `BLOCKED`，不会当作得分。详见 [evals/perf/README.md](../../evals/perf/README.md) 与 [evals/agent/README.md](../../evals/agent/README.md)。

## CI 覆盖范围

默认 CI 运行核心测试、`pnpm check:dependencies`、CLI 干净消费者安装，并在 Windows x64、Linux x64 检查 Desktop 运行树与窗口。手动触发的 CI 可额外检查 macOS arm64 与 x64 的原生凭据和 Desktop 兼容性，macOS 检查允许失败。常规 CI 不构建安装包。经审核的发行 Tag 通过 [Desktop 发行工作流](../../.github/workflows/desktop-publish.yml) 手动启动后构建 Windows 与 Linux 安装包。发行故障处理见[维护者发行说明](RELEASE.md)。
