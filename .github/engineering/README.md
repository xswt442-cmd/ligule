# Engineering Standards · 工程化规范

此目录是工程化规则、模板与配套 Skill 的**单一权威源**，服务多个仓库，但不代替项目自己的工程事实与 CI。

## 内容导航

- [ENGINEERING_STANDARD.md](ENGINEERING_STANDARD.md)：公开仓库内容准入、文档归属、版本发行、双语 PR 和 Agent 约束。
- [ADOPTION.md](ADOPTION.md)：现有项目接入、验证与后续同步检查。
- [templates/AGENTS.md](templates/AGENTS.md)：仅英文的可移植 Agent 规则模板；必须按项目真实边界调整。
- [templates/CLAUDE.md](templates/CLAUDE.md)：Claude 兼容入口。
- [templates/CHANGELOG.md](templates/CHANGELOG.md)：按「新增 / 改进 / 修复」分类的中英双语 Changelog 样例。
- [templates/SECURITY.md](templates/SECURITY.md)：安全策略的权威模板。
- [templates/CONTRIBUTING.md](templates/CONTRIBUTING.md)：贡献指南的权威模板。
- [templates/RELEASE.md](templates/RELEASE.md)：通用发行及回滚操作说明。
- [skills/README.md](skills/README.md)：把 Skill 装进项目 `.agents/skills/` 的说明、命名与一致性要求。
- [skills/mypr/SKILL.md](skills/mypr/SKILL.md)：按项目 PR 模板撰写内容的轻量 PR Skill；**PR 模板正文随它一起放在 `skills/mypr/repo/.github/PULL_REQUEST_TEMPLATE.md`**。
- [skills/mydocs/SKILL.md](skills/mydocs/SKILL.md)：确定文档内容归属，核对事实保真、适用范围与全文一致性。
- [skills/mydocs/references/whole-document-review.md](skills/mydocs/references/whole-document-review.md)：全文一致性、断言适用范围与改后事实保真的审查清单。
- [skills/mydocs/scripts/lint-docs.mjs](skills/mydocs/scripts/lint-docs.mjs) 与 [rules.json](skills/mydocs/rules.json)：零依赖的结构检查器，检查 README 内部话题标题、二级标题数量及中英结构对应情况。
- [skills/myshuohua/SKILL.md](skills/myshuohua/SKILL.md)：检查正式技术中文的用词、动宾搭配、术语、句式与改后复核。
- [skills/myshuohua/scripts/lint-shuohua.mjs](skills/myshuohua/scripts/lint-shuohua.mjs) 与 [rules.json](skills/myshuohua/rules.json)：零依赖的词句检查器，覆盖分号、句长、段落长度、列表句数、完整句重复、术语写法和固定短语；另支持可选项目术语表。
- [skills/myshuohua/references/language-zh.md](skills/myshuohua/references/language-zh.md)：lint 数不出来的毛病，分用词和句式两节，每类都给反例和改法。
- [scripts/release-notes.mjs](scripts/release-notes.mjs)：从目标版本 Changelog 提取发行说明的无依赖脚本。
- [scripts/skills.mjs](scripts/skills.mjs)：遍历每个 Skill 自带的安装脚本，检查或安装 `.agents/skills/`。
- [scripts/sync-community.mjs](scripts/sync-community.mjs)：检查或补建 SECURITY 与 CONTRIBUTING。
- [tests/](tests/)：脚本自动化测试。

## 权责划分

1. **本仓库**版本化通用原则和通用模板；只有这里的内容是规范权威源。
2. **项目仓库**中的 `AGENTS.md`、PR 模板、Skill、CHANGELOG、CI 和发行手册必须在该项目仓库内可独立阅读和使用；已核实的项目实际行为优先于通用示例。
3. PR：工程规范规定原则，项目的 `.github/PULL_REQUEST_TEMPLATE.md` 规定正文结构，项目的 `.agents/skills/mypr/SKILL.md` 负责调查 Diff、解释最终实现和填写真实验证；三者不可各定义一套 PR 格式。
4. **变更传播是显式的。** 修改本目录不自动改变产品仓库；同步后各项目独立审查、测试和提交。严禁直接修改历史 Tag 或二进制发行资产。

## Skill 安装

`skills/` 是源，Agent 不从这里加载。每个 Skill 自带 `scripts/install.mjs`，负责把自己（以及 `repo/` 下的镜像文件）装进 `.agents/skills/<name>/`；安装知识写在各自的 `SKILL.md` 里，改动原因与校验要求见 [skills/README.md](skills/README.md)。

从本仓库根目录执行：

```sh
node .github/engineering/scripts/skills.mjs --check /path/to/target-repo
node .github/engineering/scripts/skills.mjs --apply /path/to/target-repo
```

`--check` 不写入，发现差异以非零状态退出；`--apply` 写入，遇到有本地改动的路径直接拒绝。`skills.mjs` 只是遍历分发，新增 Skill 不需要改它。

## 社区健康文件同步

`SECURITY.md` 与 `CONTRIBUTING.md` 由 GitHub 按固定名称在 `.github/`、仓库根目录、`docs/` 查找，属于单名文件，不参与双语文档对。权威模板在本目录 `templates/` 下，本仓 `.github/` 下的两份是字节一致的兼容副本，由 `tests/repository-layout.test.mjs` 校验。

从本仓库根目录执行：

```sh
node .github/engineering/scripts/sync-community.mjs --check /path/to/target-repo
node .github/engineering/scripts/sync-community.mjs --apply /path/to/target-repo
```

检查目标仓库的文件位置、唯一性与必需章节，而不是要求与权威模板逐字相同：受理范围、验证命令与发版入口由各产品仓按自身事实改写。`--apply` 只为缺失的文件写入权威模板，已有副本一律不覆盖；位置重复或章节缺失的副本由人工审查。
