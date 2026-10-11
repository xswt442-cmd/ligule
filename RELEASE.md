# 发行清单

本文列出桌面安装包和 npm 包的目标、产物、系统要求及安装验证状态。版本为 `0.0.2`；本清单不表示该版本已公开发行。

## 桌面安装包

| 目标 | Rust target | 随包 Node 归档 | SHA-256 | 安装包 | 系统要求 | 构建机 | 安装验证 |
|---|---|---|---|---|---|---|---|
| Windows x64 | `x86_64-pc-windows-msvc` | `node-v24.21.0-win-x64.zip` | `158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541` | NSIS `.exe` | Windows 10；需要 WebView2 运行时 | GitHub Actions `windows-latest` | 已实测安装、真实模型请求、退出和卸载；发行附件按最终构建复验 |
| Linux x64 | `x86_64-unknown-linux-gnu` | `node-v24.21.0-linux-x64.tar.xz` | `fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6` | `.AppImage` 与 `.deb` | 声明支持 Ubuntu 22.04 与 Debian 12 | GitHub Actions `ubuntu-22.04` | 待在两种系统安装并启动验证 |
| macOS Apple Silicon | `aarch64-apple-darwin` | `node-v24.21.0-darwin-arm64.tar.gz` | `bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057` | `.dmg` | macOS 13.5 或更新版本 | GitHub Actions `macos-15` | 待在 Apple Silicon 实机安装并启动验证 |
| macOS Intel | `x86_64-apple-darwin` | `node-v24.21.0-darwin-x64.tar.gz` | `1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097` | `.dmg` | macOS 13.5 或更新版本 | GitHub Actions `macos-15-intel` | 待在 Intel 实机安装并启动验证 |

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

`publish.yml` 为主包和四个平台包各打一次 tarball，并将 SHA-256 一并保存为构建产物。流水线先校验并发布四个搜索包，再从 registry 安装搜索包来验证同一份主包 tarball，随后发布该主包 tarball，最后创建 GitHub draft Release。已存在的同名版本会按 tarball 内容与 registry 版本比较；内容不一致时发布失败。

GitHub Actions 使用 npm Trusted Publishing；初次建立包与发布者信任关系时可通过 `NPM_TOKEN` 完成发布。桌面安装包由 `ci.yml` 构建并作为检查附件提供，Release 会保持草稿。使用者完成四个平台的实机验证、确认附件后，再公开 Release。npm 版本与桌面安装包的实际发行状态以 registry 和 GitHub 上的发布结果为准。
