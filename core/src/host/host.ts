// Host 进程的主体（D30）：会话、循环、工具与权限的真实状态都在这一侧，界面客户端只是协议的另一个端点。
// 加这一层不改动内核任何一行：要往外发的每一件事都有现成的注入口——
// 提供方与判定链由构造参数交进来，落盘的事件从会话记录那一条路上过一遍。
import { randomUUID } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { KernelError } from '../kernel/error.js';
import { createKernel, type Kernel } from '../kernel/kernel.js';
import { loadAssembly, type Assembly, type Plugin } from '../kernel/assembly.js';
import { loadExtensions, type ExtensionDiagnostic } from '../kernel/extensions.js';
import { applyMode, DEFAULT_MODE, loadMode, type ModeDirectories, type ModeFile } from '../kernel/modes.js';
import { readRegistry, registerWorkspace, setDefaultWorkspace, workspaceIdentity } from '../kernel/workspace.js';
import { historyPathOf, loadHistory, rememberHistory } from '../kernel/input-history.js';
import { parsePrefsJson, prefsPathOf, readPrefs, savePrefs } from '../kernel/desktop-prefs.js';
import { credentialStatus, deleteCredential, storeCredential } from '../kernel/credentials.js';
import { modelServices, modelSelection, resolveModel, type ModelSelection } from '../kernel/model-services.js';
import { createDecisionChain, isPolicyRule, type DecisionChain, type PolicyMode, type PolicyThresholds } from '../kernel/policy.js';
import { createPromptAssembly } from '../kernel/prompt.js';
import { BASE_SYSTEM_PROMPT } from '../kernel/base-prompt.js';
import { createSessionLog, type SessionLog } from '../session/session.js';
import type { SessionEvent, SessionHeader } from '../session/format.js';
import { chooseResumeMode, listSessions, sessionDirectory } from '../session/list.js';
import { adoptForSessionDirectory } from '../session/adopt.js';
import { searchSessions } from '../session/search.js';
import { branchSession } from '../session/branch.js';
import { listProjectFiles } from './paths.js';
import { branchSessionId, exportMarkdown, writeExport, type ExportRecord } from './export.js';
import { createCompaction } from '../session/compaction.js';
import { repairUnresolvedCalls } from '../session/repair.js';
import { foldLabel } from '../session/format.js';
import { SPILL_NAME, resultLimit } from '../kernel/result.js';
import { limitsOf } from '../capability/limits.js';
import { loadInstructions, DEFAULT_INSTRUCTION_BYTES } from '../capability/instructions.js';
import { SKILL_METADATA_BUDGET_BYTES, discoverSkills, formatSkillCatalog, skillDirectories } from '../kernel/skills.js';
import { discoverTemplates, expandTemplate, findTemplate, parseInvocation, templateDirectories } from '../kernel/templates.js';
import { createLoop, DEFAULT_LOOP_LIMITS, type LoopResult } from '../kernel/loop.js';
import { minimalPlugin } from '../tools/minimal.js';
import { networkPlugin } from '../tools/network.js';
import { createSkillPlugin } from '../tools/skill.js';
import { createMcpPlugin } from '../tools/mcp.js';
import { createSubagentPlugin } from '../tools/subagent.js';
import { createAskUserPlugin } from '../tools/ask-user.js';
import { createMcpRegistry, mcpServerConfigs, type McpRegistry } from '../capability/mcp.js';
import { createMessagesProvider } from '../model/messages.js';
import { createChatCompletionsProvider } from '../model/chat-completions.js';
import { discoverModels } from '../model/discovery.js';
import { apiRoot, DEFAULT_RETRY, type ProviderCapabilities, type RetryPolicy } from '../model/http.js';
import type { ModelProvider, ModelRequest, ProviderEvent } from '../kernel/loop.js';
import { createConnection, type Connection, type HostRequest } from './connection.js';
import { APPROVAL_METHOD, QUESTION_METHOD, isApproved, validateCall, type HostMethodParams } from './protocol.js';
import { type ConfigSnapshot } from '../kernel/config.js';
import type { LoggerBackend } from '../kernel/log.js';
import type { LoopLimits } from '../kernel/loop.js';
import type { LoadedLayers, createConfigStore } from '../kernel/config-store.js';
import type { SkillRegistry } from '../kernel/skills.js';
import type { TemplateRegistry } from '../kernel/templates.js';
import type { PolicyRule } from '../kernel/config-edit.js';
import type { ToolDefinition } from '../kernel/kernel.js';

interface HostConfigSnapshot extends ConfigSnapshot {
  readonly boundary?: string;
  readonly workspaceRoot?: string;
  readonly model?: Record<string, unknown>;
  readonly loop?: Record<string, unknown>;
  readonly limits?: Record<string, unknown>;
  readonly policy?: Record<string, unknown>;
  readonly prompt?: { readonly static?: string };
  readonly instructions?: Record<string, unknown> & { readonly maxBytes?: number; readonly current?: string };
}

interface HostProvider extends ModelProvider {
  readonly name: string;
  readonly model: string | null;
  readonly pending?: true;
  readonly capabilities?: ProviderCapabilities;
  withModel(model: string): HostProvider;
}

interface PolicyConfig {
  readonly mode?: PolicyMode;
  readonly rules?: PolicyRule[];
  readonly thresholds?: PolicyThresholds;
}

interface HostExtensions {
  readonly paths: string[];
  readonly ignored: ExtensionDiagnostic[];
  readonly installedDirectory?: string;
}

export interface EnvironmentSeed {
  readonly config: HostConfigSnapshot;
  readonly provider: HostProvider;
  readonly policy?: PolicyConfig;
  readonly modeName?: string;
  readonly modePaths?: ModeDirectories;
  readonly skillRegistry?: SkillRegistry;
  readonly templateRegistry?: TemplateRegistry;
  readonly extensions?: HostExtensions;
  readonly layers?: LoadedLayers;
  readonly store?: ReturnType<typeof createConfigStore>;
}

interface ProjectEnvironment extends Omit<EnvironmentSeed, 'layers' | 'store' | 'extensions' | 'config' | 'provider' | 'policy'> {
  readonly projectRoot: string;
  readonly config: RuntimeConfig;
  readonly directory: string;
  readonly layers: LoadedLayers;
  readonly store?: ReturnType<typeof createConfigStore>;
  readonly extensions: HostExtensions;
  readonly mcpConfigs: ReturnType<typeof mcpServerConfigs>;
  provider: HostProvider;
  policy?: PolicyConfig;
  generation?: SessionGeneration;
  pendingModel?: Record<string, unknown>;
  legacyAdopted?: boolean;
  adopting?: Promise<unknown>;
}

interface HostOptions {
  readonly config: HostConfigSnapshot;
  readonly provider: HostProvider;
  readonly plugins?: readonly Plugin<Kernel>[];
  readonly policy?: PolicyConfig;
  readonly logger?: LoggerBackend;
  readonly modeName?: string;
  readonly modePaths?: ModeDirectories;
  readonly skillRegistry?: SkillRegistry;
  readonly templateRegistry?: TemplateRegistry;
  readonly extensions?: HostExtensions;
  readonly loadEnvironment?: (projectRoot: string) => Promise<EnvironmentSeed>;
  readonly configStore?: ReturnType<typeof createConfigStore>;
  readonly configLayers?: LoadedLayers;
  readonly configStoreFor?: (projectRoot: string, layers: LoadedLayers) => ReturnType<typeof createConfigStore>;
  readonly deriveProvider?: (config: ConfigSnapshot) => HostProvider;
  readonly interactive?: boolean;
}

interface RuntimeConfig extends HostConfigSnapshot {
  readonly boundary: string;
  readonly workspaceRoot: string;
}

interface SessionGeneration {
  readonly provider: HostProvider;
  readonly model: Record<string, unknown>;
  readonly explicit?: boolean;
}

interface AdoptionResult {
  readonly applies: { sessionId: string; when: 'now' | 'round' }[];
  readonly failure?: { code: string; detail?: string };
}

interface ModeState {
  file: ModeFile | undefined;
  tools: string[];
  undo(): void;
}

interface HostSessionBase {
  readonly id: string;
  readonly session: SessionLog;
  readonly listeners: ((event: SessionEvent) => void)[];
  readonly asks: Set<() => void>;
  readonly environment: ProjectEnvironment;
  readonly mode: ModeState;
  generation: SessionGeneration;
  pendingGeneration?: SessionGeneration;
  pending?: ModeFile;
  running?: AbortController;
  operation?: Promise<unknown>;
  adopt(file: ModeFile): Promise<void>;
}

interface HostSessionState extends HostSessionBase {
  readonly chain: DecisionChain;
  readonly kernel: Kernel;
  readonly assembly: Assembly;
  readonly mcp: McpRegistry;
  readonly extensions: Awaited<ReturnType<typeof loadExtensions>>;
  readonly templates: TemplateRegistry;
  readonly loop: ReturnType<typeof createLoop>;
  readonly compaction: ReturnType<typeof createCompaction> | null;
}

export interface Host {
  handle(message: Pick<HostRequest, 'method' | 'params'>, connection: HostClientConnection): Promise<unknown>;
  release(): Promise<void>;
}

type HostClientConnection = Pick<Connection, 'notify' | 'request'>;

interface HostRequestWithParams {
  readonly method: string;
  readonly params: HostMethodParams;
}

interface ExtensionPromptFragment {
  readonly name: string;
  readonly text: string;
  readonly source: string;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new KernelError('protocol_args_invalid', { detail: `${field} must be a string` });
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, field);
}

function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number') throw new KernelError('protocol_args_invalid', { detail: `${field} must be a number` });
  return value;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new KernelError('protocol_args_invalid', { detail: `${field} must be a boolean` });
  return value;
}

function modelConfigOf(config: HostConfigSnapshot): Record<string, unknown> {
  return isRecord(config.model) ? config.model : {};
}

function modelSelectionOf(model: Record<string, unknown>): ModelSelection | undefined {
  return isRecord(model.selection) && typeof model.selection.provider === 'string' && typeof model.selection.model === 'string'
    ? { provider: model.selection.provider, model: model.selection.model }
    : undefined;
}

// 会话名字的上限：列表那一行还要放得下时间与条数，名字过长就该换一份短的（实现顺序第 75 步）。
export const SESSION_NAME_MAX = 120;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

function errorMessage(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  return typeof error.message === 'string' ? error.message : undefined;
}

function errorDetail(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  return typeof error.detail === 'string' ? error.detail : undefined;
}

function isToolDefinition(value: unknown): value is ToolDefinition {
  return isRecord(value)
    && typeof value.name === 'string'
    && typeof value.description === 'string'
    && isRecord(value.parameters)
    && typeof value.run === 'function';
}

function checkedToolDefinition(value: unknown): ToolDefinition {
  if (!isRecord(value) || typeof value.name !== 'string' || value.name === '') throw new KernelError('tool_name_required');
  if (typeof value.description !== 'string' || value.description === '') throw new KernelError('tool_description_required');
  if (typeof value.run !== 'function') throw new KernelError('tool_run_required');
  if (!isRecord(value.parameters)) throw new KernelError('tool_parameters_must_be_object');
  if (value.parameters.type !== 'object') throw new KernelError('tool_parameters_type_not_object');
  if (!isToolDefinition(value)) throw new KernelError('tool_name_required');
  return value;
}

function exportRecordOf(event: SessionEvent): ExportRecord | undefined {
  if (typeof event.kind !== 'string') return undefined;
  const record: {
    kind: string;
    seq?: number;
    raw?: string;
    text?: string;
    tool?: string;
    toolCalls?: { id: string; name: string; args?: Record<string, unknown> }[];
    result?: { content?: unknown; failed?: boolean; code?: string; spilled?: string };
    name?: string;
    layer?: string;
  } = { kind: event.kind };
  if (typeof event.seq === 'number') record.seq = event.seq;
  if (typeof event.raw === 'string') record.raw = event.raw;
  if (typeof event.text === 'string') record.text = event.text;
  if (typeof event.tool === 'string') record.tool = event.tool;
  if (typeof event.name === 'string') record.name = event.name;
  if (typeof event.layer === 'string') record.layer = event.layer;
  if (Array.isArray(event.toolCalls)) {
    record.toolCalls = event.toolCalls.flatMap((call) => isRecord(call) && typeof call.id === 'string' && typeof call.name === 'string'
      ? [{ id: call.id, name: call.name, ...(isRecord(call.args) ? { args: call.args } : {}) }]
      : []);
  }
  if (isRecord(event.result)) {
    record.result = {
      ...(Object.hasOwn(event.result, 'content') ? { content: event.result.content } : {}),
      ...(typeof event.result.failed === 'boolean' ? { failed: event.result.failed } : {}),
      ...(typeof event.result.code === 'string' ? { code: event.result.code } : {}),
      ...(typeof event.result.spilled === 'string' ? { spilled: event.result.spilled } : {}),
    };
  }
  return record;
}

// 重试边界也在配置里；形状在这里就查：非整数的 maxAttempts 让「第几次了」比不出大小，
// 每次传输失败就悄悄变成不重试，而看不出为什么不重试。
function retryOf(model: Record<string, unknown>): RetryPolicy {
  if (model.retry !== undefined && !isRecord(model.retry)) {
    throw new KernelError('host_retry_invalid', { detail: 'retry must be an object' });
  }
  const retry = { ...DEFAULT_RETRY, ...(isRecord(model.retry) ? model.retry : {}) };
  const positiveInteger = (value: unknown, key: 'maxAttempts' | 'baseDelayMs'): number => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      throw new KernelError('host_retry_invalid', { detail: `${key} must be an integer of at least 1` });
    }
    return value;
  };
  const boolean = (value: unknown, key: 'retry429' | 'retry5xx' | 'retryTransport'): boolean => {
    if (typeof value !== 'boolean') throw new KernelError('host_retry_invalid', { detail: `${key} must be a boolean` });
    return value;
  };
  return Object.freeze({
    maxAttempts: positiveInteger(retry.maxAttempts, 'maxAttempts'),
    baseDelayMs: positiveInteger(retry.baseDelayMs, 'baseDelayMs'),
    retry429: boolean(retry.retry429, 'retry429'),
    retry5xx: boolean(retry.retry5xx, 'retry5xx'),
    retryTransport: boolean(retry.retryTransport, 'retryTransport'),
  });
}

// 服务地址与模型名从配置快照读，凭据只在发请求时从环境变量读（D13）。
// 线上形状由 `model.api` 指名（D31）：不按地址猜，猜错的请求体只会换来一句说不出原因的 400。
// 能力项只能把该种形状声明的上限调低，那一条判据由各自的声明把守，这里只负责把配置送到它面前。
export function providerFromConfig(config: ConfigSnapshot): HostProvider {
  if (!isRecord(config.model)) throw new KernelError('host_model_config_missing', { detail: 'config.model.baseURL and config.model.model' });
  const model = resolveModel(config.model);
  const api = model.api;
  if (api !== 'messages' && api !== 'chat-completions') {
    throw new KernelError('provider_api_form_required', { detail: 'model.api must be "messages" or "chat-completions"' });
  }
  const apiKeyEnv = model.apiKeyEnv;
  if (apiKeyEnv !== undefined && typeof apiKeyEnv !== 'string') {
    throw new KernelError('provider_credential_missing', { detail: 'model.apiKeyEnv must be a string' });
  }
  const capabilities = model.capabilities;
  if (capabilities !== undefined && !isRecord(capabilities)) {
    throw new KernelError('provider_capability_invalid', { detail: 'model.capabilities must be a table' });
  }
  const options = {
    baseUrl: model.baseURL,
    model: model.model,
    ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
    ...(capabilities === undefined ? {} : { capabilities }),
    retry: retryOf(model),
  };
  if (api === 'messages') return createMessagesProvider(options);
  return createChatCompletionsProvider(options);
}

/** 缺那几格时宿主先立起来的这一枚：形状与真提供方一样，进程收得住请求，设置的「模型与端点」那一栏才写得进去（U59）。
 *  真要发一轮时把缺的字段原样说出去；写完那几格由 `adoptGeneration` 换上真那一份，这一枚就退场。 */
function pendingProvider(error: KernelError): HostProvider {
  const refuse = () => {
    throw error;
  };
  return { name: 'pending', model: null, pending: true, withModel: refuse, stream: async function* () { refuse(); } };
}

/** 宿主这一路用的提供方：不像命令行那样当场把进程带走。命令行与终端那两路仍旧当场报错——那是人坐在终端前，越早说越好。 */
export function hostProviderFromConfig(config: ConfigSnapshot): HostProvider {
  try {
    return providerFromConfig(config);
  } catch (error) {
    if (!['host_model_config_missing', 'provider_api_form_required', 'provider_base_url_required', 'provider_model_required', 'model_service_not_found', 'model_not_available'].includes(errorCode(error) ?? '')) throw error;
    if (!(error instanceof KernelError)) throw error;
    return pendingProvider(error);
  }
}

// 会话记录落在哪儿由 `core/src/session/list.js` 那一处说:同一件事在两处各写一次,列表与宿主就会读到两个目录(D73)。
// 循环的上限来自配置文件，形状在这里就查：只写其中一项时另一项照默认值补，
// 缺值传下去会让「迭代上限」变成 undefined，那一轮一次都不跑，报出来的码还说不出为什么。
function loopLimitsOf(config: HostConfigSnapshot): LoopLimits {
  const limits = { ...DEFAULT_LOOP_LIMITS, ...(isRecord(config.loop) ? config.loop : {}) };
  const positiveInteger = (value: unknown, key: 'iterations' | 'modelCalls'): number => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      throw new KernelError('host_loop_limits_invalid', { detail: `${key} must be an integer of at least 1` });
    }
    return value;
  };
  return {
    iterations: positiveInteger(limits.iterations, 'iterations'),
    modelCalls: positiveInteger(limits.modelCalls, 'modelCalls'),
  };
}

// 压缩的两条线（D75、U43）：窗口那一格必须写出来，两条比例才有意义——窗口是模型事实，不是策略参数。
// 没写就整条不启用（交回 undefined，宿主不给这一份会话挂压缩），写了但形状不对当场报出去，
// 因为一条 NaN 的线会让每一次请求都算不出「超没超」，看上去是压缩从不触发。
// 保留量还必须严格小于压力线，否则压完还是越线，而看不出来为什么一直在压（dsh 同一条约束）。
export function compactionLimitsOf(config: HostConfigSnapshot) {
  const limits = limitsOf(config);
  if (limits.contextTokens === undefined) return undefined;
  if (typeof limits.contextTokens !== 'number' || !Number.isFinite(limits.contextTokens) || limits.contextTokens <= 0) {
    throw new KernelError('host_compaction_limits_invalid', { detail: `contextTokens must be a positive number, got ${JSON.stringify(limits.contextTokens)}` });
  }
  const compactThresholdRatio = limits.compactThresholdRatio;
  const compactRetainRatio = limits.compactRetainRatio;
  if (typeof compactThresholdRatio !== 'number' || !(compactThresholdRatio > 0)) {
    throw new KernelError('host_compaction_limits_invalid', { detail: 'compactThresholdRatio must be a positive number' });
  }
  if (typeof compactRetainRatio !== 'number' || !(compactRetainRatio > 0)) {
    throw new KernelError('host_compaction_limits_invalid', { detail: 'compactRetainRatio must be a positive number' });
  }
  if (compactThresholdRatio > 1 || compactRetainRatio >= compactThresholdRatio) {
    throw new KernelError('host_compaction_limits_invalid', {
      detail: `compactRetainRatio (${compactRetainRatio}) must be below compactThresholdRatio (${compactThresholdRatio}), and the threshold must be at most 1`,
    });
  }
  return {
    contextTokens: limits.contextTokens,
    compactThresholdRatio,
    compactRetainRatio,
    resultBytes: resultLimit(config),
  };
}

// 流式接收期间把每一条事件抄一份送出去，交回给循环的那一份原样不动。
// 抄的是转手而不是重搭一份：提供方声明的能力、模型名与换模型的路径都要留着看得见，
// 而这一份会话的提供方会在整轮的边界上换一次（方案 7.3），抄成一份快照就会把后面那几轮固定在旧的端点上。
function observedProvider(provider: HostProvider, onDelta: (event: ProviderEvent) => void): HostProvider {
  return {
    get name() { return provider.name; },
    get model() { return provider.model; },
    get pending() { return provider.pending; },
    get capabilities() { return provider.capabilities; },
    withModel(model) { return observedProvider(provider.withModel(model), onDelta); },
    async *stream(request: ModelRequest, options?: { readonly signal?: AbortSignal }) {
      for await (const event of provider.stream(request, options)) {
        onDelta(event);
        yield event;
      }
    },
  };
}

// 「这一轮用哪一份提供方」落在会话自己那一格上：三处消费者（主循环、压缩、派生执行体）都只调用 `stream`，
// 所以这里交出的是一句转手——被调用时才去读当前那一份。换提供方因此只发生在整轮的边界上，
// 一轮之内不会出现只换了主循环而别处仍打旧端点的那种事（方案 7.3 第二行）。
function currentProvider(read: () => HostProvider): HostProvider {
  return {
    get name() { return read().name; },
    get model() { return read().model; },
    get pending() { return read().pending; },
    get capabilities() { return read().capabilities; },
    withModel(model) { return read().withModel(model); },
    stream(request, options) { return read().stream(request, options); },
  };
}

// 落盘的每一条都抄一份送出去：记录里的事与客户端看见的事同源，客户端看见的就是已经写下来的。
function observedSession(session: SessionLog, onEvent: (event: SessionEvent) => void): SessionLog {
  return {
    ...session,
    async append(event) {
      const stored = await session.append(event);
      onEvent(stored);
      return stored;
    },
  };
}

// 界面能看到的配置由这一处拼出来（实现顺序第 67 步）。每一格要先是字符串，不是字符串就不交。
// 地址只留协议、主机、端口与路径：用户名、密码、查询参数与片段常常装的就是凭据，不原样交回。
// 地址解析不出来时也不猜，交回没有这一格，界面上说「读不出来或没写」。
function shownText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function shownConfigOf(config: ConfigSnapshot) {
  const model = isRecord(config.model) ? config.model : {};
  let endpoint = shownText(model.baseURL);
  if (endpoint !== undefined) {
    try {
      const url = new URL(endpoint);
      endpoint = `${url.protocol}//${url.host}${url.pathname}`;
    } catch {
      endpoint = undefined;
    }
  }
  return {
    model: {
      api: shownText(model.api),
      baseURL: endpoint,
      model: shownText(model.model),
      apiKeyEnv: shownText(model.apiKeyEnv),
    },
  };
}

// modeName 与 modePaths 是一对：给了名字就要能给那三层目录，运行中换模式要用同一套查找（D41、D44）。
// 扩展来源由装载侧算好交进来（D68：项目层与本地层里写的路径不算）：paths 是要加载的文件，
// ignored 是那些被这条规则挡掉的路径，它们进日志而不是静默消失。
export function createHost({
  config, provider, plugins = [minimalPlugin, networkPlugin], policy, logger, modeName, modePaths, skillRegistry,
  templateRegistry, extensions = { paths: [], ignored: [] }, loadEnvironment, configStore, configLayers, configStoreFor,
  deriveProvider = providerFromConfig, interactive = false,
}: HostOptions): Host {
  // 一份项目环境：这个项目自己的配置快照、提供方、判定档位、模式目录、记录目录与那两格可写的配置文件（方案 3.1 与 3.2）。
  // 校验在装载这一刻做完：一条坏配置不该等到模型第一次调用才炸（D60）。
  // 边界是工具读写的位置，也是指令文件上溯的止点，两边都读它，缺一处就说缺一处。
  // 那两格可写的配置文件跟着环境走：设置那一栏说的是「哪一个项目的哪一层文件」，读与写都落在它自己身上（方案 3.2、审阅 F3）。
  // 使用者默认那一层是所有项目共用的那一份文件，项目共享与本机覆盖各是这一个项目自己的（D8 的层序）。
  // 存储由装载侧建（`configStoreFor`）：路径、文件名与用户目录的位置都在那一侧算，宿主只认层名、字段与读回的那一份版本（方案 7.2）。
  function prepareEnvironment(own: EnvironmentSeed): ProjectEnvironment {
    if (!Object.isFrozen(own.config)) throw new KernelError('host_config_must_be_frozen');
    if (typeof own.config.boundary !== 'string' || own.config.boundary === '') throw new KernelError('host_boundary_required');
    if (typeof own.provider?.stream !== 'function') throw new KernelError('host_provider_required');
    if (own.modeName !== undefined && own.modePaths === undefined) throw new KernelError('host_mode_paths_required');
    if (own.config.workspaceRoot !== undefined && typeof own.config.workspaceRoot !== 'string') {
      throw new KernelError('host_workspace_root_invalid');
    }
    const root = resolve(own.config.workspaceRoot ?? own.config.boundary);
    const runtimeConfig: RuntimeConfig = Object.freeze({ ...own.config, workspaceRoot: root, boundary: resolve(root, own.config.boundary) });
    const mcpConfig = isRecord(own.config.mcp) ? { mcp: { servers: own.config.mcp.servers } } : {};
    return {
      projectRoot: root,
      layers: own.layers ?? {},
      store: own.store ?? configStoreFor?.(root, own.layers ?? {}),
      config: runtimeConfig,
      provider: own.provider,
      policy: own.policy,
      modeName: own.modeName,
      modePaths: own.modePaths,
      skillRegistry: own.skillRegistry,
      templateRegistry: own.templateRegistry,
      extensions: own.extensions ?? { paths: [], ignored: [] },
      mcpConfigs: mcpServerConfigs(mcpConfig),
      directory: sessionDirectory(runtimeConfig),
    };
  }

  const defaultEnvironment = prepareEnvironment({
    config, provider, policy, modeName, modePaths, skillRegistry, templateRegistry, extensions,
    // 装载那一次读到的四层交进来，存储就在宿主这一侧按那一份建：来源那一格要说得出一条值现在由哪一层写着（方案 7.1）。
    // `configStore` 是启动那一份环境已有的存储，装载侧自己建好时用这一条（`ligule host` 走的是 `configLayers`）。
    layers: configLayers,
    store: configStore,
  });
  // 按项目根存一张表：同一份项目环境只装载一次，之后开这一项目的会话与列这一项目的记录都读它。
  const environments = new Map<string, ProjectEnvironment>([[defaultEnvironment.projectRoot, defaultEnvironment]]);

  // 项目根自己先分一次类：不存在、不是目录、读不动是三件事，各给一个稳定码（方案 2A）。
  // 记录目录不存在不在这一处管：一份正常的新项目还没有会话，那一条由 `listSessions` 交回空列表。
  async function classifyProjectRoot(asked: string): Promise<void> {
    try {
      if (!(await stat(asked)).isDirectory()) throw new KernelError('host_project_root_not_directory', { detail: asked });
    } catch (error) {
      if (error instanceof KernelError) throw error;
      const reason = errorCode(error);
      if (reason === 'ENOENT') throw new KernelError('host_project_root_missing', { detail: asked });
      // 路上有一段是文件：那一段不是目录，与「这一条路不存在」说的不是同一件事。
      if (reason === 'ENOTDIR') throw new KernelError('host_project_root_not_directory', { detail: asked });
      throw new KernelError('host_project_root_unreadable', { detail: `${asked}: ${reason ?? String(error)}` });
    }
  }

  // 取这一份项目环境。没指名就是宿主自己那一份；指名了别的项目而装载侧没给那条路就说清不支持，
  // 不悄悄用当前这一份项目环境去读另一项目的记录（方案 3.2：不能在另一个项目里悄悄继续）。
  async function environmentFor(projectRoot: unknown): Promise<ProjectEnvironment> {
    if (projectRoot === undefined || projectRoot === null || projectRoot === '') return defaultEnvironment;
    if (typeof projectRoot !== 'string') throw new KernelError('host_project_root_invalid');
    const asked = resolve(projectRoot);
    const askedIdentity = workspaceIdentity(projectRoot);
    // 缓存按装载出来的那一份根存（关会话时删的也是那一个名字），认的时候先比 resolve 之后的位置，再比归一后的身份：
    // 同一目录的两种写法共用一份环境，不会各存一份、关的时候漏一把（D110）。
    const known = [...environments.values()].find((each) => resolve(each.projectRoot) === asked || workspaceIdentity(each.projectRoot) === askedIdentity);
    if (known !== undefined) return known;
    if (loadEnvironment === undefined) throw new KernelError('host_project_root_unsupported', { detail: String(projectRoot).slice(0, 200) });
    await classifyProjectRoot(asked);
    const loaded = prepareEnvironment(await loadEnvironment(projectRoot));
    // 同一台机器上同一目录可以有多种写法（大小写、斜杠方向、尾部分隔符、链接）：写法不同不算身份不符。
    // 与 `core/src/session/list.ts` 筛记录头部用的是同一条规矩。
    if (resolve(loaded.projectRoot) !== asked && workspaceIdentity(loaded.projectRoot) !== askedIdentity) {
      throw new KernelError('host_project_root_mismatch', { detail: `asked for ${projectRoot}, the layers give ${loaded.projectRoot}` });
    }
    environments.set(loaded.projectRoot, loaded);
    return loaded;
  }

  // 真的在一具工作区里建了会话或接了会话，就把它登记一次：那份清单是持久的，侧栏列出来的只是它的一个读者（D110、方案 5.5.1）。
  // 记不上去要说出来：会话照开，缺口在日志里看得见，人的清单上不会静默少一个工作区。
  async function noteWorkspace(environment: ProjectEnvironment): Promise<void> {
    try {
      await registerWorkspace(environment.projectRoot);
    } catch (error) {
      logger?.log?.('workspace is not registered', {
        code: errorCode(error) ?? 'workspace_registry_failed',
        path: environment.projectRoot,
        reason: isRecord(error) ? String(error.detail ?? error.message ?? error) : String(error),
      });
    }
  }

  const sessions = new Map<string, HostSessionState>();
  const building = new Set<Promise<unknown>>();
  let closing: Promise<void> | undefined;

  function open(id: string): HostSessionState {
    const state = sessions.get(id);
    if (state === undefined) throw new KernelError('session_not_open', { detail: id });
    return state;
  }

  // 刚写进配置的那一个字段落在哪一份提供方上，由这一处算。写入侧交回的是落盘之后按层序重折出来的那一份值，
  // 不是刚写进去的那一个（方案 7.1、D8）：更上面那一层（项目共享、本机覆盖、命令行）还写着它时，
  // 这一笔改了文件却没改变任何会话在打的东西，那种写入要说成「当前运行没变」，不能报成采用了。
  // 基座用的是这一份项目环境此刻的那一份完整生成选择，不是装载那一次的快照：连着改两条字段，后一次盖不掉前一次。
  // 装载那一次的配置快照不动：正在跑的这一份环境用的就是它。`config.get` 读的是可写那两层文件的此刻内容（方案 3A），
  // 会话现在打的那一份从 `status.get` 读；两份读数各自说一件事，界面把它们分开摆。
  function adoptGeneration(env: ProjectEnvironment, key: string, effective: unknown): AdoptionResult {
    // 折不出来时也要把这半份记下：连着填的下一格接在它上面。退回装载那一次的快照就永远攒不齐——
    // 首启没有 `[model]` 时四格就是这么各填各的，提供方换不上、第一轮发不出去（U59 首启检查量到）。
    const base = env.generation ?? { provider: env.provider, model: env.pendingModel ?? modelConfigOf(env.config) };
    const model: Record<string, unknown> = { ...base.model, [key]: effective };
    let provider: HostProvider;
    try {
      provider = deriveProvider({ ...env.config, model });
    } catch (error) {
      env.pendingModel = model;
      return { applies: [], failure: { code: errorCode(error) ?? 'provider_rebuild_failed', detail: errorMessage(error) } };
    }
    env.pendingModel = undefined;
    // 折出来的那几格一格没变，就没有任何东西要采用：一条没改变的写入报成「采用了」，
    // 界面会说出没发生过的事（方案 7.3 的 `applies` 说的是真实生效边界）。
    const changed = new Set<string>([...Object.keys(base.model ?? {}), ...Object.keys(model)]);
    if ([...changed].every((field) => base.model?.[field] === model[field])) return { applies: [] };
    env.generation = { provider, model };
    // 这一格项目环境的提供方跟着走：新开的会话读的是它，于是继承的是最近一次真正生效的那一份（方案 7.2）。
    env.provider = provider;
    const applies: { sessionId: string; when: 'now' | 'round' }[] = [];
    let sessionFailure;
    for (const [id, state] of sessions) {
      if (state.environment !== env) continue;
      const ownGeneration = state.pendingGeneration ?? state.generation;
      if (ownGeneration.explicit === true) {
        if (key !== 'services' || modelSelectionOf(ownGeneration.model)?.provider === 'legacy') continue;
        const ownModel: Record<string, unknown> = { ...ownGeneration.model, services: effective };
        let ownProvider: HostProvider;
        try { ownProvider = deriveProvider({ ...env.config, model: ownModel }); }
        catch (error) { sessionFailure = { code: errorCode(error) ?? 'provider_rebuild_failed' }; continue; }
        const previous = resolveModel(ownGeneration.model);
        const next = resolveModel(ownModel);
        if (['api', 'baseURL', 'apiKeyEnv', 'model'].every((field) => previous[field] === next[field])) continue;
        const generation: SessionGeneration = { provider: ownProvider, model: ownModel, explicit: true };
        if (state.running === undefined) { state.generation = generation; state.pendingGeneration = undefined; applies.push({ sessionId: id, when: 'now' }); }
        else { state.pendingGeneration = generation; applies.push({ sessionId: id, when: 'round' }); }
        continue;
      }
      if (state.running === undefined) {
        state.generation = { provider, model };
        state.pendingGeneration = undefined;
        applies.push({ sessionId: id, when: 'now' });
      } else {
        state.pendingGeneration = { provider, model };
        applies.push({ sessionId: id, when: 'round' });
      }
    }
    return { applies, ...(sessionFailure === undefined ? {} : { failure: sessionFailure }) };
  }

  // 档位与规则表的生效边界是「下一次判定」（方案 7.3 第一行）：已经派发出去的那一次调用不受这一笔影响。
  // 配置里的默认改了才动会话，会话自己覆盖过档位的那一份不动（D101）；规则表整份替换，只有配置那一层写着它（D8）。
  function adoptPolicy(env: ProjectEnvironment, key: string, effective: unknown): AdoptionResult {
    if (key === 'rules') {
      if (JSON.stringify(env.policy?.rules ?? []) === JSON.stringify(effective ?? [])) return { applies: [] };
      if (!Array.isArray(effective) || !effective.every(isPolicyRule)) throw new KernelError('policy_rules_invalid');
      const applies: { sessionId: string; when: 'now' }[] = [];
      for (const [id, state] of sessions) {
        if (state.environment !== env) continue;
        state.chain.setRules(effective);
        applies.push({ sessionId: id, when: 'now' });
      }
      env.policy = { ...env.policy, rules: effective };
      return { applies };
    }
    if (env.policy?.mode === effective) return { applies: [] };
    if (effective !== 'ask' && effective !== 'auto' && effective !== 'never') throw new KernelError('policy_mode_unknown');
    const applies: { sessionId: string; when: 'now' }[] = [];
    for (const [id, state] of sessions) {
      if (state.environment !== env) continue;
      state.chain.setConfiguredMode(effective);
      applies.push({ sessionId: id, when: 'now' });
    }
    env.policy = { ...env.policy, mode: effective };
    return { applies };
  }

  // 这一格项目环境按层序折出来的那一份有效值：写完之后每一份都各折一次，因为大家共用使用者默认、
  // 各自有项目共享与本机覆盖那两层（D8、方案 3.2）。折不出来的环境（装载侧没给四层）不参与这一遍。
  async function effectiveOf(env: ProjectEnvironment, table: string, key: string): Promise<unknown> {
    if (env.store === undefined) return undefined;
    const fresh = await env.store.read();
    return key === 'rules' ? fresh.rules : fresh.values?.[table]?.[key];
  }

  // 一次写入影响哪一些项目环境由层名说：使用者默认那一层是所有已装载项目共用的那一份文件，
  // 本机覆盖只属于它自己那一个项目（方案 3.2、审阅 F3）。每一份环境用的是它自己折出来的那一份，
  // 被本项目那两层盖着的会话不会因为别人往低一层写就换掉在打的东西（方案 7.1、D8）。
  async function adoptWritten(
    env: ProjectEnvironment,
    layer: string,
    table: string,
    key: string,
    effective: unknown,
    changed: boolean,
  ): Promise<AdoptionResult> {
    const applies: { sessionId: string; when: 'now' | 'round' }[] = [];
    let failure: { code: string; detail?: string } | undefined;
    for (const target of layer === 'user' ? [...environments.values()] : [env]) {
      // 写入那一份环境：折前折后是同一份值时什么都不采用，那一格环境早就在打这一份（审阅 F1 的那一句「未改变当前运行」）。
      if (target === env && changed === false) continue;
      const own = target === env ? effective : await effectiveOf(target, table, key);
      if (own === undefined) continue;
      const answer = table === 'policy' ? adoptPolicy(target, key, own) : adoptGeneration(target, key, own);
      applies.push(...answer.applies);
      if (answer.failure !== undefined) failure = answer.failure;
    }
    return { applies, ...(failure === undefined ? {} : { failure }) };
  }

  // 一次装配的收尾：MCP 的子进程、扩展的监听、模板登记表与那一份记录锁，四样都只在这一份会话里存在过（D60、D37、D85）。
  // 记录本身一个字都不动：它是事实源，收掉的只是宿主里这一份活着的装配（I1）。
  async function retire(state: HostSessionState): Promise<void> {
    // 那一轮的失败不是收尾的失败：取消、提供方断流这些事实已经写在记录里了，这里只等它跑完（D11）。
    await state.operation?.catch(() => undefined);
    try {
      await state.mcp.close();
      state.extensions.dispose();
      state.assembly.dispose();
    } finally {
      // 收尾失败也要把这一份从表里摘出去并交回记录锁：留着它，界面再也收不掉，锁也一直占着（D85）。
      sessions.delete(state.id);
      await state.session.close();
    }
  }

  // 这一个项目根上最后一份会话收了，那份项目环境就退出这张表：下一次开这一根的会话重新读配置那几层（方案 3.1）。
  // 宿主自己那一份不退，它没有装载侧可回去重算。
  function evictEnvironment(environment: ProjectEnvironment): void {
    if (environment === defaultEnvironment) return;
    for (const other of sessions.values()) if (other.environment === environment) return;
    environments.delete(environment.projectRoot);
  }

  // 列清单与查记录扫的是同一格目录，两条路共用这一处判断（方案 3.2）。
  // 指名的项目还没装载过、装载侧又给不出那条路时，照当前这一份目录扫，过滤条件继续生效——
  // 扫一遍磁盘上的记录不逼出装载。
  // 这一份项目此刻的记录目录：第一次读之前先把旧位置（工作区目录下 `.ligule/sessions`）的记录一次性补齐到
  // 数据根会话区（D110）：补齐旧目录中的记录与附属文件，保留原件，
  // 同一环境共享进行中的整理；忙写者保留重试机会，读取或写入失败由调用者处理。
  async function scanDirectory(projectRoot: string): Promise<string> {
    const unloaded = projectRoot !== undefined && !environments.has(projectRoot) && loadEnvironment === undefined;
    const environment = unloaded ? defaultEnvironment : await environmentFor(projectRoot);
    if (environment.legacyAdopted !== true) {
      environment.adopting ??= (async () => {
        const report = await adoptForSessionDirectory(environment.config, environment.directory, environment.projectRoot);
        if (report !== null && (report.copied.length > 0 || report.conflicts.length > 0 || report.unknown.length > 0 || report.busy.length > 0)) {
          logger?.log?.('legacy session adoption', {
            projectRoot: environment.projectRoot,
            copied: report.copied,
            conflicts: report.conflicts,
            unknown: report.unknown,
            busy: report.busy,
          });
        }
        environment.legacyAdopted = report === null || report.busy.length === 0;
      })();
      try {
        await environment.adopting;
      } finally {
        environment.adopting = undefined;
      }
    }
    return environment.directory;
  }

  // 名字与归档标记读回的是记录里那几条 `label` 折出来的当前值：宿主不另存一份，两端看的是同一份事实（I5、方案 4.2）。
  async function labelOf(state: HostSessionState): Promise<{ sessionId: string; name: string; archived: boolean }> {
    return { sessionId: state.id, ...foldLabel(await state.session.read()) };
  }

  async function execute<T>(state: HostSessionState, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (state.running !== undefined) throw new KernelError('run_already_running', { detail: state.id });
    const controller = new AbortController();
    const settleAsks = (): void => { for (const settle of state.asks) settle(); };
    controller.signal.addEventListener('abort', settleAsks, { once: true });
    state.running = controller;
    const operation = (async (): Promise<T> => {
      try {
        return await action(controller.signal);
      } finally {
        controller.signal.removeEventListener('abort', settleAsks);
        state.running = undefined;
        if (state.pending !== undefined) {
          const next = state.pending;
          state.pending = undefined;
          await state.adopt(next);
        }
        // 生成参数在整轮收尾之后、下一条输入受理之前采用（方案 7.3 第二行）：这一轮里跑完的循环、压缩与派生体
        // 用的都是开始时那一份，跑到一半换端点会让一轮里发出过两种请求体，记录也就对不上一次完整的回答。
        if (state.pendingGeneration !== undefined) {
          state.generation = state.pendingGeneration;
          state.pendingGeneration = undefined;
        }
      }
    })();
    state.operation = operation;
    try {
      return await operation;
    } finally {
      state.operation = undefined;
    }
  }

  // `<主干 id>.sub-<序号>` 是派生支线的名字（D71）：它的主干在这条连接上打开着，这一条才读得到（D74）。
  function branchOwner(id: string): string | undefined {
    const matched = /^(.+)\.sub-(\d+)$/.exec(id);
    return matched !== null && sessions.has(matched[1]) ? matched[1] : undefined;
  }

  // 会话 id 那个串是从客户端来的，要拼成记录文件名：带目录分隔符时拼出的路径会走到记录目录外面。
  // 形状在这里查一次，打开、读取与支线三条路共用同一处，形状不对都报同一个码，不混进「找不到这份会话」。
  function assertSessionId(id: unknown): asserts id is string {
    if (typeof id !== 'string' || id === '' || id === '.' || id === '..'
      || id.includes('/') || id.includes('\\') || id.includes(':') || id.includes('\0')) {
      throw new KernelError('session_id_invalid', { detail: String(id).slice(0, 80) });
    }
  }

  function recordPathOf(id: string, env: ProjectEnvironment = defaultEnvironment): string {
    assertSessionId(id);
    return join(env.directory, `${id}.jsonl`);
  }

  // 溢出的那一份完整正文只在被读到的那一页上取：一次读一百条时不该把整份记录的结果文件都翻一遍。
  async function fillSpills(events: SessionEvent[], env: ProjectEnvironment): Promise<SessionEvent[]> {
    const base = await realpath(env.directory);
    const complete = [];
    for (const event of events) {
      const recordedResult = event.kind === 'tool' ? event.result : undefined;
      const result = isRecord(recordedResult) ? recordedResult : undefined;
      if (result?.spilled === undefined) { complete.push(event); continue; }
      if (typeof result.spilled !== 'string' || !SPILL_NAME.test(result.spilled)) {
        throw new KernelError('session_spill_reference_invalid', { detail: `event ${event.seq}` });
      }
      let content;
      try {
        const path = await realpath(join(env.directory, result.spilled));
        const local = relative(base, path);
        if (isAbsolute(local) || local === '..' || local.startsWith('../') || local.startsWith('..\\')) {
          throw new KernelError('session_spill_reference_invalid', { detail: `event ${event.seq}` });
        }
        const text = await readFile(path, 'utf8');
        content = result.spillFormat === 'json' ? JSON.parse(text) : text;
      } catch (cause) {
        if (errorCode(cause) === 'session_spill_reference_invalid') throw cause;
        throw new KernelError('session_spill_read_failed', { cause, detail: `${result.spilled}: ${errorMessage(cause) ?? String(cause)}` });
      }
      complete.push({ ...event, result: { ...result, content } });
    }
    return complete;
  }

  // 一页历史（实现顺序第 72 步，方案 4.1）：游标用的是记录里那一条事件自己的序号，它稳定且单调，
  // 所以往回翻只说「比这一页最早那一条更早」，翻页期间新事件只追加在末尾，旧页不重复也不漏。
  // 交回的 `endSeq` 是这一次读到的快照末端，`hasMore` 说这一页之前还有没有更早的。
  async function readForClient(
    session: SessionLog,
    sessionId: string,
    { fullResults, limit, before }: { fullResults?: boolean; limit?: number; before?: number } = {},
    env: ProjectEnvironment = defaultEnvironment,
  ) {
    const events = await session.read();
    const header = await session.header();
    // 游标归属那一格要说清它认不认得：不是这一份记录里的事件序号就是失效的游标，不静默当成第一页（E03）。
    if (before !== undefined && !events.some((event) => event.seq === before)) {
      throw new KernelError('session_cursor_invalid', { detail: `${sessionId} has no event ${before}` });
    }
    const page = (before === undefined ? events : events.filter((event) => event.seq < before)).slice(-(limit ?? events.length));
    return {
      sessionId,
      events: fullResults ? await fillSpills(page, env) : page,
      header: header ?? null,
      label: foldLabel(events),
      endSeq: page.at(-1)?.seq ?? null,
      hasMore: page.length > 0 && page[0].seq > 1,
    };
  }

  // 一次读记录：开着的那一份读它自己的内核，派生支线那一份读它在磁盘上的记录，两个入口不分两种形状。
  // 这一处不读别的磁盘目录：这一次动作的语义是「把我这一份会话的事实拿回来」，不是记录目录的浏览器；
  // 发现历史会话归 sessions，接上别的会话归 session.open。分页与溢出正文的参数原样交给 `readForClient`。
  async function readRecord(id: string, params: { fullResults?: boolean; limit?: number; before?: number }) {
    const state = sessions.get(id);
    if (state !== undefined) return await readForClient(state.session, id, params, state.environment);
    // 派生支线那一份不在这轮的内核里（跑完就把装配撤了，D71），界面读它用的是这同一次动作（D74）。
    assertSessionId(id);
    const owner = branchOwner(id);
    if (owner === undefined) throw new KernelError('session_not_open', { detail: id });
    const env = sessions.get(owner)?.environment ?? defaultEnvironment;
    try {
      await access(recordPathOf(id, env));
    } catch {
      throw new KernelError('session_not_found', { detail: id });
    }
    return await readForClient(createSessionLog({ directory: env.directory, id }), id, params, env);
  }

  // 一个会话一套内核、判定链与循环：判定链里的拒绝计数与档位按会话存活（D15、D17）。
  // ask 是这条会话的审批通道：客户端不在答复里说允许，就按不允许处理（D16 的询问走内核对外接口）。
  // 取消落在审批还没答复的时候要把这个问题收掉：答复不会再来了，而判定链在这里抛出，
  // 那一次调用就在记录里没人回答，之后每一轮都拼不出合法请求体（D11）。
  async function build(
    id: string,
    connection: HostClientConnection,
    recover = false,
    explicitMode?: string,
    env: ProjectEnvironment = defaultEnvironment,
    workspaceOrigin?: 'explicit' | 'default',
  ): Promise<HostSessionState> {
    // 这一份会话读的项目环境就是它所属那一个：下面这些名字从这里取，不再读宿主闭包里的那一份（方案 3.1）。
    const { config, provider, policy, modePaths, directory, mcpConfigs, extensions, skillRegistry, templateRegistry } = env;
    // 扩展收事件的那一条通道（D37）：刚落盘的这一条同时送给客户端与扩展，两边读的是同一份事实（I5）。
    const listeners: ((event: SessionEvent) => void)[] = [];
    const asks = new Set<() => void>();
    const modeState: ModeState = { file: undefined, tools: [], undo: () => {} };
    // 首行那份元信息在第一次落笔时才写，所以模式身份用一条取当前值的函数给：建会话的那一刻常常还没选过模式（D73）。
    const session = observedSession(createSessionLog({
      directory,
      id,
      meta: () => ({
        projectRoot: env.projectRoot,
        // 首行记下这一份会话落在哪一具工作区、是怎么落到那儿的（D110、方案 5.5.3）：
        // 界面分组读的是这两格，不是「路径等不等于现在的默认目录」。接回一份现存会话时没有这一格可写——那份记录的首行早写好了。
        workspace: workspaceIdentity(env.projectRoot),
        ...(workspaceOrigin === undefined ? {} : { workspaceOrigin }),
        mode: modeState.file === undefined ? undefined : { name: modeState.file.name, layer: modeState.file.layer },
      }),
    }), (event) => {
      connection.notify({ notify: 'event', sessionId: id, event });
      for (const listener of listeners) listener(event);
    });
    // 新开的一份会话继承的是这一份项目环境此刻的那一份完整生成选择（方案 7.2、D101 的「新会话按当前配置」）：
    // `config.model` 是装载那一次的快照，保存过模型字段之后它仍是旧的那一份，直接从它起会让状态与轮次记录分家。
    // 没写过任何东西时 `env.generation` 还不存在，那时用的就是装载那一次的快照与它算出来的提供方。
    const state: HostSessionBase = {
      id,
      session,
      listeners,
      asks,
      running: undefined,
      mode: modeState,
      pending: undefined,
      environment: env,
      generation: env.generation ?? { provider, model: modelConfigOf(config) },
      adopt: async () => {},
    };
    // 三处消费者读的都是这一句转手，它到调用时才去取 `state.generation` 里那一份（方案 7.3）。
    const live = currentProvider(() => state.generation.provider);
    await session.acquire();
    const cleanup = [];
    try {
    if (recover) {
      const previous = (await session.read()).filter((event) => event.kind === 'modelSelection').at(-1);
      if (previous !== undefined) {
        const selection = modelSelection({ provider: previous.provider, model: previous.model });
        const model = { ...(env.generation?.model ?? config.model), selection };
        state.generation = { provider: hostProviderFromConfig({ ...config, model }), model, explicit: true };
      }
    }
    const chain = createDecisionChain({
      ...policy,
      ask: async ({ tool, input, command, reason, shell, executable, policy, policySource, policyForced }) => {
        let settle = (): void => {};
        const cancelled = new Promise<boolean>((resolve) => {
          settle = () => resolve(false);
        });
        state.asks.add(settle);
        try {
          // 后端那两样只在真有一条命令要判时带上：没有命令文本的调用（读文件一类）不该在答复里多出一个空字段，
          // 否则同一条协议在按行转递的载体上与在进程内的那一种上读到的形状就不一样。
          // 那一份会话属于哪一项目录跟着请求一起交出去：客户端看着别的那一份时也要答得出这一条，答的是那一个项目里的这件事。
          // 档位与它的来源也一起交出去，读的是这一次判定自己那一条链：界面看着别的那一份会话时，解释这一条的不能是另一份的档位（审阅 C08）。
          const request = connection.request(APPROVAL_METHOD, {
            sessionId: id, projectRoot: env.projectRoot, tool, args: input, command, reason, policy, policySource, policyForced,
            ...(shell === undefined ? {} : { shell, executable }),
          });
          return await Promise.race([
            request.then(isApproved, (error) => {
              // 客户端把答复写成一次失败：这是它的问题，说出来，同时这一条按不允许处理，记录仍然完整。
              logger?.log?.(`approval failed for ${tool}`, { tool, code: errorCode(error), reason: errorMessage(error) });
              return false;
            }),
            cancelled,
          ]);
        } finally {
          state.asks.delete(settle);
        }
      },
    });
    const kernel = createKernel({ config, policy: chain, session, logger });
    // 技能注册表是一条系统事实（D46）：磁盘上有几份技能与模式选了哪几件无关（D45、D57）。
    // 装载侧可以交进已经查好的一份（测试与以后的重载），没交就在这里扫那四个目录。
    // 一份都没有时不改工具表也不加片段：多一件没人用的工具会改掉每次请求的前缀字节（D12）。
    const skills = skillRegistry ?? await discoverSkills(skillDirectories(env.projectRoot));
    for (const diagnostic of skills.diagnostics) {
      // 头部解不开与被同名压掉的那一份都不静默：装载侧留一条日志，提示词里那一段说明也带上计数（D49、D57）。
      logger?.log?.('skill is not loaded', { code: diagnostic.code, path: diagnostic.path, reason: diagnostic.detail });
    }
    // MCP 的两件固定工具按配置里有没有服务器登记（D52、D60）：一件都没配时这一格是空的，模型可见清单不涨。
    const mcp = createMcpRegistry(mcpConfigs);
    cleanup.push(() => mcp.close());
    const loaded = skills.skills.length === 0 ? plugins : [...plugins, createSkillPlugin(skills, () => mcp.servers())];
    // 提示模板也是装载侧扫出来的事实（D45）：两处目录，靠近仓库的那一份胜出。展开发生在这一侧，
    // 三个客户端因此不必各写一份替换规则（D54）。
    const templates = templateRegistry ?? await discoverTemplates(templateDirectories(env.projectRoot));
    for (const diagnostic of templates.diagnostics) {
      logger?.log?.('prompt template is not loaded', { code: diagnostic.code, path: diagnostic.path, reason: diagnostic.detail });
    }
    // 提示词的组装器先建好：扩展登记的那几段要进这一份，模式 `prompt` 那一格挑的也就是这几段（D35、D46）。
    // 配置四层都没写静态段时用随包的那一份基础提示（D102）：写了就用写的，标量整份替换。
    const prompt = createPromptAssembly({ static: config.prompt?.static ?? BASE_SYSTEM_PROMPT });
    // 派生执行体那一件工具（D71）：它拿到的插件是这一套减去 `subagent` 自己（一层是「谁在跑」读得出来的下界），
    // 判定链沿用这一条实例，静态前缀沿用这一份（同一串字节让端点的缓存对派生体也成立，D9）。
    // 提供方直接用未装饰的那一份：派生体的流式事件不往客户端转，那一段的进度在它自己的记录里（与 pi 的差别记在 D71）。
    const basePlugins = [...loaded, createMcpPlugin(mcp)];
    // 提问那一件只挂在父会话上（D107、方案 4.4）：派生支线没有能答复的人，那一条链走不到客户端的界面上。
    // 它不进上面那条判定链：审批问的是能不能做这一件操作，提问问的是这一件事该怎么办，两件事各问各的。
    // 客户端不声明支持交互时装都不装——命令行那一路问出去没人能答，模型看见一件用不了的工具比看不见更糟。
    const asked = interactive === false ? [] : [createAskUserPlugin({
      ask: async (questions) => {
        let settle = (): void => {};
        const cancelled = new Promise<'cancelled'>((resolve) => {
          settle = () => resolve('cancelled');
        });
        state.asks.add(settle);
        try {
          const outcome = await Promise.race([
            // 不设等待上限：等人回答不是失败。取消由这一发的 signal 那侧收，请求身份就是那一帧的 id。
            connection.request(QUESTION_METHOD, { sessionId: id, projectRoot: env.projectRoot, questions }),
            cancelled,
          ]);
          if (outcome === 'cancelled') {
            throw new KernelError('ask_user_cancelled', { detail: `${id}: the round was cancelled while the question waited for an answer` });
          }
          return outcome;
        } catch (error) {
          if (error instanceof KernelError) throw error;
          // 客户端把答复写成一次失败，或者那条通道本身断了：这里没有可以替人答的值，说清是哪一种。
          logger?.log?.('ask user request failed', { sessionId: id, code: errorCode(error), reason: errorMessage(error) ?? String(error) });
          throw new KernelError('ask_user_host_gone', { detail: `${id}: ${errorMessage(error) ?? String(error)}` });
        } finally {
          state.asks.delete(settle);
        }
      },
    })];
    const assembly = loadAssembly(kernel, [...basePlugins, ...asked, createSubagentPlugin({
      config,
      provider: live,
      chain,
      prompt,
      directory,
      sessionId: id,
      logger,
      plugins: basePlugins,
      modePaths,
      modeFile: () => state.mode.file,
      loopLimits: loopLimitsOf(config),
    })]);
    cleanup.push(() => assembly.dispose());
    // 项目指令文件那四层是装载侧交给提示词的一段（D10、第 9.5 步留下的那一半）：
    // 装载器自己的预算算在完整文本上，片段登记时按同一个数，两处不会各截一次。
    const maxBytes = config.instructions?.maxBytes ?? DEFAULT_INSTRUCTION_BYTES;
    const instructions = await loadInstructions({
      ...config.instructions,
      boundary: env.projectRoot,
      current: resolve(env.projectRoot, config.instructions?.current ?? '.'),
    });
    prompt.fragment({ name: 'instructions', anchor: 0, text: instructions.text, maxBytes });
    // 目录整份内联还是只留一句使用说明由预算判（D55）。有技能就有这一段：
    // 披露入口不在模式的选择范围里，模式藏不掉它（D63）。
    if (skills.skills.length > 0) {
      prompt.fragment({ name: 'skills', anchor: 1, text: formatSkillCatalog(skills), maxBytes: SKILL_METADATA_BUDGET_BYTES });
    }
    // 扩展的装载（D37、D68）：来源由装载侧算好交进来，这一处只管按次序 import、递出窄接口、留下反注册动作。
    // 窄接口只有那四件——注册工具、注册提示词片段、收事件、请求一次能力操作。这就是契约承诺的暴露面；
    // 它不是限制：进程内的模块技术上能做 Node 能做任何事，所以判定链、路径边界与参数校验对每一次调用照常生效（D37）。
    const fragments: ExtensionPromptFragment[] = [];
    for (const diagnostic of extensions.ignored) {
      logger?.log?.('extension source is not loaded', { code: diagnostic.code, path: diagnostic.path, reason: diagnostic.detail });
    }
    const installedExtensions = await loadExtensions(extensions.paths, {
      registerTool: (tool) => {
        return kernel.register(checkedToolDefinition(tool));
      },
      registerFragment: (fragment) => {
        // 两个扩展抢同一个片段名会让「这一格选了谁」读不出来：报出去，让后装的那一件自己改名字。
        if (fragments.some((entry) => entry.name === fragment.name)) throw new KernelError('extension_fragment_duplicate', { detail: fragment.name });
        fragments.push(fragment);
        return () => {
          const index = fragments.indexOf(fragment);
          if (index >= 0) fragments.splice(index, 1);
        };
      },
      addEventListener: (handler) => {
        state.listeners.push(handler);
        return () => {
          const index = state.listeners.indexOf(handler);
          if (index >= 0) state.listeners.splice(index, 1);
        };
      },
      // 请求一次能力操作走的就是内核那一条 call：判定链、会话记录与参数校验一件都少不了（D37、D11）。
      request: (tool, args) => kernel.call(tool, args),
    });
    cleanup.push(() => installedExtensions.dispose());
    for (const diagnostic of installedExtensions.diagnostics) {
      // 一件坏扩展不带走整次运行：它自己的登记全撤掉，别一条诊断，装载继续（D37 的承诺只到暴露面为止）。
      logger?.log?.('extension is not loaded', { code: diagnostic.code, path: diagnostic.path, reason: diagnostic.detail });
    }
    // 应用一份模式：先按新清单挑出提示词片段，叠加新工具限制并装好片段，最后才撤销旧限制。
    // 任一步校验或装配失败都保留旧模式，避免出错后工具清单意外变宽。
    // 记录里这一条是给「两条用户输入之间各自用的是哪一份清单」用的（I2、I5）；
    // 收紧只减不加，被藏起来的那几件仍然留在登记表里（I4）。
    state.adopt = async (file) => {
      const selected = file.prompt === '*'
        ? [...fragments]
        : file.prompt.map((name) => {
            const found = fragments.find((entry) => entry.name === name);
            if (found === undefined) {
              throw new KernelError('mode_prompt_unavailable', {
                detail: `${name} (mode ${file.name}; registered: ${fragments.map((entry) => entry.name).join(', ') || 'none'})`,
              });
            }
            return found;
          });
      // applyMode validates against the full registered tool set and adds its own restriction.
      // Install it while the old restriction is still active so a rejected mode cannot expose the full set.
      const applied = applyMode(kernel, file);
      const fragmentUndo: (() => void)[] = [];
      try {
        selected.forEach((fragment, index) => {
          fragmentUndo.push(prompt.fragment({
            name: `extension:${fragment.name}`,
            anchor: 2 + index,
            text: fragment.text,
            maxBytes: limitsOf(config).promptFragmentBytes,
          }));
        });
      } catch (error) {
        for (const remove of fragmentUndo.reverse()) remove();
        applied.undo();
        throw error;
      }
      state.mode.undo();
      const tools = kernel.manifest().map((entry) => entry.name);
      Object.assign(state.mode, {
        file,
        tools,
        undo: () => {
          for (const remove of fragmentUndo.slice().reverse()) remove();
          applied.undo();
        },
      });
      // 同一份清单不重复记：重新attach 到一份已有记录上不写东西（客户端接上来读不该改动事实源）。
      // 名字、来源或那一栏工具变了才记一条，让「这一条输入用的是哪一份」在记录里读得出来（I5）。
      const last = (await session.read()).filter((event) => event.kind === 'mode').at(-1);
      const lastTools = Array.isArray(last?.tools) && last.tools.every((tool): tool is string => typeof tool === 'string')
        ? last.tools
        : undefined;
      if (last === undefined || last.name !== file.name || last.layer !== file.layer || lastTools?.join(' ') !== tools.join(' ') || last.digest !== file.digest) {
        await session.append({ kind: 'mode', name: file.name, layer: file.layer, path: file.path, tools, digest: file.digest });
      }
    };
    // 模式选中的那一栏工具与那几段片段在装载之后才生效（D35、D44）：清单里写了本次没有登记的名字会在这里失败，
    // 而不是静默少一件。
    // 打开一份已有的记录时，先把没人回答的那几次派发补成规范的工具结果（D72）：这一条只在可写的恢复路径上做一次，
    // 读的那几处（`session.read`、界面、列表）报告缺口而不改盘。新建的那一份里没有待补的东西。
    if (recover) {
      const repaired = await repairUnresolvedCalls(session, { readOnly: new Set(kernel.readOnly()) });
      for (const event of repaired) logger?.log?.('unanswered tool call repaired', { sessionId: id, callId: event.callId, tool: event.tool });
    }
    // 用哪一份模式清单：客户端显式选了就用它；打开一份已有记录时取记录里最后生效的那一条并比它的摘要（D78）；
    // 两者都没有时保持装配时那一份。静默换成磁盘上现在这一份等于在别人没选过的范围里决定这一次能用什么，
    // 所以摘要变了要报 `resume_mode_changed`，由人显式选一次之后才继续。
    let wanted = explicitMode ?? modeName;
    if (explicitMode === undefined && recover && modePaths !== undefined) {
      const last = (await session.read()).filter((event) => event.kind === 'mode').at(-1);
      if (last !== undefined) {
        wanted = chooseResumeMode({
          recorded: { name: String(last.name), digest: typeof last.digest === 'string' ? last.digest : undefined },
          loaded: await loadMode(String(last.name), modePaths),
          fallback: modeName ?? DEFAULT_MODE,
        });
      }
    }
    if (wanted !== undefined) {
      if (modePaths === undefined) throw new KernelError('host_mode_paths_required');
      await state.adopt(await loadMode(wanted, modePaths));
    }
    // 压缩挂在这一份会话上（D75）：两条触发都在循环里问它，摘要那一次调用走未装饰的提供方——
    // 它的流式增量不该转给客户端，而它写完检查点就退出这一轮的事，事件日志一条都不动。
    // 配置没写 `limits.contextTokens` 时这一件是 null：窗口大小是模型事实，不猜，正常聊天照跑。
    const limits = compactionLimitsOf(config);
    const compaction = limits === undefined ? null : createCompaction({
      provider: live,
      session,
      directory,
      id,
      limits,
      logger,
      requestPrefix: () => ({ system: prompt.render(), tools: kernel.manifest() }),
    });
    const loop = createLoop({
      kernel,
      provider: observedProvider(live, (event) => connection.notify({ notify: 'delta', sessionId: id, event })),
      prompt,
      session,
      limits: loopLimitsOf(config),
      compaction,
      // 开轮时那一份生效参数的快照（D104）：读的是这一份会话现在的那几格，不是装载那一次的配置。
      // `apiKeyEnv` 交回的是变量名，不是变量的值（D13）。
      turnContext: () => {
        const model = resolveModel(state.generation.model ?? {});
        return {
          model: state.generation.provider.model ?? null,
          ...(typeof model.baseURL === 'string' ? { baseURL: model.baseURL } : {}),
          serviceId: model.serviceId,
          api: model.api ?? null,
          ...(model.apiKeyEnv === undefined ? {} : { apiKeyEnv: model.apiKeyEnv }),
          policy: chain.mode,
          policySource: chain.modeSource,
          ...(state.mode.file === undefined ? {} : { mode: state.mode.file.name, modeDigest: state.mode.file.digest }),
        };
      },
    });
    // 一份会话一份状态，审批的等待与正在跑的那一轮都记在这里。
    return Object.assign(state, { chain, kernel, assembly, extensions: installedExtensions, mcp, loop, templates, compaction });
    } catch (error) {
      try {
        for (const dispose of cleanup.reverse()) await dispose();
      } finally {
        await session.close();
      }
      throw error;
    }
  }

  function buildSession(
    id: string,
    connection: HostClientConnection,
    recover = false,
    mode?: string,
    env: ProjectEnvironment = defaultEnvironment,
    workspaceOrigin?: 'explicit' | 'default',
  ): Promise<{ sessionId: string }> {
    const pending = build(id, connection, recover, mode, env, workspaceOrigin).then((state) => {
      sessions.set(id, state);
      return { sessionId: id };
    });
    building.add(pending);
    return pending.finally(() => building.delete(pending));
  }

  const host: Host = {
    async handle(rawMessage: Pick<HostRequest, 'method' | 'params'>, connection: HostClientConnection): Promise<unknown> {
      if (closing !== undefined) throw new KernelError('host_closed');
      const rawParams = rawMessage.params;
      validateCall(rawMessage.method, rawParams);
      const message: HostRequestWithParams = { ...rawMessage, params: rawParams };
      const { sessionId = '', input = '' } = message.params;

      switch (message.method) {
        case 'session.create': {
          const id = randomUUID();
          const origin = message.params.workspaceOrigin;
          // 来源由客户端说：桌面可能指名一份目录而那一份正是它的默认工作区，指没指名推不出这一层意思（方案 5.5.3）。
          if (origin !== undefined && origin !== 'explicit' && origin !== 'default') {
            throw new KernelError('workspace_origin_unknown', { detail: `${origin}; the call takes 'explicit' or 'default', or nothing at all` });
          }
          const env = await environmentFor(message.params.projectRoot);
          const created = await buildSession(id, connection, false, undefined, env,
            origin ?? (message.params.projectRoot === undefined ? 'default' : 'explicit'));
          await noteWorkspace(env);
          return created;
        }
        case 'session.open': {
          // 已经在这具宿主里开着的会话读它自己那一份项目环境，与 `session.read` 同一个形状：
          // 不带 `projectRoot` 的接回（重读手里那一份、刚在别项目录里建好的那一份）按默认那一份去找记录，会报出假的 `session_not_found`。
          if (sessions.has(sessionId)) {
            // 已经在这具宿主里开着的会话，接回来是一次纯读：正在跑的那一轮不因这一次重装配、也不因这一次收线（审阅 F4）。
            // `run_already_running` 说的是「别在跑着的时候收掉这一份会话」那一条路（`session.close`），看着它不是那件事。
            // 指了模式就按 D41 那条边界走：空着的立刻采用，跑着的等自己那一轮收尾，这一处不越过去。
            const state = open(sessionId);
            if (message.params.mode !== undefined) {
              if (state.environment.modePaths === undefined) throw new KernelError('host_mode_paths_required');
              const requested = await loadMode(message.params.mode, state.environment.modePaths);
              if (state.running === undefined) await state.adopt(requested);
              else state.pending = requested;
            }
            return { sessionId };
          }
          // 指名了项目就取那一份项目环境：记录在哪个目录、工具在哪个目录读写，都由它说（方案 3.2）。
          const env = await environmentFor(message.params.projectRoot);
          // 派生支线那一份记录说的是父侧那一次派生做过什么，它不是一份等着接回来的会话：把它当主干接开，
          // 人就在一份没人负责的对账单上继续写（D71、D74）。读它仍然走 `session.read` 带那一条支线的编号。
          const branch = /^(.+)\.sub-(\d+)$/.exec(sessionId);
          if (branch !== null) {
            throw new KernelError('session_is_branch', { detail: `${sessionId} is a derived branch of ${branch[1]}; open the parent, or read that record with session.read` });
          }
          // 记录不在磁盘上就是没有这份会话，把它当新的一次空记录打开会让人以为恢复成功了。
          // 形状不对的 id 先报自己那个码，不混进「找不到这份会话」。
          const path = recordPathOf(sessionId, env);
          try {
            await access(path);
          } catch {
            throw new KernelError('session_not_found', { detail: sessionId });
          }
          // 接开还没装过的那一份：模式变更仍受当前轮次的边界约束。
          const opened = await buildSession(sessionId, connection, true, message.params.mode, env);
          await noteWorkspace(env);
          return opened;
        }
        case 'session.close': {
          const state = open(sessionId);
          // 正在跑的那一轮不由这一次动作收尾：界面要先发 `run.cancel`，这里不暗中打断（D11 那一轮的结果要有人写进记录）。
          if (state.running !== undefined) throw new KernelError('run_already_running', { detail: sessionId });
          await retire(state);
          evictEnvironment(state.environment);
          return { sessionId };
        }
        case 'session.label': {
          const state = open(sessionId);
          const { name, archived } = message.params;
          // 什么都不改的一次调用没有意义，说出来比写一条空事件好。
          if (name === undefined && archived === undefined) throw new KernelError('session_label_empty', { detail: sessionId });
          const trimmed = name?.trim() ?? '';
          // 名字由人写、给列表那一行看：控制字符会把排版弄坏，整条空白不算一个名字（方案 4.2）。
          if (name !== undefined && (trimmed === '' || trimmed.length > SESSION_NAME_MAX || /[\u0000-\u001f\u007f]/.test(name))) {
            throw new KernelError('session_name_invalid', { detail: `wanted 1-${SESSION_NAME_MAX} visible characters` });
          }
          await state.session.append({
            kind: 'label',
            ignorable: true,
            ...(name === undefined ? {} : { name: trimmed }),
            ...(archived === undefined ? {} : { archived }),
          });
          return await labelOf(state);
        }
        case 'session.branch': {
          // 分支不要求父会话停下来：复制的是记录里已经落下的那几条，父后来追加的不进这一份（方案 4.3）。
          // 那一份记录里没配上的派发留给分支第一次打开时补（D72）：补用的是分支自己的装配与那份记录锁，不在父侧动盘。
          const state = sessions.get(sessionId);
          assertSessionId(sessionId);
          const env = state?.environment ?? await environmentFor(message.params.projectRoot);
          return await branchSession(env.directory, sessionId, { at: message.params.at, projectRoot: env.projectRoot });
        }
        case 'sessions.list': {
          // 与 `ligule sessions` 走的是同一个扫描器（D73）：协议只是把它递到界面那一边，
          // 记录目录仍然只有宿主这一处开盘。
          // 不指名项目时说当前这一具：记录区是数据根里共用的一处，分得出项目的是首行那一格（D110、方案 5.5.4）。
          const { projectRoot, limit } = message.params;
          const scope = projectRoot ?? defaultEnvironment.projectRoot;
          return { sessions: await listSessions(await scanDirectory(scope), { projectRoot: scope, limit }) };
        }
        case 'sessions.search': {
          // 第七条只为界面多出来的方法：扫的还是那一处记录目录，与列表同一个开盘处（方案 4.2）。
          // 空白的查询在所有记录里都能对上，那一份结果没有意义，所以在这里就拒掉，不扫一遍磁盘再说。
          const { projectRoot, sessionId: scoped, limit } = message.params;
          const needle = requiredString(message.params.query, 'query').trim();
          if (needle === '') throw new KernelError('search_query_empty', { detail: 'a search query has to say what to look for' });
          // 指名一份就读那一份记录，溢出在另一个文件里的那一段也读：一次会话内的查找不该只看记录留着的那一头一尾。
          // 那一份会话开着就读它自己那一个项目的目录，与 `session.read` 同一处说法；形状不对先报自己那个码。
          if (scoped !== undefined) assertSessionId(scoped);
          const open = scoped === undefined ? undefined : sessions.get(scoped);
          const root = open !== undefined ? undefined : projectRoot ?? defaultEnvironment.projectRoot;
          const directory = open?.environment.directory ?? await scanDirectory(projectRoot ?? defaultEnvironment.projectRoot);
          return { hits: await searchSessions(directory, { query: needle, sessionId: scoped, projectRoot: root, limit }) };
        }
        case 'paths.list': {
          // 第九条只为界面多出来的方法：`@` 要的候选文件由宿主这一侧列出来，界面不开盘（方案 5.3、D81 边界一）。
          // 要哪一个项目就装载哪一个：这一处不猜边界，装载不了那条路的项目根报 `host_project_root_unsupported`（方案 3.2）。
          const { projectRoot, query, limit } = message.params;
          const env = await environmentFor(projectRoot);
          return await listProjectFiles(env.projectRoot, typeof query === 'string' ? query : '', limit);
        }
        case 'session.read': {
          // 交回的是记录本身：客户端晚到了也能把已经发生过的事画出来（I5）。
          // 历史那一页由 `limit` 与 `before` 说（方案 4.1）：支线那份读的是同一套分页，两个入口不分两种形状。
          return await readRecord(sessionId, message.params);
        }
        case 'session.export': {
          // 导出交给 Node 这一侧：读完整记录、补溢出正文、排版、落盘四件都在这里（方案 6A），界面只管选目的地。
          // 那一条路径是人在原生保存对话框里自己选的，不是模型工具的一次写出，因此不套项目边界；返回路径不等于写成。
          const record = await readRecord(sessionId, { fullResults: true });
          const header: SessionHeader | undefined = record.header ?? undefined;
          const exportRecords = record.events.flatMap((event) => {
            const item = exportRecordOf(event);
            return item === undefined ? [] : [item];
          });
          const main = exportMarkdown(exportRecords, {
            id: sessionId,
            projectRoot: header?.projectRoot,
            createdAt: header?.createdAt ?? null,
            // 还在跑的那一轮此刻没有末端：那份文件说到记录落到哪一条为止，后面写进来的不在里面（方案 6A）。
            unfinished: sessions.get(sessionId)?.running !== undefined,
          });
          // 支线那几份还是同一次读记录的动作（D74）：父记录里那条派生结果带着支线自己的 id。
          const branches = [];
          const skipped = [];
          for (const event of record.events) {
            const item = exportRecordOf(event);
            if (item === undefined) continue;
            const branchId = branchSessionId(item);
            if (branchId === undefined) continue;
            let branch;
            try {
              branch = await readRecord(branchId, { fullResults: true });
            } catch (error) {
              skipped.push({ id: branchId, code: errorCode(error) ?? 'session_read_failed' });
              continue;
            }
            const branchEvents = branch.events.flatMap((event) => {
              const exported = exportRecordOf(event);
              return exported === undefined ? [] : [exported];
            });
            branches.push({ id: branchId, text: exportMarkdown(branchEvents, { id: branchId, projectRoot: header?.projectRoot }) });
          }
          try {
            // 逐份结果从这一处交回：写成了哪几份、哪一份位置已经有人占着、哪一份写失败（审阅 F6）。
            // 那一份没写成说的是那一份，主文件落在哪里一起交回，不并成一句整体失败。
            const done = await writeExport(requiredString(message.params.path, 'path'), main, branches);
            return { written: done.written, skipped: [...skipped, ...done.skipped], failed: done.failed };
          } catch (cause) {
            if (cause instanceof KernelError) throw cause;
            // 那一个位置连目录都建不出来（路径落在一个文件下面、没有写权限）：这一句说的是整批没开始写。
            throw new KernelError('host_export_write_failed', { cause, detail: `${message.params.path}: ${errorMessage(cause) ?? String(cause)}` });
          }
        }
        case 'run.start': {
          const state = open(sessionId);
          return await execute(state, async (signal) => {
          // 模板展开排在这一轮开始之前（D54）：交进循环的是展开后的文本，记录里另外留着人打的那一行、
          // 参数、模板来源与内容摘要。查不到的那一行斜杠在这里就报出去，不带着没展开的原文进模型。
          const invocation = parseInvocation(input);
          let text = input;
          let user;
          if (invocation !== undefined) {
            const expanded = await expandTemplate(findTemplate(state.templates, invocation.command), invocation.arguments);
            text = expanded.text;
            user = { raw: input, arguments: expanded.arguments, source: expanded.source, digest: expanded.digest };
          }
          return await state.loop.run(text, { signal, user });
          });
        }
        case 'run.cancel': {
          const state = open(sessionId);
          if (state.running === undefined) throw new KernelError('run_not_running', { detail: sessionId });
          // 取消由循环那条边界接手：工具、提供方与循环看到的是同一次取消（D20）。
          state.running.abort();
          return { cancelled: true };
        }
        case 'policy.set': {
          // 档位是两件：配置那一份默认与这一份会话的覆盖（D101）。这里只动覆盖那一件，配置文件一个字不写。
          const state = open(sessionId);
          const mode = requiredString(message.params.mode, 'mode');
          if (mode === 'default') state.chain.resetMode();
          else if (mode === 'ask' || mode === 'auto' || mode === 'never') state.chain.setMode(mode);
          else throw new KernelError('policy_mode_unknown', { detail: 'mode must be ask, auto, never, or default' });
          return { policy: state.chain.mode, policySource: state.chain.modeSource, policyDefault: state.chain.configuredMode() };
        }
        case 'mode.set': {
          const state = open(sessionId);
          // 名字在这里就读成清单：坏清单在请求这一次就说出来，而不是等本轮结束应用时才炸（D44）。
          const modePaths = state.environment.modePaths;
          if (modePaths === undefined) throw new KernelError('host_mode_paths_required');
          const requested = await loadMode(requiredString(message.params.name, 'name'), modePaths);
          const current = state.mode.file;
          if (current !== undefined && current.name === requested.name && current.layer === requested.layer) {
            // 又选了一遍当前这一份：那是在撤回上一次待生效的请求，不写任何东西（D41）。
            state.pending = undefined;
          } else if (state.running === undefined) {
            await state.adopt(requested);
          } else {
            state.pending = requested;
          }
          return {
            mode: state.mode.file?.name ?? null,
            layer: state.mode.file?.layer ?? null,
            pending: state.pending?.name ?? null,
            tools: state.kernel.manifest().map((entry) => entry.name),
          };
        }
        case 'status.get': {
          const state = open(sessionId);
          return {
            sessionId,
            running: state.running !== undefined,
            // 交给模型的那一栏，不是登记表的全部（I2）：被模式藏起来的几件不在这儿。
            tools: state.kernel.manifest().map((entry) => entry.name),
            mode: state.mode.file?.name ?? null,
            modeLayer: state.mode.file?.layer ?? null,
            pendingMode: state.pending?.name ?? null,
            // 这一份会话现在打的是哪一份模型，以及等在它轮次边界上的那一份（方案 7.1 的三种读数、7.3 第二行）。
            // 读的是会话自己那一格而不是项目环境那一份：写完未采用与已采用在这两格里是分得开的。
            model: state.generation.provider.model ?? null,
            selectedModel: modelSelectionOf(state.generation.model)?.model ?? state.generation.provider.model ?? null,
            serviceId: modelSelectionOf(state.generation.model)?.provider ?? resolveModel(state.generation.model).serviceId ?? 'legacy',
            pendingServiceId: state.pendingGeneration === undefined ? null : modelSelectionOf(state.pendingGeneration.model)?.provider ?? null,
            pendingModel: state.pendingGeneration?.provider.model ?? null,
            // 判定档位与模式名是两样东西，字段也各写各的（D40：状态行上 `mode:` 与 `policy:`）。
            // 档位这一格现在有两件来源：配置那一份默认与会话自己的覆盖（D101），界面要说得出眼下生效的出自哪一件。
            policy: state.chain.mode,
            policySource: state.chain.modeSource,
            policyDefault: state.chain.configuredMode(),
            denials: state.chain.denials(),
            // 条数而不是内容：内容走 session.read。
            eventCount: (await state.session.read()).length,
            // 名字、说明与参数提示三样交出去，为的是界面上那一串候选：展开仍然只在这地方做一次（D24、D81）。
            templates: state.templates.templates.map(({ command, description, hint }) => ({ command, description, hint })),
            // 上下文压力那一格（D82）：窗口、压力线、当前投影的估算，加上记录里最后一次报回的用量。
            // 没写窗口时整格是 null，画面上那一段就不出现——那不是「还没压到」，是「线还没定」。
            usage: state.compaction === null ? null : await state.compaction.context(),
          };
        }
        case 'workspaces.list':
          // 那份登记才是持久清单，侧栏只是它的一个读者（方案 5.5.1）：界面收起、窗口关掉都不减一条。
          // 交回整份对象，`default` 那一格跟着走——界面要点出「默认」那一枚标签，得有身份值可比。
          return await readRegistry();
        case 'workspace.default.set': {
          // 空的是退掉默认，不需要那一条路真的存在；指了名的先分一次类，不存在、不是目录、读不动各给一个稳定码（方案 2A）。
          const directory = String(message.params.directory).trim();
          if (directory === '') return await setDefaultWorkspace(null);
          await classifyProjectRoot(resolve(directory));
          return await setDefaultWorkspace(directory, { name: message.params.name });
        }
        case 'history.read':
          // 那一份文件的位置由宿主定（与那份登记同一处）：界面说不出要到哪一份文件，也拿不到数据根里别的文件。
          return { entries: await loadHistory() };
        case 'history.append': {
          // 发出去的那一句进最前面，同句的旧那一份让位过来，尾上超预算的那几条丢掉；交回写完之后那一份清单，
          // 也就是锁内那一次读—改—写的结果：取锁之前自己拼的那一份不算上另一端刚落下的一句。
          return { entries: await rememberHistory(historyPathOf(), [String(message.params.text)]) };
        }
        case 'model.select': {
          const state = open(sessionId);
          const fresh = state.environment.store === undefined ? { model: state.environment.config.model ?? {} } : (await state.environment.store.read()).values;
          const selection = modelSelection({ provider: message.params.provider, model: message.params.model });
          const model = { ...(state.environment.config.model ?? {}), ...fresh.model, selection };
          const provider = deriveProvider({ ...state.environment.config, model });
          const generation = { model, provider, explicit: true };
          await state.session.append({ kind: 'modelSelection', ignorable: true, provider: selection.provider, model: selection.model });
          if (state.running === undefined) state.generation = generation;
          else state.pendingGeneration = generation;
          return { model: provider.model, serviceId: selection.provider, when: state.running === undefined ? 'now' : 'round' };
        }
        case 'models.discover': {
          // 已保存的凭据只能发往它所绑定的服务。新建服务尚未保存时，只有显式提供的临时 Key 可以预览。
          if (message.params.temporaryKey === undefined) {
            const env = await environmentFor(message.params.projectRoot);
            // 项目共享配置可以引用任意环境变量名，不能据此授予系统凭据读取权。
            // 只信任用户级配置中的服务/旧模型端点绑定；项目及本机/flag 覆盖只能使用显式 temporaryKey。
            if (env.store !== undefined) await env.store.read(); // 刷新用户配置层（不使用合并后的 values）。
            const trusted = env.layers.user?.model;
            const model = isRecord(trusted) ? trusted : {};
            const requestedURL = new URL(apiRoot(message.params.baseURL)).href;
            const matches = (api: unknown, baseURL: unknown, reference: unknown) =>
              api === message.params.api && reference === message.params.reference &&
              typeof baseURL === 'string' && new URL(apiRoot(baseURL)).href === requestedURL;
            const saved = modelServices(model.services).some((service) => matches(service.api, service.baseURL, service.apiKeyEnv));
            const legacy = typeof model.model === 'string' &&
              matches(model.api, model.baseURL, model.apiKeyEnv ?? 'LIGULE_API_KEY');
            if (!saved && !legacy) throw new KernelError('model_discovery_credential_unbound');
          }
          return { models: await discoverModels({
            api: message.params.api, baseURL: message.params.baseURL,
            reference: message.params.reference, temporaryKey: message.params.temporaryKey,
          }) };
        }
        case 'credentials.status':
          return await credentialStatus(requiredString(message.params.reference, 'reference'));
        case 'credentials.set':
          await storeCredential(requiredString(message.params.reference, 'reference'), requiredString(message.params.value, 'value'));
          return await credentialStatus(requiredString(message.params.reference, 'reference'));
        case 'credentials.delete':
          return { deleted: await deleteCredential(requiredString(message.params.reference, 'reference')) };
        case 'prefs.read':
          // 桌面草稿与界面偏好那一份文档的位置也由宿主定（与输入历史同一处，方案 5.5.2）。
          return await readPrefs();
        case 'prefs.write': {
          const value = parsePrefsJson(String(message.params.json));
          return await savePrefs(prefsPathOf(), value, { version: requiredString(message.params.version, 'version') });
        }
        case 'config.get': {
          // 边界在「结果由固定那几格拼出来」这一句上，不在参数校验上：子集校验放过模式里没声明的键（D14）。
          // 白名单的理由：配置合并除 `__proto__` 之外接受任何键，项目层那一份可能出自别人写的仓库（D8）。
          // 凭据只走环境变量是一条约定，不是拦阻（D13、D60），所以交出整份快照证明不了帧里没有别的东西。
          // 值、来源与各层文件的版本出自同一遍读取（方案 3A）：界面上那三样说的是同一时刻的那一份文件。
          // 版本是写的时候要比对的那一份：光有值比不出「别人也改过」。
          // 指名了项目就读那一份项目的两层文件：设置那一栏说的是「哪一个项目的哪一层」（方案 3.2、审阅 F3）。
          // 帧里不出现那一个根：界面上选的是哪一份项目由它自己带着，宿主把位置说进帧里是另一条规矩不允许的（D13）。
          const env = await environmentFor(message.params.projectRoot);
          if (env.store === undefined) return {
            ...shownConfigOf(env.config),
            services: modelServices(env.config.model?.services),
            selection: env.config.model?.selection === undefined ? null : modelSelection(env.config.model.selection),
            layers: [], sources: {},
          };
          const { layers, sources, values, rules, rulesSource } = await env.store.read();
          return {
            ...shownConfigOf(values),
            services: modelServices(values.model?.services),
            selection: values.model?.selection === undefined ? null : modelSelection(values.model.selection),
            // 配置里写着的默认档：这一格说的是文件里现在那一份，正在生效的那一份从 `status.get` 读（D40、D101）。
            policyMode: values.policy.mode,
            layers,
            sources,
            rules,
            rulesSource,
          };
        }
        case 'config.set': {
          // 字段表、值的形状与「哪一层落在哪一个文件」都由那一格配置里的写入侧持有：这一处只转发，
          // 界面说不出文件路径，也说不出白名单之外的键（方案 7.2）。
          if (defaultEnvironment.store === undefined) throw new KernelError('config_write_unsupported');
          const { value, op, index, ruleTool, ruleDecision, ruleMatch, ruleReason } = message.params;
          const field = requiredString(message.params.field, 'field');
          const layer = requiredString(message.params.layer, 'layer');
          const version = requiredString(message.params.version, 'version');
          // 规则的四格在协议表里各是一个字符串：校验器认形状，宿主这一侧 `checkedRule` 认内容（D100）。
          const given = { tool: ruleTool, decision: ruleDecision, match: ruleMatch, reason: ruleReason };
          const rule = Object.values(given).every((item) => item === undefined) ? undefined : given;
          const env = await environmentFor(message.params.projectRoot);
          if (env.store === undefined) throw new KernelError('config_write_unsupported');
          if (field === 'model.selection') {
            const fresh = await env.store.read();
            deriveProvider({ ...env.config, model: { ...env.config.model, ...fresh.values.model, selection: modelSelection(value) } });
          }
          if (field === 'model.services') {
            const fresh = await env.store.read();
            if (fresh.values.model?.selection !== undefined) resolveModel({ ...fresh.values.model, services: modelServices(value) });
          }
          const { key, table, shadowed, shadowedBy, changed, effective, layers, ...saved } = await env.store.write({ layer, field, value, version, op, index, rule });
          // 白名单里那几条模型字段都是提供方要读的那几格，所以写完就问一句：哪一份会话现在就换，哪一份等自己那一轮的边界。
          // 采用的依据是落盘之后按层序重折出来的那一份有效值，不是刚写进去的那一个（方案 7.1、D8）：
          // 更上面那一层还写着它时，前后折出来是同一份，会话一份都不动、`applies` 交回空，界面由 `shadowed` 与 `shadowedBy` 说出是哪一层盖着它。
          // 那一条值本来就是命令行 `--config` 写着的话，也在这一条里：`shadowedBy` 说的是 `flag`。
          // 档位与规则表是另一类：接受之后立即作用于后续判定（方案 7.3 第一行），不等轮次边界。
          const adoption = await adoptWritten(env, layer, table, key, effective, changed);
          return {
            ...saved,
            shadowed,
            ...(shadowedBy === undefined ? {} : { shadowedBy }),
            changed,
            ...adoption,
            ...(key === 'rules' ? { rules: effective } : {}),
            layers,
          };
        }
        case 'session.compact': {
          const state = open(sessionId);
          // 压的是下一次请求要用的那一份投影，正在跑的这一轮的上下文已经在路上：这时候压改变不了它（D83）。
          if (state.running !== undefined) throw new KernelError('compact_turn_running', { detail: sessionId });
          if (state.compaction === null) {
            throw new KernelError('compact_window_unset', { detail: 'limits.contextTokens is not written, so there is no window to compact against' });
          }
          return await execute(state, async (signal) => {
          const compaction = state.compaction;
          if (compaction === null) throw new KernelError('compact_window_unset');
          const done = await compaction.compactNow(signal);
          // 压不动只可能是那一种：留下保留预算之后一段里找不到能切的边界。
          if (done === null) throw new KernelError('compact_nothing_to_cut', { detail: sessionId });
          return { sessionId, ...done };
          });
        }
        default:
          // validateCall 已经拦住了不认识的方法，走到这里说明分发表与协议表不是同一份。
          throw new KernelError('protocol_method_unhandled', { detail: message.method });
      }
    },

    // 一条连接断开时把它还占着的那一轮停下来，然后按装配清单的逆序把插件撤掉（I7）。
    release(): Promise<void> {
      if (closing !== undefined) return closing;
      const states = [...sessions.values()];
      for (const state of states) {
        if (state.running !== undefined) state.running.abort();
      }
      closing = (async () => {
        const failures = [];
        await Promise.allSettled([...building]);
        const opened = [...sessions.values()];
        for (const state of opened) state.running?.abort();
        const retired = await Promise.allSettled(opened.map((state) => retire(state)));
        for (const result of retired) if (result.status === 'rejected') failures.push(result.reason);
        sessions.clear();
        if (failures.length > 0) throw new AggregateError(failures, 'host_release_failed');
      })();
      return closing;
    },
  };
  return host;
}

// 标准输入输出那一种载体的入口：Electron Main 或脚本启动进程，两端各读写一行 JSON。
export function serveHost({ input = process.stdin, output = process.stdout, config, ...rest }: HostOptions & { input?: Readable; output?: Writable }): Host {
  const host = createHost({ config, ...rest });
  const connection = createConnection({
    input,
    output,
    // 一行读不出来的东西不是任何一次调用的失败，它是这条连接的问题：说清楚，让客户端自己决定要不要重开进程。
    onFault: (error) => connection.notify({ notify: 'fault', code: errorCode(error), detail: errorDetail(error) }),
    onClose: () => {
      void host.release().catch((error: unknown) => rest.logger?.error?.('host release failed', { code: errorCode(error), detail: errorMessage(error) }));
    },
  });
  connection.onRequest((message) => host.handle(message, connection));
  return host;
}
