# 维护者发行说明

Ligule 分为两条独立发行线，版本可分别推进：

| 产品 | 版本来源 | 标签 | 发布渠道 | 正式资产 |
| --- | --- | --- | --- | --- |
| CLI / TUI | 根目录 `package.json`、`src/version.ts`、`CHANGELOG.md` | `cli-vX.Y.Z` | npm `ligule` | CLI npm 包 |
| Desktop | `desktop/package.json`、`desktop/CHANGELOG.md` | `desktop-vX.Y.Z` | GitHub Release | Windows x64 NSIS、Linux x64 AppImage 与 deb |

前端私有包版本不代表产品版本。单独调整版本时不改写依赖锁文件。macOS 构建只作为手动可选检查，当前不属于正式资产；包使用 ad-hoc 签名，未进行公证。

## 发行流程

1. 在 `main` 上手动运行 [`tag.yml`](../../.github/workflows/tag.yml)，选择 `prepare` 和 `cli` 或 `desktop`，输入目标版本（例如 `0.0.4`）。工作流只更新所选产品的版本与更新记录，先对提交运行完整 CI，再创建审查 PR。审核并合并该 PR，等待合并提交的 `main` CI 成功。
2. 再运行 `tag.yml`，选择 `tag` 和相同产品版本。工作流确认标签尚不存在、提交属于 `main` 且该提交的必需 CI 已成功，然后创建 `cli-vX.Y.Z` 或 `desktop-vX.Y.Z` 标签。
3. **CLI/TUI：** 手动运行 [`publish.yml`](../../.github/workflows/publish.yml)，输入 `cli-vX.Y.Z`。工作流检查版本、提交、CI、npm 上的版本和安装包；发布使用 npm Trusted Publishing/OIDC，并要求 `npm-publish` GitHub Environment 配置必需审核者。
4. **Desktop 草稿：** 手动运行 [`release.yml`](../../.github/workflows/release.yml)，输入 `desktop-vX.Y.Z` 并保持 `publish=false`。工作流从标签提交构建 Windows 与 Linux 三种安装包、校验发行资产并创建或补齐 GitHub Release 草稿。
5. **公开 Desktop：** 检查草稿说明、三种安装包和 SHA-256 后，再运行同一工作流并设置 `publish=true`。工作流重新核对标签与全部资产，检查 `desktop-publish` Environment 已配置必需审核者，然后等待该 Environment 审批；获批后才公开 Release。

版本、更新记录和发布渠道必须保持产品隔离。不要重用标签或 npm 版本。重试前先检查 [GitHub Releases](https://github.com/xswt442-cmd/ligule/releases) 与 [npm 包](https://www.npmjs.com/package/ligule)。正式发布前须为 `npm-publish` 和 `desktop-publish` GitHub Environments 配置必需审核者。

随包 Node 运行时及其归档校验值以 [`desktop/node-pin.json`](../../desktop/node-pin.json) 为准。修改运行时版本时更新该文件并验证各目标安装包。
