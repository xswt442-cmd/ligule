// 新建 Kernel 时工具表为空；只有通过 `register()` 登记的工具才能被调用。
// Kernel 不依赖传输层、界面框架或客户端适配器，CLI 和 Desktop 共用同一套工具与策略逻辑。
import { randomUUID } from 'node:crypto';
import { KernelError } from './error.js';
import { createConfig, type ConfigSnapshot } from './config.js';
import { createLogger, type Logger, type LoggerBackend } from './log.js';
import { failureOf, refusalOf, resultLimit, resultOf, spillContent } from './result.js';
import { VERDICT_FIELDS, type DecisionChain } from './policy.js';
import { createObservationLog, type ObservationLog } from '../session/observe.js';
import { resolveTarget, type NetworkTarget } from '../capability/network.js';
import { resolveShell, withNativeExitCode, type ShellKind, type ShellSelection } from '../capability/shell.js';
import { assertSupportedSchema, validateArgs } from './schema.js';

export interface ToolContext {
  readonly config: ConfigSnapshot;
  readonly logger: Logger;
  readonly observations: ObservationLog;
  readonly signal?: AbortSignal;
  readonly target?: NetworkTarget;
  readonly shell?: ShellSelection;
}

type BivariantToolCallback<TArgs, TResult> = {
  callback(args: TArgs, context: ToolContext): TResult;
}['callback'];

type BivariantCapability<TArgs> = {
  callback(args: TArgs): string;
}['callback'];

export interface ToolDefinition<TArgs = unknown> {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly execution?: 'parallel' | 'serial';
  readonly disclosure?: boolean;
  readonly readOnly?: boolean;
  readonly targetArgument?: string;
  readonly commandArgument?: string;
  capability?: BivariantCapability<TArgs>;
  run: BivariantToolCallback<TArgs, unknown | Promise<unknown>>;
}

interface RegisteredTool extends ToolDefinition {
  readonly parameters: Record<string, unknown>;
  readonly execution: 'parallel' | 'serial';
  readonly disclosure: boolean;
  readonly readOnly: boolean;
}

export interface ToolManifestEntry {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

export interface KernelSession {
  readonly directory: string;
  append(event: Record<string, unknown>): Promise<unknown>;
}

export interface KernelOptions {
  readonly config?: ConfigSnapshot;
  readonly policy?: DecisionChain;
  readonly session?: KernelSession;
  readonly logger?: LoggerBackend;
}

export interface Kernel {
  list(): string[];
  readOnly(): string[];
  selectable(): string[];
  execution(name: string): 'parallel' | 'serial';
  register(tool: ToolDefinition): () => void;
  manifest(): ToolManifestEntry[];
  validateCall(name: string, args: unknown): { readonly code?: 'tool_not_found' | 'tool_args_invalid'; readonly detail?: string };
  restrict(names: readonly string[]): () => void;
  call(name: string, args?: unknown, options?: { readonly callId?: string; readonly signal?: AbortSignal }): Promise<unknown>;
}

interface ToolEvent extends Record<string, unknown> {
  kind: 'tool';
  tool: string;
  callId?: string;
  args: unknown;
  shell?: { kind: ShellKind; executable: string; segments?: string[]; tail?: string };
  verdict?: Record<string, unknown>;
  durationMs?: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('message' in error)) return undefined;
  return typeof error.message === 'string' ? error.message : undefined;
}

// `options.config` 是加载器生成的配置快照，`options.logger` 是 Host 提供的日志接口。
// `options.policy` 决定调用如何判定，`options.session` 负责记录本次运行。
// 未提供策略时只检查工具登记和拒绝规则；未提供会话时不写入记录。
export function createKernel(options: KernelOptions = {}): Kernel {
  const config = options.config ?? createConfig({});
  // 使用 `createConfig` 生成的冻结快照，确保工具读取期间配置不会被修改。
  if (!Object.isFrozen(config)) throw new KernelError('config_snapshot_must_be_frozen');
  const policy = options.policy;
  const session = options.session;
  const logger = createLogger(options.logger);
  // 文件观察记录与工具表具有相同生命周期；覆盖文件前必须与此前读取的版本匹配。
  const observations = createObservationLog();
  const context = Object.freeze({ config, logger, observations });

  const tools = new Map<string, RegisteredTool>();
  // 按工具名维护 Host 添加的拒绝规则；多次 `restrict()` 可以为同一工具添加多条规则。
  const restrictions: Set<string>[] = [];

  function isDenied(name: string): boolean {
    return restrictions.some((denied) => denied.has(name));
  }

  // 限制注入模型的工具结果字节数；超限内容另存文件，记录中保留可读取的引用。
  async function withinLimit(
    result: ReturnType<typeof refusalOf> | ReturnType<typeof failureOf> | ReturnType<typeof resultOf>,
    directory: string,
  ) {
    const text = typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
    if (text === undefined) return result;
    const limit = resultLimit(config);
    if (Buffer.byteLength(text, 'utf8') <= limit) return result;
    const name = `result-${Date.now()}-${randomUUID().slice(0, 8)}.json`;
    return { ...result, content: await spillContent(text, { limit, directory, name }), spilled: name,
      spillFormat: typeof result.content === 'string' ? 'text' : 'json',
    };
  }

  async function record(
    entry: ToolEvent,
    result: ReturnType<typeof refusalOf> | ReturnType<typeof failureOf> | ReturnType<typeof resultOf>,
  ): Promise<void> {
    if (!session) return;
    await session.append({ ...entry, result: await withinLimit(result, session.directory) });
  }

  // 失败先写入会话记录再交给调用方；稳定错误码供分支判断，说明文字供模型查看。
  async function fail(entry: ToolEvent, error: KernelError): Promise<never> {
    await record(entry, failureOf(error.code, error.detail === undefined ? undefined : { content: error.detail }));
    throw error;
  }

  const kernel: Kernel = {
    // 返回本次运行中已登记的工具。
    list() {
      return [...tools.keys()].sort();
    },

    // 返回声明为可安全重试的工具名称。此字段仅用于恢复说明，不参与权限判定，也不会发给模型。
    readOnly() {
      return [...tools.values()].filter((tool) => tool.readOnly).map((tool) => tool.name).sort();
    },

    // 返回可供模式选择的工具名称，排除固定披露入口。
    selectable() {
      return [...tools.values()].filter((tool) => !tool.disclosure).map((tool) => tool.name).sort();
    },

    // 返回循环使用的执行分组；未声明或引用未知分组的工具按串行执行。
    execution(name: string) {
      return tools.get(name)?.execution ?? 'serial';
    },

    // 返回用于撤销本次登记的函数。重复名称会报错，不覆盖现有工具。
    register(tool: ToolDefinition) {
      if (!tool || typeof tool.name !== 'string' || tool.name === '') {
        throw new KernelError('tool_name_required');
      }
      if (typeof tool.description !== 'string' || tool.description === '') {
        throw new KernelError('tool_description_required');
      }
      if (typeof tool.run !== 'function') {
        throw new KernelError('tool_run_required');
      }
      // 参数模式顶层必须是对象。
      const schema = tool.parameters;
      if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
        throw new KernelError('tool_parameters_must_be_object');
      }
      if (schema.type !== 'object') {
        throw new KernelError('tool_parameters_type_not_object');
      }
      if (tools.has(tool.name)) {
        throw new KernelError('tool_already_registered');
      }
      let parameters;
      try {
        // 保存独立副本，避免插件后续修改对象时改变已登记的参数模式。
        parameters = structuredClone(schema);
      } catch {
        // `structuredClone` 无法复制函数和 Symbol；这类值无法通过 JSON 往返。
        throw new KernelError('tool_parameters_not_serializable');
      }
      // 只允许受控参数模式子集中的构造。
      assertSupportedSchema(parameters);
      // 模型清单只包含名称、说明和参数模式，不暴露插件附带字段。
      // 工具执行策略保存在 Kernel 中，供循环读取，不发给模型。
      // 固定披露工具不受模式筛选影响，其可用性由登记表决定。
      // 网络目标和命令文本的元数据保留在 Kernel 中，供权限判定使用解析后的地址和命令语法。
      const entry: RegisteredTool = {
        name: tool.name,
        description: tool.description,
        parameters,
        execution: tool.execution === 'parallel' ? 'parallel' : 'serial',
        disclosure: tool.disclosure === true,
        // 工具可声明重试是否会产生额外副作用；该声明只用于恢复说明，不参与权限判定。
        readOnly: tool.readOnly === true,
        targetArgument: typeof tool.targetArgument === 'string' ? tool.targetArgument : undefined,
        commandArgument: typeof tool.commandArgument === 'string' ? tool.commandArgument : undefined,
        // 工具可提供实际能力名称；MCP 工具用它传递 `mcp:<服务器>/<工具>` 身份。
        capability: typeof tool.capability === 'function' ? tool.capability : undefined,
        run: tool.run,
      };
      tools.set(tool.name, entry);
      return () => {
        // 只撤销本次登记，避免旧的卸载函数删除之后重新登记的同名工具。
        if (tools.get(tool.name) === entry) tools.delete(tool.name);
      };
    },

    // 生成模型清单前移除被拒绝的工具，并复制参数模式，避免调用方修改 Kernel 保存的数据。
    manifest() {
      return [...tools.values()]
        .filter((tool) => !isDenied(tool.name))
        .sort((left, right) => (left.name < right.name ? -1 : 1))
        .map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: structuredClone(tool.parameters),
        }));
    },

    // 预检模型返回的一批调用：检查工具是否已登记，并使用与 `call()` 相同的参数模式校验。
    // 预检不执行权限判定、不写入会话、不请求审批，也不运行工具。
    validateCall(name, args) {
      const tool = tools.get(name);
      if (!tool) return { code: 'tool_not_found', detail: `no tool named "${name}" is registered for this run` };
      const violations = validateArgs(tool.parameters, args);
      if (violations.length > 0 || !isPlainObject(args)) {
        return { code: 'tool_args_invalid', detail: violations.length > 0 ? violations.join('; ') : 'arguments must be an object' };
      }
      return {};
    },

    // 拒绝规则只能增加限制；撤销一条规则不会移除其他重叠规则。
    // 未登记工具名的拒绝规则保留在规则表中，但不会匹配本次运行中的工具。
    restrict(names: readonly string[]) {
      const denied = new Set(names);
      restrictions.push(denied);
      return () => {
        // 重复调用此函数只移除本次添加的规则，不影响其他 `restrict()` 规则。
        const index = restrictions.indexOf(denied);
        if (index >= 0) restrictions.splice(index, 1);
      };
    },

    // 每种失败都返回稳定错误码，供调用方分支处理。
    // 工具从 context 读取配置快照和日志接口；取消信号由循环或适配器传入。
    // 所有调用都经过权限判定，并将拒绝、失败和成功结果写入会话记录。
    async call(name: string, args?: unknown, options: { readonly callId?: string; readonly signal?: AbortSignal } = {}) {
      // `options.callId` 用于将工具结果关联到模型发起的调用。
      const entry: ToolEvent = { kind: 'tool', tool: name, callId: options.callId, args };
      const tool = tools.get(name);
      if (!tool) {
        // 即使工具未登记也要记录失败结果，确保本轮中的每个模型调用都有对应结果。
        // 否则下一次请求会包含没有结果的工具调用，并被模型服务拒绝。
        await fail(entry, new KernelError('tool_not_found', { detail: `no tool named "${name}" is registered for this run` }));
        return undefined;
      }
      if (isDenied(name)) {
        await record(entry, refusalOf('tool_denied', 'the tool is restricted for this run'));
        throw new KernelError('tool_denied');
      }
      // 先校验参数再运行权限判定。格式错误的调用无法成功，不能要求用户审批，也不应增加拒绝计数。
      const violations = validateArgs(tool.parameters, args);
      if (violations.length > 0) {
        await fail(entry, new KernelError('tool_args_invalid', { detail: violations.join('; ') }));
        return undefined;
      }
      if (!isPlainObject(args)) {
        await fail(entry, new KernelError('tool_args_invalid', { detail: 'arguments must be an object' }));
        return undefined;
      }
      // 只解析一次网络目标，并将同一结果传给权限判定和执行。
      // 避免 DNS 在审批和连接之间变化，导致实际连接地址与批准地址不同。
      const targetAddress = tool.targetArgument === undefined ? undefined : args[tool.targetArgument];
      const network = typeof targetAddress === 'string' ? await resolveTarget(targetAddress) : undefined;
      // 只选择一次命令解释器，并将同一后端用于语法解析、权限判定和执行。
      // 配置指定的解释器不可用时返回错误，不自动切换到另一种语法或程序。
      let shell;
      if (tool.commandArgument !== undefined && typeof args?.[tool.commandArgument] === 'string') {
        try {
          shell = resolveShell(config);
        } catch (error) {
          if (!(error instanceof KernelError)) throw error;
          await fail(entry, error);
          return undefined;
        }
        entry.shell = { kind: shell.kind, executable: shell.executable };
      }
      if (policy) {
        // 有能力元数据的工具按其声明的实际能力名称进行判定，例如 `mcp:<服务器>/<工具>`。
        const capability = tool.capability?.(args);
        const verdict = await policy.evaluate({ tool: name, input: args, target: network, shell, capability });
        // 会话记录保存权限判定结果，包括策略档位、匹配规则和审批答复。
        // 该结果仅供客户端查看，不加入模型上下文或检查点摘要。
        const recordedVerdict: Record<string, unknown> = {};
        for (const field of VERDICT_FIELDS) {
          if (verdict[field] !== undefined) recordedVerdict[field] = verdict[field];
        }
        entry.verdict = recordedVerdict;
        if (verdict.decision !== 'allow') {
          // 拒绝理由写入日志和会话记录；返回值只包含稳定错误码。
          const code = verdict.code ?? 'policy_denied';
          const reason = verdict.reason ?? '';
          logger.log(`tool ${name} is not allowed`, { tool: name, code, reason });
          await record(entry, refusalOf(code, reason));
          throw new KernelError(code);
        }
        // 在结果中保留解析出的命令分段，便于从记录中确认实际判定了哪些命令。
        if (entry.shell !== undefined && shell !== undefined) {
          if (verdict.segments !== undefined) entry.shell.segments = verdict.segments;
          // 只有判定结果确认命令是单条原生命令且首个程序可执行时，才附加退出码。
          // 未运行权限判定时无法确认命令形状，因此不附加退出码。
          shell = withNativeExitCode(shell, verdict.segments?.length === 1 ? verdict.segments[0] : undefined);
          if (shell.tail !== '') entry.shell.tail = shell.tail;
        }
      }
      let value;
      // 将执行耗时写入事件；计时从权限判定通过后开始，不包含等待审批的时间。
      // 使用单调时钟，避免系统时间调整影响耗时结果。
      const startedAt = process.hrtime.bigint();
      const timed = () => {
        entry.durationMs = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
      };
      try {
        value = await tool.run(args, { ...context, signal: options.signal, target: network, shell });
      } catch (error) {
        // 工具抛出未包装的错误时，转换为稳定错误码并将原始错误保存在 cause 中。
        // 错误说明会写入会话记录并提供给模型，避免单个工具异常中断整个循环。
        const failure = error instanceof KernelError
          ? error
          : new KernelError('tool_failed', { cause: error, detail: errorMessage(error) });
        // 失败和取消的调用也记录实际执行耗时；拒绝、参数错误和跳过的调用不会进入此处。
        timed();
        await fail(entry, failure);
      }
      timed();
      await record(entry, resultOf(value));
      return value;
    },
  };
  return kernel;
}
