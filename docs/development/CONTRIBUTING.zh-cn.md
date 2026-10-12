# 贡献与验证

[简体中文](CONTRIBUTING.zh-cn.md) · [English](CONTRIBUTING.en.md)

仓库包含 Node.js 运行时、TUI 和 Tauri 桌面应用。开始修改前，请阅读仓库根目录的 [Agent 指南](../../AGENTS.md)及目标目录中的 `AGENTS.md`。[架构说明](ARCHITECTURE.zh-cn.md)介绍组件归属和数据流；[术语表](GLOSSARY.zh-cn.md)统一项目用语。

## 安装与验证

使用 Node.js 24 或更新版本。在仓库根目录安装锁定的依赖并运行核心检查：

```sh
npm ci
npm test
npm run check-pack
```

`npm test` 会构建 `dist/` 并运行自动化测试。`check-pack` 检查 npm 包产物。发行工作流还会将打包产物安装到干净的消费者环境中，并使用对应平台的搜索包进行验证。

桌面前端需要安装其依赖，再运行检查和构建：

```sh
npm --prefix desktop/frontend ci
npm --prefix desktop/frontend run check
npm --prefix desktop/frontend run build
```

在 `desktop/src-tauri/` 中运行 `cargo fmt --check` 和 `cargo test` 检查 Rust 壳。要启动完整桌面应用，在 `desktop/` 安装依赖后运行 `npm --prefix desktop run dev`；壳会启动 Node Host，正式安装包使用构建后的前端。

## 让改动可核验

从实现和测试描述行为。保持中文与英文使用手册中的用户可见行为一致，并区分自动化覆盖、平台验证和人工验证。提交中不要加入凭据、个人会话记录或生成的 `desktop/vendor/` 文件。依赖变动要同时更新清单和锁文件。

CI 会在 Windows 和 Linux 上检查核心包，在四种桌面目标上测试原生凭据存储，并分别为 Windows x64、Linux x64、macOS arm64 和 macOS x64 构建桌面安装包。CI 构建产物用于验证，不等于公开发行。发行流程和当前发行状态见[维护者发行清单](RELEASE.zh-cn.md)。

## 相关文档

[架构说明](ARCHITECTURE.zh-cn.md)介绍内核和适配器的依赖方向；[使用手册](../guide.zh-CN.md)介绍 CLI、TUI 和桌面端的用户操作。
