# 发行清单

[简体中文](RELEASE.zh-cn.md) · [English](RELEASE.en.md)

Ligule 的 CLI 与 Desktop 使用独立版本和更新记录。根目录的 `package.json`、`src/version.ts`、`CHANGELOG.md` 描述 npm CLI 包；`desktop/package.json` 与 `desktop/CHANGELOG.md` 描述 Electron 桌面安装包。前端私有包版本只供内部使用，不代表产品发行版本。`pnpm-lock.yaml` 记录依赖解析结果，单纯调整版本时无需改写。

不要根据本地清单推断公开发行状态。重试或描述发行状态前，请检查 [GitHub Releases](https://github.com/xswt442-cmd/ligule/releases) 和 [npm 包页面](https://www.npmjs.com/package/ligule)。历史 `v0.0.3` 标签保持不变；后续发行使用产品专属标签。

## 桌面目标

| 目标 | 安装包 | 系统要求 | 自动化包检查 |
|---|---|---|---|
| Windows x64 | NSIS `.exe` | Windows 10 或更新版本；Electron 内嵌 Chromium，不需要 WebView2 | 安装并检查随包运行时；运行 Windows Host 进程树测试 |
| Linux x64 | `.AppImage` 与 `.deb` | 声明支持 Ubuntu 22.04 与 Debian 12 | 检查两种安装包并运行随包运行时检查 |
| macOS Apple Silicon | `.dmg` | macOS 13.5 或更新版本 | 验证 DMG 与随包运行时 |
| macOS Intel | `.dmg` | macOS 13.5 或更新版本 | 验证 DMG 与随包运行时 |

Electron 平台列表注明支持 Windows 10 及更新版本、macOS Ventura 及更新版本，见 [Electron 平台支持说明](https://github.com/electron/electron/blob/main/README.md#platform-support)。Windows 安装包内含 Electron 自带的 Chromium 渲染器，不依赖 Microsoft Edge WebView2 运行时。macOS 安装包使用 ad-hoc 签名，不进行公证。自动检查不能代替目标系统上的首次启动、托盘、通知和系统特定行为验收。

四个平台均随包提供 Node.js v24.21.0。归档 SHA-256 固定在 `desktop/node-pin.json`；更换运行时版本时要同步更新该来源和随包运行时测试。Linux 目标要求 glibc 2.28 或更新版本，见 [Node.js v24.21.0 平台要求](https://github.com/nodejs/node/blob/v24.21.0/BUILDING.md#platform-list)。

| 目标 | Node 归档 | SHA-256 |
|---|---|---|
| Windows x64 | `node-v24.21.0-win-x64.zip` | `158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541` |
| Linux x64 | `node-v24.21.0-linux-x64.tar.xz` | `fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6` |
| macOS Apple Silicon | `node-v24.21.0-darwin-arm64.tar.gz` | `bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057` |
| macOS Intel | `node-v24.21.0-darwin-x64.tar.gz` | `1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097` |

## CLI 包

npm 包 `ligule` 包含内核、CLI、TUI、手册和运行时依赖。全局安装与干净消费者验证等消费者操作使用 npm。发行自动化使用锁定的 pnpm 工作区（`pnpm@12.9.1`）运行仓库脚本和测试；仓库依赖不使用 npm 安装。

`pnpm --filter ligule run pack-release -- <产物目录>` 生成 npm tarball。`pnpm --filter ligule run verify-install -- <tarball>` 会将该 tarball 原样交给 npm 安装到隔离消费者，并检查 CLI 与包导出。

## 独立发行流程

1. **准备产品版本。** 在 `main` 上手动运行 [`tag.yml`](../../.github/workflows/tag.yml)，选择 `prepare`，再选择 `cli` 或 `desktop`，输入 `patch`、`minor`、`major` 或 `X.Y.Z`。工作流只更新所选产品的版本和更新记录，推送审查分支，并对该精确提交运行完整 CI 后创建 PR。审查并合并 PR。
2. **创建产品标签。** 在 `main` 上再次运行 `tag.yml`，选择 `tag`，并使用相同产品和已合并版本。工作流拒绝已有标签，要求 `main` 指向所选提交，并确认该 SHA 的完整 `main` push CI 成功，然后创建注释标签 `cli-vX.Y.Z` 或 `desktop-vX.Y.Z`。
3. **发布 CLI 到 npm。** 手动运行 [`publish.yml`](../../.github/workflows/publish.yml)，输入 `cli-vX.Y.Z`。工作流验证主分支祖先关系和该精确标签 SHA 的 CI 成功状态，对该提交运行测试、打包、npm registry 精确 tarball 检查，并在空 npm 消费者中安装 tarball。工作流还会通过 GitHub API 检查现有 `npm-publish` Environment 至少配置一名必需审核者；未配置时会 fail closed。检查通过后，发布仍需经过该 Environment，并使用 npm Trusted Publishing/OIDC。Desktop 标签不能触发或满足此流程。
4. **生成 Desktop 草稿。** 在 `main` 上手动运行 [`release.yml`](../../.github/workflows/release.yml)，输入 `desktop-vX.Y.Z`。工作流重新确认标签属于 `main` 且该 SHA 的 main CI 成功，再从完全相同的提交构建 Windows x64、Linux x64、macOS arm64 与 macOS x64 安装包。每个安装包文件名和清单都绑定产品版本、目标架构、源码提交、工作流运行和 SHA-256。工作流创建或补齐 GitHub 草稿 Release。已有草稿的标题与说明会保留；内容哈希相同的附件会跳过，字节冲突会失败，已公开 Release 不会被修改。
5. **审阅并公开 Desktop 草稿。** 核对安装包校验值，并在目标系统检查首次启动、托盘、通知和系统特定行为。所有检查通过后，在 GitHub 手动公开草稿；工作流本身不会公开 Release。

CLI 与 Desktop 更新记录各自独立。准备某一产品版本时，不会修改另一产品的清单、更新记录、运行时版本或前端私有版本。单纯调整版本不需要更新依赖锁文件。
