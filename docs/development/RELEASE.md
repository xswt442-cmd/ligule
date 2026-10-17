# 维护者发行说明

Ligule 分为两条独立发行线，版本可分别推进：

| 产品 | 版本来源 | 标签 | 发布渠道 | 正式资产 |
| --- | --- | --- | --- | --- |
| CLI / TUI | `tui/package.json`、`tui/src/version.ts`、`tui/CHANGELOG.md` | `cli-vX.Y.Z` | npm `ligule` + GitHub Release Notes | npm 包；GitHub 仅发布说明，不附安装包 |
| Desktop | `desktop/package.json`、`desktop/CHANGELOG.md` | `desktop-vX.Y.Z` | GitHub Release | Windows x64 NSIS、Linux x64 AppImage 与 deb |

`@ligule/core` 是私有 workspace 包，不设独立产品版本、Tag 或 Changelog。Core 修改分别按产品实际打入的 Core 代码记录在对应产品 Changelog 中；不得提前登记尚未包含的修复。前端私有包版本不代表产品版本。单独调整版本时不改写依赖锁文件。macOS 构建只作为手动可选检查，当前不属于正式资产；包使用 ad-hoc 签名，未进行公证。

## 发行流程

1. **在正常开发集成中准备版本，不创建版本专用 PR。** 在 `dev` 的功能/修复集成分支上维护对应产品的 `tui/CHANGELOG.md` 或 `desktop/CHANGELOG.md`，确保 `[Unreleased]` 有真实、双语的变更说明；在准备发布时运行 `node scripts/release-version.js prepare cli minor`、`node scripts/release-version.js prepare desktop 0.1.0` 等命令（两种产品分别执行，`patch` / `minor` / `major` 或确切 `X.Y.Z` 均可）。该命令仅修改指定产品的版本和 Changelog，**不会生成 Tag、发布或提交**。检查 diff、运行测试，随正常开发/集成提交进入 `dev`，再按仓库常规审查/合入流程进入 `main`。不为版本准备再额外创建 `release/*` 分支或版本专用 PR。
2. **在经过审查且 CI 成功的 `main` 上手动打 Tag。** 等待最终 `main` **同一 SHA** 的必需 CI 成功；在 `main` 上手动运行 [`tag.yml`](../../.github/workflows/tag.yml)，只需选择 `product=cli|desktop` 与已提交的精确 `version=X.Y.Z`。工作流检查产品 manifest 版本、双语 Changelog、Tag 不存在、运行提交等于当前 `main` HEAD、该提交的 `main` push CI 成功，之后才创建对应的 annotated `cli-vX.Y.Z` 或 `desktop-vX.Y.Z` Tag。若 CI 尚未通过、`main` 前进、版本不匹配或 Tag 已存在，**失败关闭，不做自动版本提交、强制 Tag 或跳过审查**。Tag 创建与后续正式发布仍是两项独立的人工动作。
3. **CLI/TUI：** 手动运行 [`publish.yml`](../../.github/workflows/publish.yml)，输入 `cli-vX.Y.Z`。工作流检查版本、提交、CI、npm 上的版本和安装包；发布使用 npm Trusted Publishing/OIDC，并要求 `npm-publish` GitHub Environment 配置必需审核者。**仅在 npm 发布流程成功且 Registry 可查后**，工作流使用标签提交的 `tui/CHANGELOG.md` 创建独立的 `CLI/TUI vX.Y.Z` GitHub Release（中英文 Notes、安装命令与 npm 链接，**不附安装包，也不抢占 Desktop 的 Latest 标记**）。重试时保留已有公开 Release，不自动覆盖已有正文或重新执行已存在版本的 npm 发布。
4. **Desktop 草稿：** 手动运行 [`release.yml`](../../.github/workflows/release.yml)，输入 `desktop-vX.Y.Z` 并保持 `publish=false`。工作流从标签提交构建 Windows 与 Linux 三种安装包、校验发行资产并创建或补齐 GitHub Release 草稿。
5. **公开 Desktop：** 检查草稿说明、三种安装包和 SHA-256 后，再运行同一工作流并设置 `publish=true`。工作流重新核对标签与全部资产，检查 `desktop-publish` Environment 已配置必需审核者，然后等待该 Environment 审批；获批后才公开 Release。

## Release Notes 内容与下载表规范

- **两条产品线各自维护 Changelog：** `tui/CHANGELOG.md` 对应 CLI/TUI，`desktop/CHANGELOG.md` 对应 Desktop。每个正式版本要有简体中文与英文的**具体变化说明**，优先按功能、交互、安全与兼容性分组；不允许只写“优化体验、修复问题”等没有场景的空泛句子。小型修复可只写实际变动，不必凑条数。
- **CLI/TUI：** 说明交互模式、工作区/会话行为、可靠性变化与使用条件；`release-notes.js` 自动加上 Node.js 版本、安装命令和 npm 包链接，不上传重复安装包。
- **Desktop：** 说明架构变动、工作区/审批与保存导出、原生运行时以及支持平台范围；`release-notes.js` 自动生成“操作系统 / 安装包格式 / 适用情况 / 下载”表格。正式 Release 的直链必须来自先通过 SHA-256 和来源校验的 `desktop-release-manifest.json`；不要根据版本号猜测安装包名称，更不能保留“稍后上传草稿附件”的占位文案。
- Desktop 的 `publish=false` 草稿工作流在完成 `desktop-release-manifest.js verify` 后调用 `release-notes.js desktop-vX.Y.Z --manifest dist-release/desktop-release-manifest.json`。预览时不提供 manifest 只生成平台表和附件区链接，**不会伪造文件直链**。Notes 另附 `SHA256SUMS` 和 manifest 文件地址；macOS 未经过正式验证，不列为可下载目标。
- 已公开 Release 的说明如需修订，应验证对应真实 Tag、安装包资产和目标 Registry 后修改 Release 正文；不移动 Tag、不覆盖二进制，不会因此重新发布 npm 包。

版本、更新记录和发布渠道必须保持产品隔离。不要重用标签或 npm 版本。重试前先检查 [GitHub Releases](https://github.com/xswt442-cmd/ligule/releases) 与 [npm 包](https://www.npmjs.com/package/ligule)。正式发布前须为 `npm-publish` 和 `desktop-publish` GitHub Environments 配置必需审核者。

随包 Node 运行时及其归档校验值以 [`desktop/node-pin.json`](../../desktop/node-pin.json) 为准。修改运行时版本时更新该文件并验证各目标安装包。

打包前构建当前 Core，并在对应平台重新执行 `pnpm run prepare-runtime`。Desktop 部署、构建与运行树检查，以及 CLI npm staging，逐文件核对 Core 的编译输出、模式、README 和许可证；任何缺失、多余或内容差异均拒绝继续。该检查确认产品实际包含当前构建的 Core，不能代替安装后行为验收。
