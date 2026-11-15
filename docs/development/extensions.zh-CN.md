# Host 扩展

Ligule 扩展是受信任的 Node.js 模块，由 Host 从用户配置声明的路径或用户扩展目录加载。扩展与 Host 运行在同一进程内，不是操作系统沙箱。Core 仍是仓库内部模块，不单独发布为 SDK。

## 启用扩展

在用户 `config.toml` 的顶层 `extensions` 数组中填写绝对路径：

```toml
extensions = [
  "/absolute/path/to/project-audit.mjs",
  "/absolute/path/to/project-context.mjs",
]
```

Host 只会在打开使用 `full-access` Permission 和 `unrestricted` network 的 Session 时加载配置的扩展。已打开的 Session 修改 Permission 后不会热加载或移除扩展；提高权限后需关闭并重新打开 Session。已有的 Policy、工具预检、审批、沙箱选择和 Session 记录仍然生效。扩展不能提升 Permission，也不能覆盖拒绝结果。请把每个配置模块都当作可执行的受信任代码。

## 通过 Kernel 请求工具

扩展可以注册组合工具，并在该工具运行时通过 `host.request` 请求其他工具。每个嵌套调用都会独立经过 Kernel 参数校验、Permission 与 Policy 判定，使用同一取消信号，并写入 Session 事件。外层工具声明的访问等级不会授予嵌套工具权限。

[`core/examples/extensions/project-audit.mjs`](../../core/examples/extensions/project-audit.mjs) 会读取文件、搜索内容，并通过 `exec` 运行固定命令 `node --version`。示例声明 `exec` 访问等级，因此调用者需要相应 Permission；嵌套 `exec` 仍经过正常审批和执行检查。示例限制了每段返回内容的长度。

`host.request` 需要活动 Run。扩展 setup、事件回调和定时器没有活动 Run，因此不能使用该能力。请求准备和完成 Hook 只能请求只读 Kernel 工具。工具前置和结束 Hook 不能发起嵌套请求。

## 添加请求上下文和完成检查

[`core/examples/extensions/project-context.mjs`](../../core/examples/extensions/project-context.mjs) 展示两个 Hook 阶段：

- `prepareRequest` 通过 Kernel 读取一小段 README，并将其加入当前 Provider 请求。它不会把内容写入用户的 Session 输入。
- `completeRun` 检查当前完成候选，并通过 Kernel 读取 `verification.txt`。演示任务的第一个候选会返回 `continue`；Host 会把有界原因加入下一次请求，并继续消耗同一个 Run 的预算。后续候选只有在文件内容为 `PASS` 时才会接受。

`accept` 只表示扩展自己的检查条件成立，不代表独立 Verifier 已通过。`continue` 不会重置迭代或模型调用预算。它会使之前的结构化提交失效，必须重新提交并检查。Hook 输出受现有提示片段长度限制。`fail` 原因会校验并限制为 512 个 UTF-8 字节；Session 和持久 Run 结果保存稳定错误码。Hook 错误或 `fail` 决定都会阻止成功结束，后续 Hook 不能覆盖失败。

完成上下文包含当前 Run、Session 事件范围、候选编号；如果有结构化结果，也包含其摘要。外部检查结果应与这些字段一并关联。扩展诊断不要保存原始提示、凭据或完整工具结果。

## 兼容与生命周期

`onEvent` 仍然只用于观察。Hook 按登记顺序运行，并由登记它的扩展持有。Run 取消时会取消其 Hook 请求，Hook 也受现有请求时限约束。Host 关闭时会等待异步 disposer；它无法强制终止任意受信任的 JavaScript。

嵌入式和 stdio/MCP 集成都使用现有 Host API。Core 扩展合同不会新增第二套协议、工具注册表、Session 存储、全局锁或公开 Core 包。示例使用可移植的项目相对文件名，不会通过直接文件系统操作伪造工具结果。

## 验证改动

Core 扩展和嵌入式 Host 回归使用：

```sh
node --experimental-strip-types --test core/tests/extensions.test.ts core/tests/subagent.test.ts
```

stdio/MCP 集成会启动真实 CLI 子进程并使用 SDK 传输：

```sh
node --experimental-strip-types --test --import ./tests/hooks/isolated-data-root.ts tests/mcp-server.test.ts
```

完整仓库回归使用 `pnpm test`。
