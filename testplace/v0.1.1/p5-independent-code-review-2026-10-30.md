# Ligule v0.1.1 P5 — 独立实现审查与结构收敛记录（2026-10-30）

> 状态：**下方是 2026-10-30 的独立审查基线；之后 R1–R4 与 P5-H/Telemetry CI 修复均已推送，SHA `7375b97` 的 push 和 PR CI 全绿。本文件保留原复现证据；PR #40 仍因缺少实质机器人 Review 而保持 Draft，尚未满足合并门禁。**
>
> 基线：`ligule` 仓库 `dev` / `origin/dev` HEAD `258f31ca7a42a9061de07a10a12d71554dd833eb`；相对 `main` 382 个变更文件、约 110 个提交，PR [#40](https://github.com/xswt442-cmd/ligule/pull/40) 为 Draft。此次仅作只读源码审查和受控复现；**未修改源码、分支或 PR**。本机原有未跟踪 `evals/harbor/__pycache__/` 未清理。
>
> 审查口径：对核心 Runtime/Session、Policy/Permission、文件操作、MCP/外控、Telemetry、ATIF/Harbor/Report、Desktop IPC、依赖及 CI 做重点源码审查与部分实际测试，**并非 382 个文件逐行形式化审计**；未观察到漏洞不等于安全证明。

## 后续修复进度（2026-10-30）

- **R1 已修复并推送**：`e37e8c1 fix(evals): require completed runs in reports`。综合 pass 现在要求 Harbor verifier reward 有效且 Ligule Run 为 `completed`；failed/cancelled/interrupted/unknown 不会冒充 clean pass。Harbor `0.25.0` Report 回归 8/8 通过，并已重新生成下方真实 15-attempt 结构化报告。
- **R2 已修复并推送**：`44bd2af fix(runtime): balance overlapping work pauses`。TaskWork 的 suspend/resume 改为平衡引用计数，覆盖双重交互、手动暂停组合、工作结束释放、取消和累计等待；API/Host 定向回归通过。此前 Ubuntu CI 两次失败在 `tui-external-control.test.js` 等待输入文本的 test harness 条件，后续 `0420dd7` 的 PR CI 全绿，未发现 TaskBudget 栈失败。另一次 Windows 全量本机运行的 TUI 清理出现 transient `EBUSY`，辅助器现仅对 Windows 测试目录删除做最多 5 次有界重试；TUI 180/180 通过，断言和 UI 等待条件未放宽。
- **R3 已修复并推送**：`1a30fbf fix(capability): require healthy managed process readiness`。`readyUrl` 现在必须返回 2xx 才进入 `running`；503→200 后才就绪，非 2xx 不会通过。端口预检匹配 `127.0.0.1`/`::1`，`localhost` 检查两种回环地址。定向 managed-process 回归通过，英中文架构文档已同步。
- **R4 已修复并推送**：`0420dd7 fix(evals): count ATIF agent response steps`。每个持久化 Agent 响应在 ATIF 中记 `llm_call_count: 1`，含 overflow compaction 的逻辑模型步计一次；隐藏传输重试和系统压缩请求不伪装成逐 HTTP 请求计数。Reporter 检出缺失的子代理轨迹后让总模型调用数保持 unknown。真实 `Session → ATIF → Report` fixture 和缺失子代理回归通过。
- **R5 结构化产物已生成**：`ligule/testplace/evals/p5-harbor-real-20261029/{report-input,report}` 保存全部 15 个真实 Harbor attempt、8 个任务、12 条旧 ATIF 轨迹，Report 分类为 2 pass、3 fail、10 infra_error；成本 unknown。旧轨迹由 R4 修复前的代码生成，因没有 `llm_call_count`，这批 `model_calls` 全部保持 unknown；没有回填推断值。原始结果未被重写。
- **P5-H 已提交推送并通过 CI**：`190cc05` 将 OTLP endpoint 校验、Exporter 环境变量隔离、Span 生命周期及 shutdown 逻辑提取到 `telemetry-otlp.ts`；`telemetry.ts` 保留有界 JSONL 队列/锁/Manifest/轮转与 `createTelemetry/emit/flush/shutdown` 门面。`6e7448a` 将 Host 的 `loopLimitsOf`、`sessionLoopLimits`、`taskLimitsOf`、`compactionLimitsOf` 提取到 `host/runtime-limits.ts`，并保留 `compactionLimitsOf` 原导出。未增加通用 Host Context，没有 Session/API schema 或权限变化。
- **H4 责任选择依据**：没有选择 Export/Artifact，因为其处理读取当前 Session/Project Environment、Permission boundary、MediaStore、spill 和分支，并负责逐文件冲突/失败结果；提取它会把较宽的 Host 闭包状态变成新上下文接口。Runtime limits 是更稳妥的替代：稳定的配置/Session 值解析，有显式输入输出，不执行文件或 Host 生命周期副作用。依赖方向为 `telemetry.ts → telemetry-otlp.ts`；runtime-limits 只依赖 Kernel error/budget/loop 类型、Capability limits、result limit，不反向引用 Host。
- **H4 回归映射**：`telemetry-otlp.test.js` / `telemetry-host.test.js` 覆盖 OTLP endpoint、Span 属性、隐私、失败隔离与 shutdown；`telemetry.test.js` 覆盖 JSONL/轮转/并发/孤儿临时文件和硬链接、符号链接 fail-closed；`compaction.test.js`、`interaction-budget-host.test.js`、`task-budget.test.js`、`tests/p3-runtime.test.js` 覆盖 Runtime-limit 输入行为。本机完整 `pnpm test`、eval smoke、依赖/语法守卫、pack 和安装验收均通过。
- **Telemetry CI 根因已定位并修复**：Push Run `41007714004` 的 Ubuntu shared-tests 在 `restart writers reuse one capped directory` 失败，实际多出 `telemetry.manifest.<uuid>.tmp`。shutdown 有意受 250ms 上限约束，底层原子写在返回后仍可能收尾；锁内的后续 writer 现在只回收符合严格 UUID 名称、普通文件且单链接的孤儿临时文件，其他未知文件、符号链接、硬链接仍 fail-closed 并保留。重启测试显式 flush 后再 shutdown，shutdown 有界性测试仍独立保留。新增孤儿恢复、硬链接、符号链接回归；Telemetry/OTLP/Host Telemetry 定向测试 24/24 通过；新 SHA `7375b97` 的 push/PR CI 均通过。
- **最新本机完整门禁**：`pnpm test` Core 956 项（935 pass、21 skip）、TUI 180/180、集成 193 项（190 pass、3 skip）、Engineering 19/19；`pnpm run eval:smoke` Adapter 14/14、Session/ATIF 6/6、Harbor 官方 ATIF validator、CLI mock-provider 1/1、Report 10/10；`pnpm check:dependencies` 357 modules / 1474 dependencies、`pnpm run check:syntax` 240 files、`pnpm check-pack`、`pnpm verify-install` 均通过。
- SHA `7375b97` 的 Push Run `41013296743` 与 PR Run `41013302439` 全部必要 CI jobs 成功。CodeRabbit 因 PR 文件数超限制跳过；Copilot 返回请求者剩余额度不足；没有实质机器人 Review。PR #40 仍 Draft，禁止合并。

## 一、总体结论与正向证据

- Runtime、Session JSONL、Run Receipt、取消/失败结果关联、跨平台安装产物与最小权限设计已有较系统的实现；本轮审查未发现已证实的审批/IPC/Grant 直接越权路径。
- F1 已收敛为系统回收站：`core/src/tools/write.ts` 在发送前做目标身份复核，后端错误后再次复核，无法确认时返回 `delete_outcome_unknown`；不再自建跨卷回收数据库。最终检查与 OS API 调用仍有 TOCTOU，写/编辑对外部并发写也不是原子事务，这些是已描述限制，不在本报告中宣称被消除。
- Harbor 固定自选 Terminal-Bench 2.1 8-task 子集：Oracle 8/8；Ligule 15 次 attempt、12 份实际 ATIF 经 Harbor 官方 validator 验证；按 **Run completed 且 independent verifier pass** 统计，仅 2/8 clean task pass。`testplace/evals/p5-harbor-real-20261029/{RESULTS.md,TASKSET.md}` 是现有本地证据；非官方全量榜单，费用未知，FeatureBench-Lite 为 `not_run`。
- GitHub PR Run [40996587236](https://github.com/xswt442-cmd/ligule/actions/runs/40996587236) 对应 `258f31c`，10/10 Jobs 成功（Windows/Linux 共享测试、Electron、凭据、CLI 构建及干净消费者安装、Harbor/ATIF smoke）。CodeRabbit 因变更文件数超上限跳过，**不存在实质机器人 Review 通过**。
- 本次额外实测：TypeScript 构建、`pnpm check:dependencies`、`pnpm check:syntax` 通过；ATIF、OTLP、删除失败、TaskBudget 定向测试 **21/21 通过**。后续反例未被原定向测试覆盖。

## 二、待处理问题（按优先级）

### R1 — P1：失败 Ligule Run 可被 Eval Report 算作 pass（已复现）

- 位置：`evals/report/report.py` 的 `_classify()`（约 410–443 行）与 `_ligule_run_metadata()`。
- 根因：`_classify` 依据 Harbor verifier reward 和部分 exception 类型决定 pass，没有将已解析的 Ligule `state=failed` 作为 clean pass 的否决条件；`_ligule_run_metadata` 只把该状态另存供展示。
- 复现：用 Harbor 0.25.0 正式 `TrialResult` 模型提供 `reward=1.0`、`AgentContext.metadata.ligule.state=failed`：① 带 `AgentTimeoutError` 得到 `('pass','timeout',1.0)`；② 无 Harbor exception、Ligule `errorCode=loop_model_budget_exhausted` 得到 `('pass',None,1.0)`。
- 影响：机器可读报告 `pass_rate` 可高估 clean task pass；`RESULTS.md` 手工严格统计的 2/8 **不能直接推断**已受污染。
- 修复验收：显式分离 Harbor 原始 reward、Ligule Run 终态、综合 clean pass；有 Ligule 元数据且状态为 failed/cancelled/interrupted 时不能 clean pass；状态缺失时不能无条件声称已知 completed，定义兼容策略并说明。覆盖两组反例、completed+reward 1.0、completed+reward 0、状态未知及异常分类，重新生成真实报告。

### R2 — P1：同一 TaskWork 内重叠交互导致执行计时错误恢复（已复现）

- 位置：`core/src/kernel/task-budget.ts` 的 `startInteraction()`（约 107–132 行）。
- 根因：每次交互开始均 `work.suspend()`，而任意一次结束即 `work.resume()`；`TaskWork` 是布尔暂停态，缺少交互引用计数，剩余交互未结束时执行期限已恢复。
- 复现：`createTaskBudget({timeoutMs:150,requestTimeoutMs:100,interactionWaitTimeoutMs:1000,maxModelCalls:5})`，在同一次 `runWork` 内开启两次 `startInteraction`，只结束第一次，等待 240ms；实际 `executionPaused=false`、`task_deadline_exceeded`，但第二次交互仍未结束。
- 影响：违反 F3 的“只有完全解除交互阻塞才恢复执行时钟”不变量；目前已确认 **TaskBudget API 缺陷**，相同 TaskWork 的双重交互是否可由现有 Host/UI 触发仍需调用链与 Host 测试确认，不能直接宣称用户已遇到事故。
- 修复验收：工作单元内按交互引用计数恢复；处理双重释放、取消、工作单元结束、与其他并行工作同在时的期限，保证累计交互等待只按墙钟计一次；增加 API 与 Host 级定向回归。

### R3 — P2：Managed Process “ready” 接受 HTTP 503（已复现，需明确契约）

- 位置：`core/src/capability/managed-process.ts:60–81` 的 `waitForReady()`。
- 复现：本机 HTTP Server 固定返回 503，`createManagedProcessRegistry().start()` 返回 `{status:"running",ready:true}`。
- 代码目前采用“收到任意 HTTP 响应就是就绪”的语义；如 `readyUrl` 用作健康检查，此语义与用户期望的 ready 冲突。`assertPortAvailable` 仅检查 IPv4 `127.0.0.1`，而 URL 允许 `::1`。
- 修复验收：先决定并写清“可访问”还是“健康就绪”；推荐健康接口以 2xx 表示成功，3xx、4xx、5xx 不标 ready，处理 503→200 状态转变与超时；按实际目标地址族核实端口检查。不要误称这是进程所有权绕过。

### R4 — P2：ATIF 与 Report 的 model_calls 计量契约不匹配（已复现）

- 位置：`core/src/session/atif.ts` 生成 `source='agent'` Step 的逻辑（约 205–216 行），与 `evals/report/report.py:341–343`。
- 复现：用真实编译的 `sessionTurnToAtif()` 从 User/Usage/Assistant/Turn 记录生成轨迹：Step 有 `metrics.prompt_tokens` 与 `completion_tokens`，**无 `llm_call_count`**；报告仅在全部 Agent Step 提供 `llm_call_count` 时才计算 `model_calls`，因此真实轨迹指标为 `null`。报告测试人工 fixture 则包含该字段。
- 修复验收：确认一个 ATIF Step 和模型请求的准确映射后填充可证的计数，不能推断时保留 unknown；新增“真实 Session → ATIF → Report”跨模块测试，另覆盖模型重试、Compaction 和子代理缺失。

### R5 — P2：真实固定评测集的结构化报告交付未在当前 Windows 现场确认

- 已有 `testplace/evals/p5-harbor-real-20261029/RESULTS.md` 和 `TASKSET.md`，但此次对 Windows `testplace/evals/` 的文件扫描未找到该批真实结果的完整 `manifest.json` + `report.json`；不排除 WSL、外部 job 目录另有文件。
- 修复验收：先检索原始 job 位置、核验并保留全部 15 次 attempt，不可只保留成功题；按 `evals/report` 真实输入契约生成 JSON/Markdown 报告，对照 8 个任务、2/8 clean task pass、12 次已产生 ATIF 的 Run、3 次未产生 Run/ATIF 的预启动失败、未知费用。若原始证据不全，标记缺失和阻塞，不能根据 Markdown 捏造 Harbor `result.json`。
- 必须先修 R1 再验收本项，以防报告再次误报 pass。

## 三、可维护性：正式纳入 P5-H（结构收敛，而非重写）

- `core/src/kernel/telemetry.ts` 单文件承载事件脱敏、JSONL 队列、跨进程锁/Manifest/轮转/容量约束、OTel/OTLP Span 与导出等可独立变化的职责；当前对外门面 `createTelemetry(): emit/flush/shutdown` 值得保留。
- `core/src/host/host.ts` 承载 Host 环境构造、会话及 Run 状态、审批与交互、Artifact/Export、Storage、MCP/控制等众多职责；直接按行数拆会导致闭包依赖泄漏和新的反向耦合。
- **决策变更（2026-10-30）**：此前计划留在 PR 后的 Telemetry 拆分和 Issue [#41](https://github.com/xswt442-cmd/ligule/issues/41)，现在提升为 P5-H 的**实际工程目标**；先修 R1/R2，再增量提取 Telemetry 中完整的 OTLP 内部实现和 Host 中至少一个有清晰接口的低风险职责。现有 Issue 属历史跟踪，不自动视为已完成；实施者应更新关联关系。
- 按业务边界拆分，保留原有 public exports、Session/Event schema、错误码、权限、异步顺序和资源释放语义。禁止为凑文件数量拆纯转发壳、无限增加抽象/通用 Context 对象或扩散修改到 P1–P4 全部模块。
- 拆分需要先留下依赖图、现状职责表、迁移顺序、影响面和验证清单。每次仅抽出一块并跑回归；涉及 `host.ts` 的 Session/Run/approval 核心状态机，未有独立回归和低风险分界前不顺手移动。
- 以可读性、单一职责、接口显式和可独立测试为成功标准，不设“单文件必须少于 X 行”的机械指标，也不靠增减依赖图边数判断质量。

## 四、执行顺序和门禁

1. **先封住 R1/R2**：分别写最小反例测试、修复根因、运行针对性与跨模块回归；补 R3/R4，完成 R5 的真实报告生成或准确记录阻塞。
2. **再实施 P5-H**：Telemetry → OTLP 拆分优先；Host 选择一块边界清晰的功能（例如 Export / Artifact 的可独立部分）提取，不强行拆全部 Host。
3. 逐阶段对比变更前后的公开 API、权限和 Session 协议行为；执行 `pnpm test`、`pnpm check:dependencies`、`pnpm run check:syntax`、`pnpm check-pack`、`pnpm verify-install`、`pnpm eval:smoke`，并检查 Linux/Windows Electron、CI；补关键负向/失败用例。
4. PR #40 仍需解决“382 files > CodeRabbit 100 files”造成的实质审查缺口。CI 绿不等于代码已审查；**代码拆分也不能自动解决 PR 过大问题**。不可擅自重写 `dev` 历史、force push、关闭门禁或把这份审查代替 CodeRabbit。
5. 任何一步出现用户数据、授权、Session 恢复或跨平台兼容回归，优先回滚**该步骤可控的局部改动**（保护其他人变更），记录失败，不强行进入下阶段。

## 五、审查边界与事实区分

- **已复现**：R1、R2、R3 行为、R4 ATIF 字段缺失。
- **现场未找到完整产物**：R5；不是“证明产物在所有地方不存在”。
- **评估性建议**：Telemetry/Host 职责拆分、R3 对健康检查的建议语义。
- **仍待复核**：全部 382 文件的逐行审查、各路径的动态行为安全证明、macOS 特定系统能力、重叠交互是否由真实 Host/UI 可达、所有 Benchmark 原始 job 的完整性。
- 本轮未提交、不创建 PR、不宣称全部 P5 已通过新门禁。
