# 发行清单

[简体中文](RELEASE.zh-cn.md) · [English](RELEASE.en.md)

本文列出桌面安装包和 npm 包的目标、产物、系统要求及安装验证状态。

> **发行状态：尚未公开。** 仓库版本为 `0.0.2`。Windows x64 已实测安装与运行；Linux 和两个 macOS 目标仍待实机验收。

## 桌面安装包

| 目标 | 安装包 | 系统要求 | 安装验证 |
|---|---|---|---|
| Windows x64 | NSIS `.exe` | Windows 10；需要 WebView2 运行时 | 已实测安装、真实模型请求、退出和卸载；发行附件按最终构建复验 |
| Linux x64 | `.AppImage` 与 `.deb` | 声明支持 Ubuntu 22.04 与 Debian 12 | 待在两种系统安装并启动验证 |
| macOS Apple Silicon | `.dmg` | macOS 13.5 或更新版本 | 待在 Apple Silicon 实机安装并启动验证 |
| macOS Intel | `.dmg` | macOS 13.5 或更新版本 | 待在 Intel 实机安装并启动验证 |

### 随包 Node.js 运行时

| 目标 | Rust target | Node 归档 | SHA-256 |
|---|---|---|---|
| Windows x64 | `x86_64-pc-windows-msvc` | `node-v24.21.0-win-x64.zip` | `158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541` |
| Linux x64 | `x86_64-unknown-linux-gnu` | `node-v24.21.0-linux-x64.tar.xz` | `fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6` |
| macOS Apple Silicon | `aarch64-apple-darwin` | `node-v24.21.0-darwin-arm64.tar.gz` | `bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057` |
| macOS Intel | `x86_64-apple-darwin` | `node-v24.21.0-darwin-x64.tar.gz` | `1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097` |

构建机分别为 GitHub Actions `windows-latest`、`ubuntu-22.04`、`macos-15` 和 `macos-15-intel`。

Node.js v24.21.0 的平台表列出 Linux x64 的最低基线为 Linux 4.18 与 glibc 2.28，并列出 macOS 13.5 下的 arm64 和 x64 两种目标。发行目标仍声明 Linux 为 Ubuntu 22.04 与 Debian 12；构建机版本只说明产物构建环境，不能替代这两种系统上的安装与启动验证。[Node.js v24.21.0 平台要求](https://github.com/nodejs/node/blob/v24.21.0/BUILDING.md#platform-list)

四个桌面目标分别由 `ci.yml` 的 Windows、Linux、Apple Silicon 和 Intel 构建机打包。自动构建与测试不会替代实机安装、首次启动和平台特有路径验证。安装包生成后仍需逐目标验证，并确认桌面托盘菜单和通知行为。

AppImage 在 `ubuntu-22.04` 上构建。各平台的安装包类型由 `desktop/src-tauri/tauri.<platform>.conf.json` 指定。macOS 安装包使用相同架构的 ad-hoc 签名，不进行公证。

## npm 包

| 包 | 内容 | 版本 |
|---|---|---|
| `ligule` | 内核、CLI、终端界面和中英文手册 | `0.0.2` |
| `ligule-rg-win32-x64` | `rg.exe` 与三份许可证 | `0.0.2` |
| `ligule-rg-linux-x64` | `rg` 与三份许可证 | `0.0.2` |
| `ligule-rg-darwin-arm64` | `rg` 与三份许可证 | `0.0.2` |
| `ligule-rg-darwin-x64` | `rg` 与三份许可证 | `0.0.2` |

`npm run pack-release -- <产物目录>` 使用 npm 的文件清单在独立暂存目录生成发行包，并在产物的 `optionalDependencies` 中加入四个精确版本的搜索包。开发清单不依赖尚未发布的平台版本，可以正常执行 `npm ci`。发布必须使用该入口生成的 tarball。

普通模式运行 `npm run verify-install -- <主包 tarball>`，会在空消费者中从 registry 安装并实测该平台的搜索包；`npm run verify-install -- --local-search` 会先将已构建的本地平台包打成 tarball 并安装，再验证主包 tarball。缺少搜索后端或实际搜索失败时，验证会失败。

## 搜索包归档

| `scripts/ripgrep-pin.json` 目标 | 归档 | 字节数 | SHA-256 |
|---|---|---:|---|
| `win32-x64` | `ripgrep-15.2.0-x86_64-pc-windows-msvc.zip` | 1789611 | `71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5` |
| `linux-x64` | `ripgrep-15.2.0-x86_64-unknown-linux-musl.tar.gz` | 2265718 | `33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c` |
| `darwin-arm64` | `ripgrep-15.2.0-aarch64-apple-darwin.tar.gz` | 1764284 | `3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4` |
| `darwin-x64` | `ripgrep-15.2.0-x86_64-apple-darwin.tar.gz` | 1878284 | `af7825fcc69a2afc7a7aea55fc9af90e26421d8f20fe59df32e233c0b8a231c1` |

每份归档包含 `LICENSE-MIT`、`UNLICENSE` 和 `COPYING`。`npm run build-rg` 按固定版本和 SHA-256 校验归档，并将二进制和许可证放入对应平台包。

## 发布顺序

1. **准备版本 PR。** 在 GitHub Actions 手动运行 [`tag.yml`](../../.github/workflows/tag.yml)，选择 `prepare` 并输入稳定版本号（`X.Y.Z`）或 `patch`、`minor`、`major`。工作流从 `main` 更新所有版本清单，将双语 `[Unreleased]` 内容归入版本段，运行 `npm test`、`npm run check-pack` 和完整四平台 CI；全部通过后才创建指向 `main` 的版本 PR。检查该 PR 的版本差异，并从其 CI 运行下载四平台安装包进行实机验收。
2. **合并并验收。** 版本 PR 经审阅后合入 `main`。对合并后的提交再次完成 Windows x64、Linux x64、macOS Apple Silicon 与 macOS Intel 的安装和启动验证。仅 CI 产物成功不等于实机验收。
3. **创建标签。** 在 `main` 上手动运行 [`tag.yml`](../../.github/workflows/tag.yml)，选择 `tag`、输入已合并版本号，并确认四个平台验收选项。工作流确认标签不存在、版本和 Changelog 匹配、提交属于 `main`，再对该提交重跑完整 CI；通过后自动创建并推送注释标签。无需在本机执行 `git tag`。
4. **发布 npm。** 手动运行 [`publish.yml`](../../.github/workflows/publish.yml)，输入刚创建的 `vX.Y.Z`。工作流只检出并验证这个标签对应的主分支提交，测试后进入 `npm-publish` Environment；可在该 Environment 配置人工审核者，审核通过后才开始发布四个搜索包和主包。未配置保护规则时不会增加等待步骤。初次发布需要将 `NPM_TOKEN` 配为仓库 Secret；npm 发布通过后会调用 [`release.yml`](../../.github/workflows/release.yml)。
5. **补齐草稿附件。** `release.yml` 从该版本的双语 Changelog 生成 Release 正文，并在所有对应 npm 包可读取时创建或更新 draft Release；已公开的 Release 不允许被这条工作流改写。四个桌面安装包仍需从对应 `main` CI 运行下载，人工核对平台、文件名并上传到草稿。用 `Get-FileHash -Algorithm SHA256` 或 `sha256sum` 计算校验值并补入 Release 正文。也可在 npm 包已发布后手动运行 `release.yml` 修复或重建草稿。
6. **公开 Release。** 完成四个平台的实机验证、确认草稿附件与校验值后，再在 GitHub 上公开 Release。

`CHANGELOG.md` 是更新记录的单一来源。版本 PR 把 `[Unreleased]` 内容提升为带日期的版本段；`release.yml` 直接摘取该版本的中英文内容并添加下载说明，不自动生成另一份变更摘要。GitHub Release 的平台附件与校验值在上传后维护。标签不会触发 npm 发布，`publish.yml` 必须由维护者手动运行。完成 npm Trusted Publishing 配置后，可删除仓库 Secret `NPM_TOKEN`。发布状态以 npm registry 和 GitHub Release 页面为准。
