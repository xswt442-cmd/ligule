# 维护者发行说明

Ligule 分为两条独立发行线，版本可分别推进：

| 产品 | 版本来源 | 标签 | 发布渠道 | 正式资产 |
| --- | --- | --- | --- | --- |
| CLI / TUI | 根目录 `package.json`、`src/version.ts`、`CHANGELOG.md` | `cli-vX.Y.Z` | npm `ligule` + GitHub Release Notes | npm 包；GitHub 仅发布说明，不附安装包 |
| Desktop | `desktop/package.json`、`desktop/CHANGELOG.md` | `desktop-vX.Y.Z` | GitHub Release | Windows x64 NSIS、Linux x64 AppImage 与 deb |

前端私有包版本不代表产品版本。单独调整版本时不改写依赖锁文件。macOS 构建只作为手动可选检查，当前不属于正式资产；包使用 ad-hoc 签名，未进行公证。

## 发行流程

1. 在 `main` 上手动运行 [`tag.yml`](../../.github/workflows/tag.yml)，选择 `prepare` 和 `cli` 或 `desktop`，输入目标版本（例如 `0.0.4`）。工作流只更新所选产品的版本与更新记录，先对提交运行完整 CI，再创建审查 PR。审核并合并该 PR，等待合并提交的 `main` CI 成功。
2. 再运行 `tag.yml`，选择 `tag` 和相同产品版本。工作流确认标签尚不存在、提交属于 `main` 且该提交的必需 CI 已成功，然后创建 `cli-vX.Y.Z` 或 `desktop-vX.Y.Z` 标签。
3. **CLI/TUI：** 手动运行 [`publish.yml`](../../.github/workflows/publish.yml)，输入 `cli-vX.Y.Z`。工作流检查版本、提交、CI、npm 上的版本和安装包；发布使用 npm Trusted Publishing/OIDC，并要求 `npm-publish` GitHub Environment 配置必需审核者。**仅在 npm 发布流程成功且 Registry 可查后**，工作流使用标签提交的 `CHANGELOG.md` 创建独立的 `CLI/TUI vX.Y.Z` GitHub Release（中英文 Notes、安装命令与 npm 链接，**不附安装包，也不抢占 Desktop 的 Latest 标记**）。重试时保留已有公开 Release，不自动覆盖已有正文或重新执行已存在版本的 npm 发布。
4. **Desktop 草稿：** 手动运行 [`release.yml`](../../.github/workflows/release.yml)，输入 `desktop-vX.Y.Z` 并保持 `publish=false`。工作流从标签提交构建 Windows 与 Linux 三种安装包、校验发行资产并创建或补齐 GitHub Release 草稿。
5. **公开 Desktop：** 检查草稿说明、三种安装包和 SHA-256 后，再运行同一工作流并设置 `publish=true`。工作流重新核对标签与全部资产，检查 `desktop-publish` Environment 已配置必需审核者，然后等待该 Environment 审批；获批后才公开 Release。

## Release Notes 内容与下载表规范

- **两条产品线各自维护 Changelog：** `CHANGELOG.md` 对应 CLI/TUI，`desktop/CHANGELOG.md` 对应 Desktop。每个正式版本要有简体中文与英文的**具体变化说明**，优先按功能、交互、安全与兼容性分组；不允许只写“优化体验、修复问题”等没有场景的空泛句子。小型修复可只写实际变动，不必凑条数。
- **CLI/TUI：** 说明交互模式、工作区/会话行为、可靠性变化与使用条件；`release-notes.js` 自动加上 Node.js 版本、安装命令和 npm 包链接，不上传重复安装包。
- **Desktop：** 说明架构变动、工作区/审批与保存导出、原生运行时以及支持平台范围；`release-notes.js` 自动生成“操作系统 / 安装包格式 / 适用情况 / 下载”表格。正式 Release 的直链必须来自先通过 SHA-256 和来源校验的 `desktop-release-manifest.json`；不要根据版本号猜测安装包名称，更不能保留“稍后上传草稿附件”的占位文案。
- Desktop 的 `publish=false` 草稿工作流在完成 `desktop-release-manifest.js verify` 后调用 `release-notes.js desktop-vX.Y.Z --manifest dist-release/desktop-release-manifest.json`。预览时不提供 manifest 只生成平台表和附件区链接，**不会伪造文件直链**。Notes 另附 `SHA256SUMS` 和 manifest 文件地址；macOS 未经过正式验证，不列为可下载目标。
- 已公开 Release 的说明如需修订，应验证对应真实 Tag、安装包资产和目标 Registry 后修改 Release 正文；不移动 Tag、不覆盖二进制，不会因此重新发布 npm 包。

版本、更新记录和发布渠道必须保持产品隔离。不要重用标签或 npm 版本。重试前先检查 [GitHub Releases](https://github.com/xswt442-cmd/ligule/releases) 与 [npm 包](https://www.npmjs.com/package/ligule)。正式发布前须为 `npm-publish` 和 `desktop-publish` GitHub Environments 配置必需审核者。

随包 Node 运行时及其归档校验值以 [`desktop/node-pin.json`](../../desktop/node-pin.json) 为准。修改运行时版本时更新该文件并验证各目标安装包。
