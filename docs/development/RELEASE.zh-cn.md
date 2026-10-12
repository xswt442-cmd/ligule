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

四个桌面目标分别由 `ci.yml` 的 Windows、Linux、Apple Silicon 和 Intel 构建机打包。每台构建机都会从生成的安装包安装或解包运行树，并用包内 Node 执行搜索后端自检；这能确认对应平台的可选二进制进入安装包且可运行。它不替代实机首次启动与平台特有功能验证；发行前仍需逐目标验证桌面托盘菜单和通知行为。

AppImage 在 `ubuntu-22.04` 上构建。各平台的安装包类型由 `desktop/src-tauri/tauri.<platform>.conf.json` 指定。macOS 安装包使用相同架构的 ad-hoc 签名，不进行公证。

## npm 包

| 包 | 内容 | 版本 |
|---|---|---|
| `ligule` | 内核、CLI、终端界面和中英文手册；依赖 `@vscode/ripgrep@1.18.0` 提供内容检索 | `0.0.3` |

`@vscode/ripgrep` 的 JavaScript wrapper 通过平台可选依赖选择 ripgrep；npm 在 Windows x64、Linux x64、macOS arm64 和 macOS x64 上只安装对应平台的二进制包。Ligule 只发布主包，不维护独立的 ripgrep 平台包。

`npm run pack-release -- <产物目录>` 使用 npm 的文件清单在独立暂存目录生成主包 tarball。普通模式运行 `npm run verify-install -- <tarball>`，会在空消费者中安装该 tarball，启动当前平台的 ripgrep 并执行真实搜索；搜索后端缺失或搜索失败时，验证会失败。

## 发布顺序

1. **准备版本 PR。** 在 GitHub Actions 手动运行 [`tag.yml`](../../.github/workflows/tag.yml)，选择 `prepare` 并输入稳定版本号（`X.Y.Z`）或 `patch`、`minor`、`major`。工作流从 `main` 更新所有版本清单，将双语 `[Unreleased]` 内容归入版本段，然后运行完整四平台 CI；这趟 CI 已包含单元测试、打包检查和四个平台安装包构建。全部通过后才创建指向 `main` 的版本 PR。检查版本差异，并从该 CI 运行下载四平台安装包进行实机验收。
2. **合并并验收。** 版本 PR 经审阅后合入 `main`。对合并后的提交再次完成 Windows x64、Linux x64、macOS Apple Silicon 与 macOS Intel 的安装和启动验证。仅 CI 产物成功不等于实机验收。
3. **创建标签。** 在 `main` 上手动运行 [`tag.yml`](../../.github/workflows/tag.yml)，选择 `tag`、输入已合并版本号，并确认四个平台验收选项。工作流检查该 SHA 的完整 `main` push CI 已通过，并在推标签前再次确认远端 `main` HEAD 仍是同一 SHA；任一检查不符都会停止。通过后自动创建并推送注释标签，无需在本机执行 `git tag`。
4. **发布 npm。** 手动运行 [`publish.yml`](../../.github/workflows/publish.yml)，输入刚创建的 `vX.Y.Z`。工作流只检出并验证这个标签对应的主分支提交，测试后进入 `npm-publish` Environment；可在该 Environment 配置人工审核者，审核通过后使用 Trusted Publishing 发布 `ligule` 主包。发布通过后会调用 [`release.yml`](../../.github/workflows/release.yml)。
5. **补齐草稿附件。** `release.yml` 从该版本的双语 Changelog 生成 Release 正文，并在主 npm 包可读取且草稿不存在时创建 draft Release。已有草稿的标题、正文和附件都保持不动；已公开的 Release 不允许被这条工作流改写。四个桌面安装包仍需从对应 `main` CI 运行下载，人工核对平台、文件名并上传到草稿。用 `Get-FileHash -Algorithm SHA256` 或 `sha256sum` 计算校验值并补入 Release 正文。缺少草稿时可手动运行 `release.yml` 创建。
6. **公开 Release。** 完成四个平台的实机验证、确认草稿附件与校验值后，再在 GitHub 上公开 Release。

`CHANGELOG.md` 是更新记录的单一来源。版本 PR 把 `[Unreleased]` 内容提升为带日期的版本段；新建 draft 时，`release.yml` 直接摘取该版本的中英文内容并添加下载说明，不自动生成另一份变更摘要。已有草稿不会被覆盖，因此手工加入的校验值和附件说明会保留。标签不会触发 npm 发布，`publish.yml` 必须由维护者手动运行。发布状态以 npm registry 和 GitHub Release 页面为准。
