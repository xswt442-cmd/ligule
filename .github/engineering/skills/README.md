# Skill 安装

`.github/engineering/skills/` 是源，Agent 只在项目里的 `.agents/skills/<name>/` 下发现 Skill。**每个 Skill 自带安装脚本**，装法写在它自己的 `SKILL.md` 里；这里只放全仓一次性操作和三条要求。

三个 Skill 各管一段，互不包含：

| Skill | 管什么 | 判断法 |
| --- | --- | --- |
| `mypr` | PR 描述的结构与模板 | 这个改动该怎么讲给别人看 |
| `mydocs` | 文档分层、事实保真和全文一致性 | 整篇对谁说、哪些事实成立、前后有无矛盾 |
| `myshuohua` | 正式中文的词、句式、段落复核 | 这句话是否准确、完整、没有不合理表达 |

`mydocs` 和 `myshuohua` 各带一个检查器，查的东西不重叠：`lint-docs.mjs` 检查 README 标题和中英骨架，`lint-shuohua.mjs` 检查分号、句长、完整句重复、术语写法和固定短语。全文事实是否自洽、功能与限制有无冲突仍须由 Agent 按 `mydocs` 复核；零告警不等于文档已验收。`myshuohua` 对高置信度的无意义口语、营销词和工程黑话默认报 `error`，对需结合语境判断的句式仍给 `warning` 或 `info`；可用 `--strict` 提高检查力度，但不能直接依据词表自动改写事实。

## 一条命令装全部

```sh
node .github/engineering/scripts/skills.mjs --check .
node .github/engineering/scripts/skills.mjs --apply .
```

`skills.mjs` 只负责遍历 `skills/*/scripts/install.mjs`、转发参数并汇总退出码，新增 Skill 不用改它。想只装一个，直接跑那个 Skill 的脚本：

```sh
node .github/engineering/skills/mypr/scripts/install.mjs --check .
node .github/engineering/skills/myshuohua/scripts/install.mjs --apply .
```

`--source` 显示当前源目录最近一次 Git 变更的提交和日期，不用于验证已安装副本的来源。

## 每个 Skill 都是自足目录

```
skills/mypr/
  SKILL.md                              含「安装与更新」，安装知识在 Skill 里
  scripts/install.mjs                   只认自己所在的目录，不维护路径表
  repo/.github/PULL_REQUEST_TEMPLATE.md 镜像到仓库根目录
  CREDITS.md  agents/openai.yaml
```

落盘规则只有两条：

| 源 | 目标 |
| --- | --- |
| `repo/` 之外的所有文件（不含 `scripts/install.mjs`） | `.agents/skills/<name>/` 下同名路径；其他 `scripts/` 文件也会安装 |
| `repo/` 下的文件 | 仓库根目录下的同名路径（`mypr` 用于安装 PR 模板） |

安装脚本自动遍历源目录，新增参考文件或检查脚本无需更新路径清单。安装器只同步源中存在的文件，不会自动清理旧版本留下的额外文件；清理前须由仓库维护者核对。

## 三条要求

1. **逐字一致。** 副本与源必须字节相同；要改规则就改源再 `--apply`。仓库自己的补充写进 `AGENTS.md`，不改 `SKILL.md`。
2. **不用软链。** Windows 需要额外权限、跨盘失效、打包会丢；安装脚本会直接拒绝软链目标。
3. **名字带 `my` 前缀。** `mypr` / `mydocs` / `myshuohua` 而不是 `pr` / `docs` / `shuohua`：`.agents/skills/` 里可能已经有项目自有或全局安装的同名 Skill，重名时生效哪份取决于加载顺序，出了问题也看不出调用的是哪一个。

## 为什么不装到用户目录

`.agents/skills/` 随仓库提交，规则和代码走同一次评审、同一次回滚，换机器、换 Agent、换协作者都不用重新配置。装到用户级目录则会把某个私有仓库的规范带进无关项目，且无法在 PR 里审查。
