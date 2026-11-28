# 贡献与验证 / Contributing

## 简体中文

仓库包含 Node.js 运行时、TUI 和 Electron 桌面应用。开始修改前，请阅读根目录 [AGENTS.md](../AGENTS.md) 与目标目录的 `AGENTS.md`。[架构说明](../docs/development/ARCHITECTURE.zh-CN.md)介绍组件归属与数据流，[术语表](../docs/development/GLOSSARY.zh-CN.md)统一项目用语。

### 分支与 PR

Pull Request 提交到 `dev`。维护者审阅后，在发版前快进合并到 `main`。CI 在 Pull Request 以及 `main`、`dev` 的 push 时运行。打 Tag 与发布由维护者按照[维护者发行说明](../docs/development/RELEASE.md)执行。

使用 [`.github/PULL_REQUEST_TEMPLATE.md`](PULL_REQUEST_TEMPLATE.md) 填写 PR 说明。正文分为简体中文与英文两节，说明改动内容、已完成工作和实际运行的检查。未完成或延后的工作放进 Issue。

### 提交信息

提交标题以 Conventional Commit 类型开头：`feat:`、`fix:`、`docs:`、`test:`、`refactor:`、`perf:`、`build:`、`ci:`、`chore:` 或 `release:`。可用括号补充范围（例如 `fix(tui):`），冒号后用一句话说明改动。一次提交只包含一种类型，不相关的改动拆成独立提交。

### 文档规范

- `README.md` 与 `README.en.md` 同步修改。
- `docs/guide.*`、`docs/agent-control/guide.*` 与 `docs/development/` 下的 `*.zh-CN.md` / `*.en.md` 成对文件同步修改，并在 [tests/docs.test.ts](../tests/docs.test.ts) 中声明配对与结构检查。
- `tui/CHANGELOG.md` 与 `desktop/CHANGELOG.md` 各自保持简体中文与英文节同步。
- 被跟踪文件不写入本机路径、凭据、私有主机信息或单次验证日志。依赖变更须同时更新包清单与 `pnpm-lock.yaml`，不得提交生成的 `desktop/vendor/`。

### 本地验证

使用 Node.js 24+ 与固定版本 pnpm 12.9.1，在仓库根目录运行：

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm check:syntax
pnpm check:dependencies
```

`pnpm test` 运行完整套件（构建、Core、TUI、跨模块集成测试、Benchmark 检查与 `.github/engineering/tests/`）。影响 CLI npm 产物时，另运行 `pnpm check-pack` 与 `pnpm verify-install`。桌面端检查、MCP 集成测试、文档检查和基准测试命令见[测试与验证说明](../docs/development/TESTING.zh-CN.md)。请如实说明未运行的检查，不把未执行的项目写成已通过。

### 安全上报

安全漏洞上报请遵循 [SECURITY.md](SECURITY.md)。

---

## English

The repository contains the Node.js runtime, TUI, and Electron desktop app. Read the root [AGENTS.md](../AGENTS.md) and the local `AGENTS.md` for the directory you are changing before editing. The [architecture guide](../docs/development/ARCHITECTURE.en.md) describes ownership and data flow, and the [glossary](../docs/development/GLOSSARY.en.md) defines shared terms.

### Branches and pull requests

Pull requests target `dev`. Maintainers review, then fast-forward `main` before a release. CI runs on pull requests and on pushes to `main` and `dev`. Tagging and publishing are maintainer actions that follow [`docs/development/RELEASE.md`](../docs/development/RELEASE.md).

Use [`.github/PULL_REQUEST_TEMPLATE.md`](PULL_REQUEST_TEMPLATE.md). A description states the change, the work completed, and the checks actually run, in a Simplified Chinese section and a matching English section. Deferred work belongs in an issue.

### Commit messages

Start the subject with a Conventional Commit type: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `perf:`, `build:`, `ci:`, `chore:`, or `release:`. Add a scope in parentheses when it clarifies the area (`fix(tui):`). Follow the colon with one sentence describing the change. One commit carries one type; split unrelated changes into separate commits.

### Documentation

- `README.md` and `README.en.md` change together.
- Paired `*.zh-CN.md` and `*.en.md` guides under `docs/` and `docs/development/` change together, with pair declarations and heading checks maintained in [`tests/docs.test.ts`](../tests/docs.test.ts).
- `tui/CHANGELOG.md` and `desktop/CHANGELOG.md` each keep their Simplified Chinese and English sections in step.
- Tracked files contain no personal paths, credentials, private host details, or one-off verification logs. Update `pnpm-lock.yaml` when a dependency changes, and never commit generated `desktop/vendor/` files.

## Verification

From the repository root, with Node.js 24 or newer and pnpm 12.9.1:

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm check:syntax
pnpm check:dependencies
```

`pnpm test` is the full suite: build, Core, TUI, cross-package integration, benchmark checks, and the engineering scripts under `.github/engineering/tests/`. For changes that affect the packaged CLI, also run `pnpm check-pack` and `pnpm verify-install`; the second installs the artifact into a clean consumer and performs a real search. Desktop checks, MCP integration tests, documentation linters, and benchmark commands are listed in [Testing and checks](../docs/development/TESTING.en.md). State which checks you did not run rather than implying they passed.

## Security reports

Security findings follow [SECURITY.md](SECURITY.md).
