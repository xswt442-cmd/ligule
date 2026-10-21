// Host 管理会话、Agent 循环、工具和策略状态；客户端通过协议与它通信。
// 模型提供方与策略由外部注入，会话事件通过会话记录接口持久化。
import { randomUUID } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { KernelError } from '../kernel/error.js';
import {
  createOutputSchemaContract, DELEGATION_RESULT_TOOL, MAX_DELEGATION_SCHEMA_BYTES, outputSchemaInstructions,
  registerDelegationResultTool, type DelegationSpec, type RunValidation,
} from '../delegation.js';
import {
  assertDelegationMcpServer, assertDelegationMcpTool, assertDelegationPermission, assertDelegationPolicy, createDelegationGrant, delegationPathOf,
  listDelegationGrants, recordDelegationEvent, requireDelegationGrant, revokeDelegationGrant,
  type CreateDelegationGrantInput, type DelegationGrant,
} from './agent-control.js';
import { listMcpTrust, mcpServerTrust, mcpTrustPathOf, setMcpServerTrust, type McpTrustScope } from './mcp-trust.js';
import { createPermissionContext, DEFAULT_PERMISSION_CONTEXT, permissionDenial, type PermissionContext, type PermissionContextOptions, type PermissionNetwork, type PermissionProfile } from '../kernel/permission.js';
import { createKernel, type Kernel } from '../kernel/kernel.js';
import { loadAssembly, type Assembly, type Plugin } from '../kernel/assembly.js';
import { loadExtensions, type ExtensionDiagnostic } from '../kernel/extensions.js';
import {
  applyModeToPrompt, DEFAULT_MODE, listModes, loadMode, resolveModeSelection,
  type ModeDirectories, type ModeFile,
} from '../kernel/modes.js';
import { readRegistry, registerWorkspace, setDefaultWorkspace, unregisterWorkspace, workspaceIdentity } from '../kernel/workspace.js';
import { isTrusted, setTrusted } from '../kernel/workspace-trust.js';
import { historyPathOf, loadHistory, rememberHistory } from '../kernel/input-history.js';
import { parsePrefsJson, prefsPathOf, readPrefs, savePrefs } from '../kernel/desktop-prefs.js';
import { credentialStatus, deleteCredential, storeCredential } from '../kernel/credentials.js';
import { modelServices, modelSelection, resolveModel, type ModelSelection, type ModelService } from '../kernel/model-services.js';
import { createDecisionChain, isPolicyRule, type DecisionChain, type PolicyMode, type PolicyState, type PolicyThresholds } from '../kernel/policy.js';
import { createPromptAssembly } from '../kernel/prompt.js';
import { BASE_SYSTEM_PROMPT } from '../kernel/base-prompt.js';
import { createSessionLog, type SessionLog } from '../session/session.js';
import type { SessionEvent, SessionHeader } from '../session/format.js';
import { chooseResumeMode, listWorkspaceSessions, sessionDirectories, sessionDirectory } from '../session/list.js';
import { adoptForSessionDirectory } from '../session/adopt.js';
import { searchSessionDirectories } from '../session/search.js';
import { branchSession } from '../session/branch.js';
import { listProjectFiles } from './paths.js';
import { branchSessionId, exportMarkdown, writeExport, type ExportRecord } from './export.js';
import { createCompaction } from '../session/compaction.js';
import { sessionWriterActive } from '../session/lock.js';
import { requestAgentControl, type AgentControlRequest } from './agent-control-runtime.js';
import { usageEvent } from '../session/usage.js';
import { repairUnresolvedCalls } from '../session/repair.js';
import { foldLabel } from '../session/format.js';
import { SPILL_NAME, resultLimit } from '../kernel/result.js';
import { limitsOf } from '../capability/limits.js';
import { createManagedProcessRegistry, managedProcessPlugin, type ManagedProcessRegistry } from '../capability/managed-process.js';
import { loadInstructions, DEFAULT_INSTRUCTION_BYTES } from '../capability/instructions.js';
import { SKILL_METADATA_BUDGET_BYTES, discoverSkills, formatSkillCatalog, skillDirectories } from '../kernel/skills.js';
import { discoverTemplates, expandTemplate, findTemplate, parseInvocation, templateDirectories } from '../kernel/templates.js';
import { createLoop, DEFAULT_LOOP_LIMITS, type LoopCompaction, type LoopProgressEvent, type LoopProgressPhase, type LoopResult } from '../kernel/loop.js';
import { minimalPlugin } from '../tools/minimal.js';
import { networkPlugin } from '../tools/network.js';
import { createSkillPlugin } from '../tools/skill.js';
import { createMcpPlugin, type McpAuthorization } from '../tools/mcp.js';
import { createSubagentPlugin } from '../tools/subagent.js';
import { createAskUserPlugin } from '../tools/ask-user.js';
import { createMcpRegistry, mcpServerConfigs, type McpRegistry } from '../capability/mcp.js';
import { discoverModels } from '../model/discovery.js';
import { apiRoot } from '../model/http.js';
import { thinkingCapabilityOf } from '../model/thinking.js';
import type { ModelRequest, ProviderEvent } from '../kernel/loop.js';
import { createConnection, type Connection, type HostRequest } from './connection.js';
import { APPROVAL_METHOD, QUESTION_METHOD, isApproved, validateCall, type HostMethodParams } from './protocol.js';
import { createConfig, mergePolicyRules, type ConfigSnapshot } from '../kernel/config.js';
import { loadConfigLayers } from '../kernel/config-file.js';
import type { LoggerBackend } from '../kernel/log.js';
import type { LoopLimits } from '../kernel/loop.js';
import type { LoadedLayers, createConfigStore } from '../kernel/config-store.js';
import type { SkillRegistry } from '../kernel/skills.js';
import type { TemplateRegistry } from '../kernel/templates.js';
import type { PolicyRule } from '../kernel/config-edit.js';
import type { ToolDefinition } from '../kernel/kernel.js';
import { adoptSessionMode, type SessionModeState } from './session-mode.js';
import { providerFromConfig, hostProviderFromConfig, type HostGenerationOptions, type HostProvider } from './provider.js';
export { providerFromConfig, hostProviderFromConfig } from './provider.js';

interface HostConfigSnapshot extends ConfigSnapshot {
  readonly boundary?: string;
  readonly workspaceRoot?: string;
  readonly exec?: { readonly shell?: unknown };
  readonly model?: Record<string, unknown>;
  readonly loop?: Record<string, unknown>;
  readonly limits?: Record<string, unknown>;
  readonly policy?: Record<string, unknown>;
  readonly prompt?: { readonly static?: string };
  readonly instructions?: Record<string, unknown> & { readonly maxBytes?: number; readonly current?: string };
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
  readonly deriveProvider?: (config: ConfigSnapshot, generation?: HostGenerationOptions) => HostProvider;
  readonly interactive?: boolean;
  readonly permission?: PermissionContext;
  readonly permissionControl?: boolean;
  readonly agentControl?: {
    readonly grantId: string;
    readonly storePath: string;
    readonly operator: boolean;
    validate(): Promise<DelegationGrant>;
  };
}

interface RuntimeConfig extends HostConfigSnapshot {
  readonly boundary: string;
  readonly workspaceRoot: string;
}

interface SessionGeneration {
  readonly provider: HostProvider;
  readonly model: Record<string, unknown>;
  readonly explicit?: boolean;
  readonly options: HostGenerationOptions;
}

interface InitialSessionSettings {
  readonly mode?: string;
  readonly policy?: Exclude<PolicyMode, 'default'>;
  readonly permission?: {
    readonly context: PermissionContext;
    readonly confirmedFullAccess: boolean;
    readonly confirmedNetwork: boolean;
    readonly confirmedPartialWorkspaceWrite: boolean;
  };
  readonly loopIterations?: number;
  readonly persistLoopIterations: boolean;
  readonly generation: SessionGeneration;
  readonly persistGeneration: boolean;
}

interface AdoptionResult {
  readonly applies: { sessionId: string; when: 'now' | 'round' }[];
  readonly failure?: { code: string; detail?: string };
}

type ModeState = SessionModeState;
type PolicyRememberScope = 'session' | 'project' | 'user';

function mcpTrustKey(server: string, identityDigest: string): string {
  return `${server}\u0000${identityDigest}`;
}

function policyRuleKey(rule: Pick<PolicyRule, 'tool' | 'match'>): string {
  return JSON.stringify([rule.tool, rule.match ?? '']);
}

interface HostSessionBase {
  readonly id: string;
  readonly session: SessionLog;
  readonly listeners: ((event: SessionEvent) => void)[];
  readonly asks: Set<() => void>;
  readonly mcpTrust: Map<string, { readonly source: 'trusted-ui'; readonly trusted: boolean; readonly updatedAt: string }>;
  sessionPolicyRules: PolicyRule[];
  readonly environment: ProjectEnvironment;
  readonly managedProcesses: ManagedProcessRegistry;
  readonly managedGrantId?: string;
  permission: PermissionContext;
  policyOverride: PolicyMode | null;
  readonly mode: ModeState;
  loopIterations: number;
  readonly loopModelCalls: number;
  pendingLoopIterations?: number;
  generation: SessionGeneration;
  pendingGeneration?: SessionGeneration;
  pending?: ModeFile;
  running?: AbortController;
  permissionChanging?: boolean;
  compaction?: ReturnType<typeof createCompaction> | null;
  progress?: HostRunProgress;
  progressId?: string;
  waitingForApproval?: number;
  waitingForInput?: number;
  progressNotificationAt?: number;
  operation?: Promise<unknown>;
  adopt(file: ModeFile): Promise<void>;
}

interface HostRunProgress {
  readonly phase: LoopProgressPhase;
  readonly startedAt: number;
  readonly phaseStartedAt: number;
  readonly lastProgressAt: number;
  readonly modelCalls: number;
  readonly toolCalls: number;
  readonly outputTokens: number | null;
}

interface HostSessionState extends HostSessionBase {
  readonly chain: DecisionChain;
  readonly kernel: Kernel;
  readonly assembly: Assembly;
  readonly mcp: McpRegistry;
  readonly extensions: Awaited<ReturnType<typeof loadExtensions>>;
  readonly templates: TemplateRegistry;
  readonly loop: ReturnType<typeof createLoop>;
  readonly runDelegated: (input: string, options: DelegatedRunOptions) => Promise<DelegatedRunResult>;
  compaction: ReturnType<typeof createCompaction> | null;
  readonly rebuildCompaction: (model: Record<string, unknown>) => ReturnType<typeof createCompaction> | null;
}

interface DelegatedRunOptions {
  readonly signal?: AbortSignal;
  readonly user?: Record<string, unknown>;
  readonly onProgress?: (event: LoopProgressEvent) => void;
  readonly delegation?: DelegationSpec;
}

interface DelegatedRunResult extends LoopResult {
  readonly structured?: unknown;
  readonly validation?: RunValidation;
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

function permissionView(permission: PermissionContext, changeAllowed: boolean, changeReason?: string): Record<string, unknown> {
  const execDenial = permissionDenial(permission, 'exec');
  return {
    profile: permission.profile,
    network: permission.network,
    capabilities: permission.capabilities,
    profiles: permission.profiles,
    limitations: permission.limitations,
    partialWorkspaceWriteConfirmationRequired: permission.partialWorkspaceWriteConfirmationRequired,
    partialWorkspaceWriteConfirmed: permission.partialWorkspaceWriteConfirmed,
    workspaceTrusted: permission.workspaceTrusted,
    execution: execDenial === undefined
      ? { available: true, code: null, reason: null }
      : { available: false, code: execDenial.code, reason: execDenial.reason },
    changeAllowed,
    ...(changeReason === undefined ? {} : { changeReason }),
  };
}

function permissionOptionsOf(
  permission: PermissionContext,
  partialWorkspaceWriteConfirmed = permission.partialWorkspaceWriteConfirmed,
  workspaceTrusted = permission.workspaceTrusted,
): PermissionContextOptions {
  return {
    profiles: permission.profiles,
    limitations: permission.limitations,
    partialWorkspaceWriteConfirmationRequired: permission.partialWorkspaceWriteConfirmationRequired,
    partialWorkspaceWriteConfirmed,
    workspaceTrusted,
  };
}

function sessionPermissionView(state: HostSessionState, controlAllowed: boolean): Record<string, unknown> {
  const changeReason = !controlAllowed ? 'permission_control_unavailable'
    : state.running !== undefined ? 'permission_session_running'
      : state.permissionChanging === true ? 'permission_change_in_progress'
        : state.extensions.loaded.length > 0 ? 'permission_extension_restart_required'
          : undefined;
  return permissionView(state.permission, changeReason === undefined, changeReason);
}

function checkedSessionModel(model: Record<string, unknown>, selection: ModelSelection): Record<string, unknown> {
  const resolved = resolveModel(model, selection);
  if (selection.provider === 'legacy') {
    const inherited = { ...model };
    delete inherited.selection;
    const configured = resolveModel(inherited);
    if (configured.serviceId !== 'legacy' || configured.model !== selection.model) {
      throw new KernelError('model_not_available');
    }
  }
  return resolved;
}

function generationSelectionOf(event: SessionEvent): ModelSelection | undefined {
  if (event.selection === null) return undefined;
  if (event.selection === undefined) {
    if (typeof event.provider !== 'string' || typeof event.model !== 'string') return undefined;
    return modelSelection({ provider: event.provider, model: event.model });
  }
  return modelSelection(event.selection);
}

function generationOptionsOf(event: SessionEvent): HostGenerationOptions {
  const options: { outputTokens?: number; thinkingEffort?: HostGenerationOptions['thinkingEffort'] } = {};
  const outputTokens = event.outputTokensOverride ?? event.outputTokens;
  if (outputTokens !== undefined && outputTokens !== null) {
    if (typeof outputTokens !== 'number' || !Number.isSafeInteger(outputTokens) || outputTokens < 1) {
      throw new KernelError('session_generation_invalid', { detail: 'outputTokens must be a positive safe integer' });
    }
    options.outputTokens = outputTokens;
  }
  if (event.thinkingEffort !== undefined && event.thinkingEffort !== null) {
    if (typeof event.thinkingEffort !== 'string') throw new KernelError('session_generation_invalid', { detail: 'thinkingEffort must be text' });
    options.thinkingEffort = event.thinkingEffort as HostGenerationOptions['thinkingEffort'];
  }
  return options;
}

function sessionGenerationEvent(generation: SessionGeneration): Record<string, unknown> {
  const selection = generation.explicit === true ? modelSelectionOf(generation.model) : undefined;
  return selection === undefined
    ? {
        kind: 'sessionGeneration', ignorable: true, selection: null,
        thinkingEffort: generation.options.thinkingEffort ?? null,
        outputTokensOverride: generation.options.outputTokens ?? null,
      }
    : {
        kind: 'modelSelection', ignorable: true, ...selection,
        thinkingEffort: generation.options.thinkingEffort ?? null,
        outputTokensOverride: generation.options.outputTokens ?? null,
      };
}

// 会话名称需要为列表中的时间和条目数留出显示空间。
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

// 通过 Session 模块解析记录目录，确保 Host 与会话列表使用同一位置。
// 缺少循环上限时补入默认值，避免未定义的上限让循环无法执行。
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

function sessionLoopLimits(state: HostSessionBase): LoopLimits {
  return {
    get iterations() { return state.loopIterations; },
    get modelCalls() { return state.loopModelCalls; },
  };
}

// 优先采用所选模型声明的上下文窗口，其次采用配置的备用值；两者都未设置时关闭压缩。
// 立即拒绝无效上限，因为非有限窗口无法用于计算上下文压力。
// 保留预算必须小于压力阈值，压缩后才能将请求控制在阈值以内。
export function compactionLimitsOf(config: HostConfigSnapshot, selectedContextTokens?: unknown) {
  const limits = limitsOf(config);
  const contextTokens = selectedContextTokens ?? limits.contextTokens;
  if (contextTokens === undefined) return undefined;
  if (typeof contextTokens !== 'number' || !Number.isSafeInteger(contextTokens) || contextTokens <= 0) {
    throw new KernelError('host_compaction_limits_invalid', { detail: `contextTokens must be a positive safe integer, got ${JSON.stringify(contextTokens)}` });
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
    contextTokens,
    compactThresholdRatio,
    compactRetainRatio,
    resultBytes: resultLimit(config),
  };
}

// 将流式事件转发给客户端，同时把原事件交回循环。
// 保留提供方能力和模型信息；每轮开始时解析当前提供方，使配置变更从下一轮生效。
function observedProvider(provider: HostProvider, onDelta: (event: ProviderEvent) => void): HostProvider {
  return {
    get name() { return provider.name; },
    get model() { return provider.model; },
    get pending() { return provider.pending; },
    get capabilities() { return provider.capabilities; },
    get requiresCompletion() { return provider.requiresCompletion; },
    get outputTokens() { return provider.outputTokens; },
    get contextTokens() { return provider.contextTokens; },
    get thinkingCapability() { return provider.thinkingCapability; },
    get thinkingEffort() { return provider.thinkingEffort; },
    withModel(model) { return observedProvider(provider.withModel(model), onDelta); },
    withGeneration(options) { return observedProvider(provider.withGeneration(options), onDelta); },
    async *stream(request: ModelRequest, options?: { readonly signal?: AbortSignal }) {
      for await (const event of provider.stream(request, options)) {
        if (event.type !== 'finish') onDelta(event);
        yield event;
      }
    },
  };
}

// 主循环、压缩和派生执行都通过此包装器调用模型。
// 调用时再解析提供方，确保同一轮使用同一配置，后续轮次可采用新配置。
function currentProvider(read: () => HostProvider): HostProvider {
  return {
    get name() { return read().name; },
    get model() { return read().model; },
    get pending() { return read().pending; },
    get capabilities() { return read().capabilities; },
    get requiresCompletion() { return read().requiresCompletion; },
    get outputTokens() { return read().outputTokens; },
    get contextTokens() { return read().contextTokens; },
    get thinkingCapability() { return read().thinkingCapability; },
    get thinkingEffort() { return read().thinkingEffort; },
    withModel(model) { return read().withModel(model); },
    withGeneration(options) { return read().withGeneration(options); },
    stream(request, options) { return read().stream(request, options); },
  };
}

function compactionProgressProvider(provider: HostProvider, onProgress: (event: LoopProgressEvent) => void): HostProvider {
  return {
    get name() { return provider.name; },
    get model() { return provider.model; },
    get pending() { return provider.pending; },
    get capabilities() { return provider.capabilities; },
    get requiresCompletion() { return provider.requiresCompletion; },
    get outputTokens() { return provider.outputTokens; },
    get contextTokens() { return provider.contextTokens; },
    get thinkingCapability() { return provider.thinkingCapability; },
    get thinkingEffort() { return provider.thinkingEffort; },
    withModel(model) { return compactionProgressProvider(provider.withModel(model), onProgress); },
    withGeneration(options) { return compactionProgressProvider(provider.withGeneration(options), onProgress); },
    async *stream(request, options) {
      onProgress({ kind: 'phase', phase: 'compaction', modelCalls: 0, toolCalls: 0 });
      for await (const event of provider.stream(request, options)) {
        if (event.type === 'text' || event.type === 'reasoning' || event.type === 'tool-call') {
          onProgress({ kind: 'activity', phase: 'compaction', activity: 'model_output', modelCalls: 0, toolCalls: 0 });
        }
        yield event;
      }
    },
  };
}

// 会话接口将事件写入记录后，再把它转发给客户端。
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

// 只从明确允许的字符串字段构造公开配置。
// 删除 URL 中可能包含密钥的用户名、密码、查询参数和片段。
// 无法解析 URL 时省略该字段，不猜测其内容。
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

// 同时解析模式名称和搜索路径，确保启动与运行时切换使用同一规则。
// 扩展来源由加载器提供；`paths` 会被加载，`ignored` 会写入诊断记录。
export function createHost({
  config, provider, plugins = [minimalPlugin, networkPlugin], policy, logger, modeName, modePaths, skillRegistry,
  templateRegistry, extensions = { paths: [], ignored: [] }, loadEnvironment, configStore, configLayers, configStoreFor,
  deriveProvider = providerFromConfig, interactive = false, permission = DEFAULT_PERMISSION_CONTEXT, permissionControl = false,
  agentControl,
}: HostOptions): Host {
  // 每个项目环境持有自己的配置快照、提供方、策略、模式、记录目录和可写配置层。
  // 在加载环境时校验配置，避免等到第一次模型请求才发现错误。
  // 文件系统边界同时限制工具访问范围和指令文件向上查找的范围。
  // 用户配置由所有项目共享；项目共享层和本地层只属于各自项目。
  // 加载器负责解析配置文件路径；Host 通过层名、允许字段和版本读写配置。
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
      mcpConfigs: mcpServerConfigs(mcpConfig, process.env, root),
      directory: sessionDirectory(runtimeConfig),
    };
  }

  const defaultEnvironment = prepareEnvironment({
    config, provider, policy, modeName, modePaths, skillRegistry, templateRegistry, extensions,
    // 根据加载器提供的配置层创建存储，以便读取时返回每个值的来源。
    // 加载器已创建存储时直接复用。
    layers: configLayers,
    store: configStore,
  });
  // 每个归一化项目根目录只缓存一个环境，供该项目的会话与列表操作复用。
  const environments = new Map<string, ProjectEnvironment>([[defaultEnvironment.projectRoot, defaultEnvironment]]);
  const sessionConfigurationTails = new Map<string, Promise<void>>();
  const canControlPermission = permissionControl || agentControl?.operator === true;
  let knownGrant: DelegationGrant | undefined;

  async function activeDelegation(): Promise<DelegationGrant | undefined> {
    if (agentControl === undefined) return undefined;
    knownGrant = await agentControl.validate();
    return knownGrant;
  }

  async function assertDelegationProject(grant: DelegationGrant, root: string): Promise<void> {
    let actual: string;
    try { actual = await realpath(root); }
    catch { throw new KernelError('agent_control_project_forbidden'); }
    const expected = process.platform === 'win32' ? grant.projectRoot.toLowerCase() : grant.projectRoot;
    const found = process.platform === 'win32' ? actual.toLowerCase() : actual;
    if (found !== expected) throw new KernelError('agent_control_project_forbidden');
  }

  async function serializeSessionConfiguration<T>(sessionId: string, action: () => Promise<T>): Promise<T> {
    const previous = sessionConfigurationTails.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => {}).then(() => gate);
    sessionConfigurationTails.set(sessionId, tail);
    await previous.catch(() => {});
    try { return await action(); }
    finally {
      release();
      if (sessionConfigurationTails.get(sessionId) === tail) sessionConfigurationTails.delete(sessionId);
    }
  }

  // 对路径不存在、目标不是目录和目录不可读分别返回稳定错误。
  // 新项目还没有记录目录是正常状态，会话列表应返回空结果。
  async function classifyProjectRoot(asked: string): Promise<void> {
    try {
      if (!(await stat(asked)).isDirectory()) throw new KernelError('host_project_root_not_directory', { detail: asked });
    } catch (error) {
      if (error instanceof KernelError) throw error;
      const reason = errorCode(error);
      if (reason === 'ENOENT') throw new KernelError('host_project_root_missing', { detail: asked });
      // 区分路径中有文件阻断和目标路径不存在这两种情况。
      if (reason === 'ENOTDIR') throw new KernelError('host_project_root_not_directory', { detail: asked });
      throw new KernelError('host_project_root_unreadable', { detail: `${asked}: ${reason ?? String(error)}` });
    }
  }

  // 未指定项目时使用 Host 的默认环境。指定项目尚未加载时返回不支持错误，不能借默认环境读取。
  async function environmentFor(projectRoot: unknown): Promise<ProjectEnvironment> {
    if (projectRoot === undefined || projectRoot === null || projectRoot === '') return defaultEnvironment;
    if (typeof projectRoot !== 'string') throw new KernelError('host_project_root_invalid');
    const asked = resolve(projectRoot);
    const askedIdentity = workspaceIdentity(projectRoot);
    // 同时比较解析后的根路径和归一化身份，让同一目录的不同写法共用缓存环境。
    const known = [...environments.values()].find((each) => resolve(each.projectRoot) === asked || workspaceIdentity(each.projectRoot) === askedIdentity);
    if (known !== undefined) return known;
    if (loadEnvironment === undefined) throw new KernelError('host_project_root_unsupported', { detail: String(projectRoot).slice(0, 200) });
    await classifyProjectRoot(asked);
    const loaded = prepareEnvironment(await loadEnvironment(projectRoot));
    // 大小写、分隔符、末尾斜线和链接可能指向同一目录；工作区身份与会话列表采用相同的归一规则。
    if (resolve(loaded.projectRoot) !== asked && workspaceIdentity(loaded.projectRoot) !== askedIdentity) {
      throw new KernelError('host_project_root_mismatch', { detail: `asked for ${projectRoot}, the layers give ${loaded.projectRoot}` });
    }
    environments.set(loaded.projectRoot, loaded);
    return loaded;
  }

  async function currentMcpConfigs(env: ProjectEnvironment): Promise<ReturnType<typeof mcpServerConfigs>> {
    if (loadEnvironment === undefined) return env.mcpConfigs;
    const latest = await loadConfigLayers({ projectRoot: env.projectRoot });
    const config = createConfig({
      ...latest,
      ...(env.layers.flag === undefined ? {} : { flag: env.layers.flag }),
    });
    const mcpConfig = isRecord(config.mcp) ? { mcp: { servers: config.mcp.servers } } : {};
    return mcpServerConfigs(mcpConfig, process.env, env.projectRoot);
  }

  async function stopMcpServersWithChangedConfig(env: ProjectEnvironment, current: ReturnType<typeof mcpServerConfigs>): Promise<void> {
    for (const state of sessions.values()) {
      if (state.environment !== env) continue;
      for (const previous of env.mcpConfigs) {
        const next = current.find((server) => server.name === previous.name);
        if (next === undefined || next.identityDigest !== previous.identityDigest) await state.mcp.revoke(previous.name);
      }
    }
  }

  async function readOnlySessionConfig(projectRoot: string): Promise<RuntimeConfig> {
    try {
      return (await environmentFor(projectRoot)).config;
    } catch (error) {
      if (loadEnvironment !== undefined || errorCode(error) !== 'host_project_root_unsupported') throw error;
      // A Host without a project loader can still browse a known workspace's stored history without loading project config.
      return { ...defaultEnvironment.config, boundary: projectRoot, workspaceRoot: projectRoot };
    }
  }

  async function initialSessionSettings(env: ProjectEnvironment, params: HostMethodParams, grant?: DelegationGrant): Promise<InitialSessionSettings> {
    if (params.confirmInitialWorkspaceTrust === true && !permissionControl) {
      throw new KernelError('workspace_trust_control_unavailable');
    }
    const hasProvider = params.initialProvider !== undefined;
    const hasModel = params.initialModel !== undefined;
    if (hasProvider !== hasModel) throw new KernelError('session_model_selection_invalid', { detail: 'initialProvider and initialModel must be supplied together' });
    let selection: ModelSelection | undefined;
    let model = { ...(env.generation?.model ?? env.pendingModel ?? modelConfigOf(env.config)) };
    if (hasProvider && hasModel) {
      selection = modelSelection({ provider: params.initialProvider, model: params.initialModel });
      const latest = env.store === undefined ? env.config : (await env.store.read()).values;
      model = { ...modelConfigOf(env.config), ...(isRecord(latest.model) ? latest.model : {}), selection };
      checkedSessionModel(model, selection);
    }
    let policy: Exclude<PolicyMode, 'default'> | undefined;
    const requestedPolicy = params.initialPolicy ?? grant?.defaultPolicy;
    if (requestedPolicy !== undefined) {
      if (requestedPolicy !== 'ask' && requestedPolicy !== 'auto' && requestedPolicy !== 'never') {
        throw new KernelError('policy_mode_unknown');
      }
      if (grant !== undefined) assertDelegationPolicy(grant, requestedPolicy);
      policy = requestedPolicy;
    }
    const hasInitialPermission = params.initialPermissionProfile !== undefined || params.initialPermissionNetwork !== undefined;
    let initialPermission: InitialSessionSettings['permission'];
    if (hasInitialPermission) {
      if (!permissionControl && agentControl?.operator !== true) {
        throw new KernelError(agentControl === undefined ? 'permission_control_unavailable' : 'agent_control_operator_required');
      }
      const profile = params.initialPermissionProfile ?? permission.profile;
      const network = params.initialPermissionNetwork ?? permission.network;
      if (profile !== 'read-only' && profile !== 'workspace-write' && profile !== 'full-access') {
        throw new KernelError('permission_profile_invalid');
      }
      if (network !== 'policy' && network !== 'unrestricted' && network !== 'disabled') {
        throw new KernelError('permission_network_mode_invalid');
      }
      if (grant !== undefined) assertDelegationPermission(grant, profile, network);
      const confirmedFullAccess = grant === undefined
        ? profile === 'full-access' && params.confirmInitialFullAccess === true
        : profile === 'full-access' && grant.confirmedFullAccess;
      const confirmedNetwork = grant === undefined
        ? network === 'unrestricted' && params.confirmInitialNetwork === true
        : network === 'unrestricted' && grant.confirmedUnrestrictedNetwork;
      const confirmedPartialWorkspaceWrite = grant === undefined
        ? profile === 'workspace-write' && params.confirmInitialPartialWorkspaceWrite === true
        : profile === 'workspace-write' && grant.confirmedPartialWorkspaceWrite;
      if (grant === undefined && profile === 'full-access' && !confirmedFullAccess) {
        throw new KernelError('permission_full_access_confirmation_required');
      }
      if (grant === undefined && network === 'unrestricted' && !confirmedNetwork) {
        throw new KernelError('permission_network_confirmation_required');
      }
      if (profile === 'workspace-write' && permission.partialWorkspaceWriteConfirmationRequired && !confirmedPartialWorkspaceWrite) {
        throw new KernelError('permission_partial_sandbox_confirmation_required');
      }
      initialPermission = {
        context: createPermissionContext(profile, network, permission.capabilities, permissionOptionsOf(
          permission, confirmedPartialWorkspaceWrite,
        )),
        confirmedFullAccess,
        confirmedNetwork,
        confirmedPartialWorkspaceWrite,
      };
    }
    const options: { outputTokens?: number; thinkingEffort?: HostGenerationOptions['thinkingEffort'] } = {};
    if (params.initialOutputTokens !== undefined) {
      if (!Number.isSafeInteger(params.initialOutputTokens) || params.initialOutputTokens < 1) {
        throw new KernelError('provider_output_budget_invalid');
      }
      options.outputTokens = params.initialOutputTokens;
    }
    if (params.initialThinkingEffort !== undefined && params.initialThinkingEffort !== 'default') {
      if (!['none', 'low', 'high', 'max'].includes(params.initialThinkingEffort)) {
        throw new KernelError('provider_thinking_effort_invalid');
      }
      options.thinkingEffort = params.initialThinkingEffort as HostGenerationOptions['thinkingEffort'];
    }
    let loopIterations: number | undefined;
    if (params.initialLoopIterations !== undefined) {
      if (!Number.isSafeInteger(params.initialLoopIterations) || params.initialLoopIterations < 1) {
        throw new KernelError('host_loop_limits_invalid', { detail: 'iterations must be a positive safe integer' });
      }
      loopIterations = params.initialLoopIterations;
    }
    const persistGeneration = selection !== undefined || Object.keys(options).length > 0;
    const provider = persistGeneration ? deriveProvider({ ...env.config, model }, options) : env.generation?.provider ?? env.provider;
    const mode = params.initialMode === undefined
      ? undefined
      : params.initialMode === 'default' ? env.modeName ?? DEFAULT_MODE : requiredString(params.initialMode, 'initialMode');
    if (mode !== undefined) {
      if (env.modePaths === undefined) throw new KernelError('host_mode_paths_required');
      await loadMode(mode, env.modePaths);
    }
    if (params.confirmInitialWorkspaceTrust === true) await setTrusted(env.projectRoot, true);
    return {
      ...(mode === undefined ? {} : { mode }),
      ...(policy === undefined ? {} : { policy }),
      ...(initialPermission === undefined ? {} : { permission: initialPermission }),
      ...(loopIterations === undefined ? {} : { loopIterations }),
      persistLoopIterations: loopIterations !== undefined,
      generation: { provider, model, ...(selection === undefined ? {} : { explicit: true }), options },
      persistGeneration,
    };
  }

  // 在工作区中创建或打开会话后登记该工作区。
  // 登记失败会写入日志，但不会阻止会话打开。
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

  // 每次写入后都根据已保存的配置层重新计算有效提供方。
  // 如果更高优先级的配置层仍提供旧值，就说明当前运行配置没有改变。
  // 后续字段更新以环境的最新配置为基础，连续编辑时不会覆盖先前修改。
  // 启动时的配置快照保持不变。`config.get` 返回可写文件的内容，`status.get` 返回会话当前使用的提供方。
  function adoptGeneration(env: ProjectEnvironment, key: string, effective: unknown): AdoptionResult {
    // 保留尚未完整的模型配置，让后续字段写入可以继续补齐。
    // 首次配置时即使还没有 `[model]` 表也适用。
    const base = env.generation ?? { provider: env.provider, model: env.pendingModel ?? modelConfigOf(env.config), options: {} };
    const model: Record<string, unknown> = { ...base.model, [key]: effective };
    let provider: HostProvider;
    try {
      provider = deriveProvider({ ...env.config, model }, {});
    } catch (error) {
      env.pendingModel = model;
      return { applies: [], failure: { code: errorCode(error) ?? 'provider_rebuild_failed', detail: errorMessage(error) } };
    }
    env.pendingModel = undefined;
    // 有效提供方未变化时报告未应用，返回结果应反映实际运行状态。
    const changed = new Set<string>([...Object.keys(base.model ?? {}), ...Object.keys(model)]);
    if ([...changed].every((field) => base.model?.[field] === model[field])) return { applies: [] };
    env.generation = { provider, model, options: {} };
    // 更新环境中的提供方，让新会话使用最新的有效配置。
    env.provider = provider;
    const applies: { sessionId: string; when: 'now' | 'round' }[] = [];
    let sessionFailure;
    for (const [id, state] of sessions) {
      if (state.environment !== env) continue;
      const ownGeneration = state.pendingGeneration ?? state.generation;
      if (ownGeneration.explicit === true) {
        const selection = modelSelectionOf(ownGeneration.model);
        if (key === 'services' && selection?.provider === 'legacy') continue;
        if (key !== 'services' && key !== 'outputTokens') continue;
        const ownModel: Record<string, unknown> = key === 'services'
          ? { ...ownGeneration.model, services: effective }
          : { ...ownGeneration.model, outputTokens: effective };
        let ownProvider: HostProvider;
        try { ownProvider = deriveProvider({ ...env.config, model: ownModel }, ownGeneration.options); }
        catch (error) { sessionFailure = { code: errorCode(error) ?? 'provider_rebuild_failed' }; continue; }
        const previous = resolveModel(ownGeneration.model);
        const next = resolveModel(ownModel);
        if (['api', 'baseURL', 'apiKeyEnv', 'model', 'outputTokens', 'serviceOutputLimit', 'serviceContextTokens'].every((field) => previous[field] === next[field])) continue;
        const generation: SessionGeneration = { provider: ownProvider, model: ownModel, explicit: true, options: ownGeneration.options };
        if (state.running === undefined) {
          state.generation = generation;
          state.pendingGeneration = undefined;
          state.compaction = state.rebuildCompaction(generation.model);
          applies.push({ sessionId: id, when: 'now' });
        }
        else { state.pendingGeneration = generation; applies.push({ sessionId: id, when: 'round' }); }
        continue;
      }
      if (state.running === undefined) {
        const ownProvider = deriveProvider({ ...env.config, model }, state.generation.options);
        state.generation = { provider: ownProvider, model, options: state.generation.options };
        state.pendingGeneration = undefined;
        state.compaction = state.rebuildCompaction(model);
        applies.push({ sessionId: id, when: 'now' });
      } else {
        const ownProvider = deriveProvider({ ...env.config, model }, state.generation.options);
        state.pendingGeneration = { provider: ownProvider, model, options: state.generation.options };
        applies.push({ sessionId: id, when: 'round' });
      }
    }
    return { applies, ...(sessionFailure === undefined ? {} : { failure: sessionFailure }) };
  }

  // 策略和规则变更从下一次权限判定开始生效，不影响已派发的调用。
  // 更新继承配置默认值的会话，保留会话级覆盖，并替换配置中的规则集合。
  function adoptPolicy(env: ProjectEnvironment, key: string, effective: unknown): AdoptionResult {
    if (key === 'rules') {
      if (JSON.stringify(env.policy?.rules ?? []) === JSON.stringify(effective ?? [])) return { applies: [] };
      if (!Array.isArray(effective) || !effective.every(isPolicyRule)) throw new KernelError('policy_rules_invalid');
      const applies: { sessionId: string; when: 'now' }[] = [];
      for (const [id, state] of sessions) {
        if (state.environment !== env) continue;
        state.chain.setRules(mergePolicyRules([
          { source: 'session', rules: state.sessionPolicyRules },
          { source: 'config', rules: effective },
        ]).rules as PolicyRule[]);
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

  // 根据发生变化的配置层重新计算各个已加载环境。环境共享用户设置，各自拥有项目共享层和本地层。
  // 配置层不完整的环境不参与更新。
  async function effectiveOf(env: ProjectEnvironment, table: string, key: string): Promise<unknown> {
    if (env.store === undefined) return undefined;
    const fresh = await env.store.read();
    return key === 'rules' ? fresh.rules : fresh.values?.[table]?.[key];
  }

  // 用户设置影响所有已加载项目；项目本地设置只影响所属项目。
  // 分别重算每个环境，保留更高优先级项目配置的覆盖效果。
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
      // 有效配置未变化时保留当前提供方。
      if (target === env && changed === false) continue;
      const own = target === env ? effective : await effectiveOf(target, table, key);
      if (own === undefined) continue;
      const answer = table === 'policy' ? adoptPolicy(target, key, own) : adoptGeneration(target, key, own);
      applies.push(...answer.applies);
      if (answer.failure !== undefined) failure = answer.failure;
    }
    return { applies, ...(failure === undefined ? {} : { failure }) };
  }

  async function rememberPolicyRule(
    state: HostSessionState,
    tool: string,
    command: string | undefined,
    scope: PolicyRememberScope,
  ): Promise<void> {
    const rule: PolicyRule = { tool, decision: 'allow', ...(command === undefined ? {} : { match: command }) };
    const identity = policyRuleKey(rule);
    if (scope === 'session') {
      const existing = state.sessionPolicyRules.findIndex((item) => policyRuleKey(item) === identity);
      const rules = state.sessionPolicyRules.map((item, index) => index === existing ? rule : item);
      if (existing < 0) rules.push(rule);
      const updatedAt = new Date().toISOString();
      await state.session.append({ kind: 'sessionPolicyRule', ignorable: true, rule, updatedAt });
      state.sessionPolicyRules = rules;
      state.chain.setRules(mergePolicyRules([
        { source: 'session', rules },
        { source: 'config', rules: state.environment.policy?.rules ?? [] },
      ]).rules as PolicyRule[]);
      return;
    }

    const env = state.environment;
    if (env.store === undefined) throw new KernelError('config_write_unsupported');
    const layer = scope === 'project' ? 'projectLocal' : 'user';
    const targetLayer = scope === 'project' ? 'local' : 'user';
    const snapshot = await env.store.read();
    const higherLayers = scope === 'user' ? ['flag', 'local', 'project'] : ['flag'];
    const shadowing = higherLayers.find((source) => snapshot.ruleLayers[source]?.some((item) => policyRuleKey(item) === identity));
    if (shadowing !== undefined) throw new KernelError('policy_memory_shadowed', { detail: shadowing });
    const current = snapshot.ruleLayers[targetLayer] ?? [];
    const matches = current.flatMap((item, index) => policyRuleKey(item) === identity ? [index] : []);
    if (matches.length > 1) throw new KernelError('policy_rule_duplicate_ambiguous', { detail: tool });
    const layerVersion = snapshot.layers.find((item) => item.layer === layer)?.version ?? '';
    const written = await env.store.write({
      field: 'policy.rules',
      layer,
      version: layerVersion,
      op: matches.length === 0 ? 'add' : 'update',
      ...(matches.length === 0 ? {} : { index: matches[0] }),
      rule,
    });
    const adoption = await adoptWritten(env, layer, 'policy', 'rules', written.effective, written.changed);
    if (adoption.failure !== undefined) throw new KernelError(adoption.failure.code, { detail: adoption.failure.detail });
  }

  // 释放会话的 MCP 子进程、扩展监听器、模板登记表和记录锁。
  // 会话记录继续保存在磁盘上；这里只清理运行时状态。
  async function retire(state: HostSessionState): Promise<void> {
    // 失败或取消结果已经写入记录；收尾只等待轮次结束，不覆盖其结果。
    await state.operation?.catch(() => undefined);
    const failures: unknown[] = [];
    for (const release of [
      () => state.managedProcesses.close(),
      () => state.mcp.close(),
      () => state.extensions.dispose(),
      () => state.assembly.dispose(),
    ]) {
      try { await release(); }
      catch (error) { failures.push(error); }
    }
    // 即使其中一个资源未能释放，也要移除会话并释放记录锁，避免客户端无法关闭会话。
    sessions.delete(state.id);
    try { await state.session.close(); }
    catch (error) { failures.push(error); }
    if (failures.length > 0) throw new AggregateError(failures, 'host_session_retire_failed');
  }

  // 项目最后一个会话关闭后移除其环境，让下次打开时重新加载配置。
  // Host 默认环境没有加载器入口可重建，因此继续保留。
  function evictEnvironment(environment: ProjectEnvironment): void {
    if (environment === defaultEnvironment) return;
    for (const other of sessions.values()) if (other.environment === environment) return;
    environments.delete(environment.projectRoot);
  }

  // 从记录标签推导当前会话名称和归档状态，让 Host 与客户端使用同一事实来源。
  async function labelOf(state: HostSessionState): Promise<{ sessionId: string; name: string; archived: boolean }> {
    return { sessionId: state.id, ...foldLabel(await state.session.read()) };
  }

  function publishProgress(state: HostSessionState, connection: HostClientConnection): void {
    state.progressNotificationAt = Date.now();
    connection.notify({ notify: 'progress', sessionId: state.id, progress: state.progress ?? null });
  }

  function changeProgressPhase(state: HostSessionState, connection: HostClientConnection, phase: LoopProgressPhase): void {
    if (state.progress === undefined || state.progress.phase === phase) return;
    state.progress = { ...state.progress, phase, phaseStartedAt: Date.now() };
    publishProgress(state, connection);
  }

  function observeLoopProgress(
    state: HostSessionState,
    connection: HostClientConnection,
    runId: string,
    event: LoopProgressEvent,
  ): void {
    if (state.progress === undefined || state.progressId !== runId) return;
    const now = Date.now();
    const phase = event.kind === 'phase' ? event.phase : state.progress.phase;
    const phaseChanged = phase !== state.progress.phase;
    state.progress = {
      ...state.progress,
      phase,
      ...(phaseChanged ? { phaseStartedAt: now } : {}),
      ...(event.kind === 'activity' ? { lastProgressAt: now } : {}),
      modelCalls: Math.max(state.progress.modelCalls, event.modelCalls),
      toolCalls: Math.max(state.progress.toolCalls, event.toolCalls),
    };
    if (event.kind === 'phase' || phaseChanged || event.activity === 'tool'
      || now - (state.progressNotificationAt ?? 0) >= 100) publishProgress(state, connection);
  }

  function beginProgress(
    state: HostSessionState,
    connection: HostClientConnection,
    phase: LoopProgressPhase,
  ): { readonly id: string; readonly report: (event: LoopProgressEvent) => void } {
    const now = Date.now();
    const id = randomUUID();
    state.progressId = id;
    state.progress = {
      phase,
      startedAt: now,
      phaseStartedAt: now,
      lastProgressAt: now,
      modelCalls: 0,
      toolCalls: 0,
      outputTokens: state.generation.provider.outputTokens ?? null,
    };
    state.waitingForApproval = 0;
    state.waitingForInput = 0;
    publishProgress(state, connection);
    return { id, report: (event) => observeLoopProgress(state, connection, id, event) };
  }

  function updateWaitingForUser(
    state: HostSessionState,
    connection: HostClientConnection,
    waiting: boolean,
    kind: 'approval' | 'input',
  ): void {
    const field = kind === 'approval' ? 'waitingForApproval' : 'waitingForInput';
    state[field] = Math.max(0, (state[field] ?? 0) + (waiting ? 1 : -1));
    if ((state.waitingForInput ?? 0) > 0) changeProgressPhase(state, connection, 'awaiting_input');
    else if ((state.waitingForApproval ?? 0) > 0) changeProgressPhase(state, connection, 'awaiting_approval');
    else if (state.progress?.phase === 'awaiting_input' || state.progress?.phase === 'awaiting_approval') {
      changeProgressPhase(state, connection, 'tool_execution');
    }
  }

  async function execute<T>(
    state: HostSessionState,
    action: (signal: AbortSignal, report: (event: LoopProgressEvent) => void) => Promise<T>,
    connection: HostClientConnection,
    initialPhase: LoopProgressPhase = 'preparing',
  ): Promise<T> {
    if (state.permissionChanging) throw new KernelError('permission_change_in_progress', { detail: state.id });
    if (state.running !== undefined) throw new KernelError('run_already_running', { detail: state.id });
    const controller = new AbortController();
    const progress = beginProgress(state, connection, initialPhase);
    const settleAsks = (): void => { for (const settle of state.asks) settle(); };
    controller.signal.addEventListener('abort', settleAsks, { once: true });
    state.running = controller;
    const operation = (async (): Promise<T> => {
      try {
        return await action(controller.signal, progress.report);
      } finally {
        controller.signal.removeEventListener('abort', settleAsks);
        state.running = undefined;
        changeProgressPhase(state, connection, 'settling');
        try {
          if (state.pending !== undefined) {
            const next = state.pending;
            state.pending = undefined;
            await state.adopt(next);
          }
          // 当前轮次结束、接受下一条输入前应用生成设置。
          // 这样一轮中的循环、压缩和派生执行会使用相同的提供方配置。
          if (state.pendingGeneration !== undefined) {
            state.generation = state.pendingGeneration;
            state.pendingGeneration = undefined;
            state.compaction = state.rebuildCompaction(state.generation.model);
          }
          if (state.pendingLoopIterations !== undefined) {
            state.loopIterations = state.pendingLoopIterations;
            state.pendingLoopIterations = undefined;
          }
        } finally {
          if (state.progressId === progress.id) {
            state.progress = undefined;
            state.progressId = undefined;
            state.waitingForApproval = 0;
            state.waitingForInput = 0;
            state.progressNotificationAt = undefined;
            publishProgress(state, connection);
          }
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

  // 派生会话编号由父会话编号和序号组成；只有父会话在当前 Host 中打开时才能读取。
  function branchOwner(id: string): string | undefined {
    const matched = /^(.+)\.sub-(\d+)$/.exec(id);
    return matched !== null && sessions.has(matched[1]) ? matched[1] : undefined;
  }

  // 使用客户端提供的会话编号拼接记录路径前先校验，拒绝分隔符和格式错误的编号。
  // 打开、读取和创建分支都使用同一校验规则。
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

  // 只为当前页包含的记录读取溢出文件。
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

  // 使用稳定递增的事件序号分页；向前读取时以当前页第一条序号为边界。
  // 翻页期间追加的新事件不会造成旧记录重复或遗漏。`endSeq` 标记本次快照的末尾，`hasMore` 表示是否还有更早记录。
  async function readForClient(
    session: SessionLog,
    sessionId: string,
    { fullResults, limit, before, at }: { fullResults?: boolean; limit?: number; before?: number; at?: number } = {},
    env: ProjectEnvironment = defaultEnvironment,
  ) {
    const events = await session.read();
    const header = await session.header();
    if (at !== undefined && before !== undefined) {
      throw new KernelError('protocol_args_invalid', { detail: 'session.read at and before are mutually exclusive' });
    }
    // 游标未指向当前会话的事件时应返回错误，不能静默退回第一页。
    const cursor = at ?? before;
    if (cursor !== undefined && !events.some((event) => event.seq === cursor)) {
      throw new KernelError('session_cursor_invalid', { detail: `${sessionId} has no event ${cursor}` });
    }
    const page = at !== undefined
      ? events.filter((event) => event.seq === at)
      : (before === undefined ? events : events.filter((event) => event.seq < before)).slice(-(limit ?? events.length));
    return {
      sessionId,
      events: fullResults ? await fillSpills(page, env) : page,
      header: header ?? null,
      label: foldLabel(events),
      endSeq: page.at(-1)?.seq ?? null,
      hasMore: page.length > 0 && page[0].seq > 1,
    };
  }

  // 打开中的会话从运行时读取，派生会话从已保存记录读取；两者使用相同的响应结构。
  // 此方法只读取指定会话。使用会话列表查找记录，使用 `session.open` 重新打开会话。
  // 分页和溢出内容选项原样交给 `readForClient`。
  async function readRecord(id: string, params: { fullResults?: boolean; limit?: number; before?: number; at?: number }) {
    const state = sessions.get(id);
    if (state !== undefined) return await readForClient(state.session, id, params, state.environment);
    // 父轮次结束后，派生会话没有运行时状态，因此从已保存记录读取。
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

  // 每个会话拥有自己的 Kernel、权限状态和循环。
  // 审批请求属于发起它的会话；客户端未明确允许时一律拒绝。
  // 等待审批期间取消轮次时，结束待处理请求并记录拒绝结果。
  async function appendPolicyState(session: SessionLog, chain: DecisionChain, override: PolicyState['override'] = chain.snapshot().override): Promise<void> {
    const header = await session.header();
    if ((header?.formatVersion ?? 0) < 2) {
      throw new KernelError('session_policy_format_unsupported', {
        detail: 'session policy changes require a session record with format version 2 or newer',
      });
    }
    await session.append({ kind: 'sessionPolicy', ignorable: true, ...chain.snapshot(), override });
  }

  async function build(
    id: string,
    connection: HostClientConnection,
    recover = false,
    explicitMode?: string,
    env: ProjectEnvironment = defaultEnvironment,
    workspaceOrigin?: 'explicit' | 'default',
    initial?: InitialSessionSettings,
  ): Promise<HostSessionState> {
    // 从会话所属的项目环境解析项目级资源。
    const { config, provider, policy, modePaths, directory, mcpConfigs, extensions, skillRegistry, templateRegistry } = env;
    // 将已持久化的会话事件同时发送给客户端和已加载扩展。
    const listeners: ((event: SessionEvent) => void)[] = [];
    const asks = new Set<() => void>();
    const modeState: ModeState = { file: undefined, tools: [], undo: () => {} };
    const configuredLoopLimits = loopLimitsOf(config);
    // 新会话可能尚未选择模式，因此在创建记录时再解析模式身份。
    const session = observedSession(createSessionLog({
      directory,
      id,
      meta: () => ({
        projectRoot: env.projectRoot,
        // 在记录首行保存工作区身份和来源，供客户端稳定分组。
        // 现有会话已包含这些元数据，重新打开时不要改写首行。
        workspace: workspaceIdentity(env.projectRoot),
        ...(workspaceOrigin === undefined ? {} : { workspaceOrigin }),
        mode: modeState.file === undefined ? undefined : { name: modeState.file.name, layer: modeState.file.layer },
      }),
    }), (event) => {
      connection.notify({ notify: 'event', sessionId: id, event });
      for (const listener of listeners) listener(event);
    });
    // 新会话继承项目当前有效的生成设置。配置写入后，初始快照可能已过期，优先读取环境的最新设置。
    const workspaceTrusted = await isTrusted(env.projectRoot);
    const basePermission = recover ? permission : initial?.permission?.context ?? permission;
    const sessionPermission = createPermissionContext(
      recover ? 'read-only' : basePermission.profile,
      recover ? 'policy' : basePermission.network,
      basePermission.capabilities,
      permissionOptionsOf(basePermission, recover ? false : basePermission.partialWorkspaceWriteConfirmed, workspaceTrusted),
    );
    const managedProcesses = createManagedProcessRegistry(agentControl === undefined ? {} : {
      validateOwner: async () => {
        const active = await activeDelegation();
        if (active?.id !== agentControl.grantId) throw new KernelError('agent_control_grant_revoked');
      },
    });
    const state: HostSessionBase = {
      id,
      session,
      listeners,
      asks,
      mcpTrust: new Map(),
      sessionPolicyRules: [],
      running: undefined,
      mode: modeState,
      pending: undefined,
      environment: env,
      managedProcesses,
      ...(agentControl === undefined ? {} : { managedGrantId: agentControl.grantId }),
      permission: sessionPermission,
      policyOverride: initial?.policy ?? null,
      loopIterations: initial?.loopIterations ?? configuredLoopLimits.iterations,
      loopModelCalls: configuredLoopLimits.modelCalls,
      generation: initial?.generation ?? env.generation ?? { provider, model: modelConfigOf(config), options: {} },
      adopt: async () => {},
    };
    // 调用时解析生成设置，让循环、压缩和派生执行都能读取会话的最新配置。
    const live = currentProvider(() => state.generation.provider);
    let recoveredPolicyState: PolicyState | undefined;
    await session.acquire();
    const cleanup = [];
    try {
    if (recover) {
      const events = await session.read();
      state.sessionPolicyRules = events.filter((item) => item.kind === 'sessionPolicyRule').map((item) => item.rule as PolicyRule);
      for (const event of events.filter((item) => item.kind === 'sessionMcpTrust')) {
        state.mcpTrust.set(mcpTrustKey(event.server as string, event.identityDigest as string), {
          source: 'trusted-ui',
          trusted: event.trusted as boolean,
          updatedAt: event.updatedAt as string,
        });
      }
      const savedPermission = events.filter((event) => event.kind === 'sessionPermission').at(-1);
      if (savedPermission !== undefined) {
        state.permission = createPermissionContext(savedPermission.profile, savedPermission.network, permission.capabilities,
          permissionOptionsOf(permission, savedPermission.confirmedPartialWorkspaceWrite === true, workspaceTrusted));
      }
      const savedPolicy = events.filter((event) => event.kind === 'sessionPolicy').at(-1);
      if (savedPolicy !== undefined) {
        recoveredPolicyState = {
          override: savedPolicy.override === null ? null : savedPolicy.override as PolicyMode,
          consecutive: savedPolicy.consecutive as number,
          total: savedPolicy.total as number,
          forcedToAsk: savedPolicy.forcedToAsk as boolean,
        };
        state.policyOverride = recoveredPolicyState.override;
      }
      const grant = await activeDelegation();
      if (grant !== undefined) assertDelegationPermission(grant, state.permission.profile, state.permission.network);
      const savedLoopIterations = events.filter((event) => event.kind === 'sessionLoopIterations').at(-1)?.iterations;
      if (savedLoopIterations !== undefined) {
        if (typeof savedLoopIterations !== 'number' || !Number.isSafeInteger(savedLoopIterations) || savedLoopIterations < 1) {
          throw new KernelError('host_loop_limits_invalid', { detail: 'saved iterations must be a positive safe integer' });
        }
        state.loopIterations = savedLoopIterations;
      }
      const saved = events.filter((event) => event.kind === 'sessionGeneration' || event.kind === 'modelSelection').at(-1);
      if (saved !== undefined) {
        const baseModel = { ...(env.generation?.model ?? modelConfigOf(config)) };
        const selection = generationSelectionOf(saved);
        const model = selection === undefined ? baseModel : { ...baseModel, selection };
        const options = generationOptionsOf(saved);
        state.generation = { provider: deriveProvider({ ...config, model }, options), model, explicit: selection !== undefined, options };
      } else {
        const previous = events.filter((event) => event.kind === 'modelSelection').at(-1);
        if (previous !== undefined) {
          const selection = modelSelection({ provider: previous.provider, model: previous.model });
          const model = { ...(env.generation?.model ?? modelConfigOf(config)), selection };
          state.generation = { provider: deriveProvider({ ...config, model }, {}), model, explicit: true, options: {} };
        }
      }
    } else {
      const grant = await activeDelegation();
      await session.append(grant !== undefined
        ? {
            kind: 'sessionPermission',
            profile: state.permission.profile,
            network: state.permission.network,
            source: 'agent-control',
            grantId: grant.id,
            confirmedFullAccess: state.permission.profile === 'full-access' && grant.confirmedFullAccess,
            confirmedNetwork: state.permission.network === 'unrestricted' && grant.confirmedUnrestrictedNetwork,
            confirmedPartialWorkspaceWrite: state.permission.profile === 'workspace-write' && grant.confirmedPartialWorkspaceWrite,
          }
        : initial?.permission === undefined
          ? {
              kind: 'sessionPermission',
              profile: state.permission.profile,
              network: state.permission.network,
              source: 'host-default',
              confirmedPartialWorkspaceWrite: state.permission.profile === 'workspace-write'
                && state.permission.partialWorkspaceWriteConfirmed,
            }
          : {
              kind: 'sessionPermission',
              profile: state.permission.profile,
              network: state.permission.network,
              source: 'trusted-ui',
              confirmedFullAccess: initial.permission.confirmedFullAccess,
              confirmedNetwork: initial.permission.confirmedNetwork,
              confirmedPartialWorkspaceWrite: initial.permission.confirmedPartialWorkspaceWrite,
            });
    }
    const chain = createDecisionChain({
      ...policy,
      rules: mergePolicyRules([
        { source: 'session', rules: state.sessionPolicyRules },
        { source: 'config', rules: policy?.rules ?? [] },
      ]).rules as PolicyRule[],
      ask: async ({ tool, input, command, reason, shell, executable, policy, policySource, policyForced, rememberable, scriptBinding }) => {
        const rememberScopes: PolicyRememberScope[] = permissionControl && rememberable
          ? ['session', ...(state.environment.store === undefined ? [] : ['project' as const, 'user' as const])]
          : [];
        let settle = (): void => {};
        const cancelled = new Promise<boolean>((resolve) => {
          settle = () => resolve(false);
        });
        state.asks.add(settle);
        updateWaitingForUser(state as HostSessionState, connection, true, 'approval');
        try {
          // 只有命令调用才返回命令后端和解析分段，保证进程内与按行协议的响应结构一致。
          // 同时返回所属项目和策略状态，以便客户端在切换前台会话后仍能解释本次判定。
          const request = connection.request(APPROVAL_METHOD, {
            sessionId: id, projectRoot: env.projectRoot, tool, args: input, command, reason, policy, policySource, policyForced,
            rememberable: rememberScopes.length > 0,
            rememberScopes,
            rememberHintKey: command === undefined ? 'tool' : 'command',
            ...(scriptBinding === undefined ? {} : { scriptBinding }),
            ...(shell === undefined ? {} : { shell, executable }),
          });
          return await Promise.race([
            request.then(async (answer) => {
              if (!isApproved(answer)) return false;
              const rememberScope = isRecord(answer) ? answer.rememberScope : undefined;
              if (rememberScope === undefined) return true;
              if (rememberScope !== 'session' && rememberScope !== 'project' && rememberScope !== 'user') {
                return { decision: 'deny' as const, code: 'policy_memory_unavailable', reason: 'this approval cannot store a remembered rule from this client' };
              }
              if (!rememberScopes.includes(rememberScope)) {
                return { decision: 'deny' as const, code: 'policy_memory_unavailable', reason: 'this approval cannot store a remembered rule from this client' };
              }
              try {
                await rememberPolicyRule(state as HostSessionState, tool, command, rememberScope);
                return true;
              } catch (error) {
                const failure = error instanceof KernelError ? error : new KernelError('policy_memory_write_failed', { cause: error });
                logger?.log?.('approval memory was not saved', { tool, code: failure.code });
                return { decision: 'deny' as const, code: failure.code, reason: failure.detail ?? 'the remembered rule was not saved' };
              }
            }, (error) => {
              // 记录客户端审批答复失败并拒绝调用，确保每个请求都有对应结果。
              logger?.log?.(`approval failed for ${tool}`, { tool, code: errorCode(error), reason: errorMessage(error) });
              return false;
            }),
            cancelled,
          ]);
        } finally {
          state.asks.delete(settle);
          updateWaitingForUser(state as HostSessionState, connection, false, 'approval');
        }
      },
    });
    const grant = await activeDelegation();
    if (grant !== undefined) chain.setMode(grant.defaultPolicy);
    if (initial?.policy !== undefined) chain.setMode(initial.policy);
    if (recoveredPolicyState !== undefined) {
      if (grant !== undefined) assertDelegationPolicy(grant, recoveredPolicyState.override ?? grant.defaultPolicy);
      chain.restore({ ...recoveredPolicyState, override: recoveredPolicyState.override ?? (grant?.defaultPolicy ?? null) });
    }
    const kernel = createKernel({ config, policy: chain, session, logger,
      permissionForCall: () => state.permission,
      policyOverrideForSession: () => state.policyOverride,
    });
    cleanup.push(() => managedProcesses.close());
    if (!recover && initial?.policy !== undefined) await appendPolicyState(session, chain, initial.policy);
    // 技能登记表反映已发现的技能，不随当前模式改变。
    // 优先复用加载器提供的登记表，否则从配置目录中发现技能。
    // 没有可用技能时不注册技能工具或提示词片段。
    const skills = skillRegistry ?? await discoverSkills(skillDirectories(env.projectRoot));
    for (const diagnostic of skills.diagnostics) {
      // 在加载诊断和提示词摘要中报告格式错误或被同名技能覆盖的技能。
      logger?.log?.('skill is not loaded', { code: diagnostic.code, path: diagnostic.path, reason: diagnostic.detail });
    }
    // 只有配置了 MCP Server 时才注册 MCP 工具。
    const mcp = createMcpRegistry(mcpConfigs);
    cleanup.push(() => mcp.close());
    const authorizeMcpServer = async (server: string): Promise<void> => {
      const configured = mcpConfigs.find((entry) => entry.name === server);
      if (configured === undefined) throw new KernelError('mcp_server_unknown', { detail: server });
      const currentServers = await currentMcpConfigs(env);
      await stopMcpServersWithChangedConfig(env, currentServers);
      const current = currentServers.find((entry) => entry.name === server);
      if (current === undefined || current.identityDigest !== configured.identityDigest) {
        throw new KernelError('mcp_server_config_changed', { detail: server });
      }
      const sessionTrust = state.mcpTrust.get(mcpTrustKey(server, configured.identityDigest));
      const trust = sessionTrust ?? await mcpServerTrust(mcpTrustPathOf(), env.projectRoot, server, configured.identityDigest);
      if (trust?.trusted !== true) throw new KernelError('mcp_server_untrusted', { detail: server });
      const grant = await activeDelegation();
      if (grant !== undefined) {
        await assertDelegationProject(grant, env.projectRoot);
        assertDelegationMcpServer(grant, server);
      }
    };
    const authorizeMcpTool = async (server: string, tool: string): Promise<void> => {
      await authorizeMcpServer(server);
      const grant = await activeDelegation();
      if (grant !== undefined) {
        await assertDelegationProject(grant, env.projectRoot);
        assertDelegationMcpTool(grant, `mcp:${server}/${tool}`);
      }
    };
    const mcpAuthorization: McpAuthorization = { authorizeServer: authorizeMcpServer, authorizeTool: authorizeMcpTool };
    const loaded = skills.skills.length === 0 ? plugins : [...plugins, createSkillPlugin(skills, () => mcp.servers())];
    // 加载器负责发现提示模板并处理项目优先级；模板由 Host 展开，确保所有客户端使用相同规则。
    const templates = templateRegistry ?? await discoverTemplates(templateDirectories(env.projectRoot));
    for (const diagnostic of templates.diagnostics) {
      logger?.log?.('prompt template is not loaded', { code: diagnostic.code, path: diagnostic.path, reason: diagnostic.detail });
    }
    // 根据扩展片段和当前模式选中的名称组装提示词。
    // 所有配置层都未设置基础提示词时，使用随包提供的版本。
    const prompt = createPromptAssembly({ static: config.prompt?.static ?? BASE_SYSTEM_PROMPT });
    const fragments: ExtensionPromptFragment[] = [];
    // 派生执行继承父会话的策略和静态提示词前缀，但不能再注册子 Agent。
    // 直接使用底层提供方；派生事件记录在其独立会话中。
    const basePlugins = [...loaded, createMcpPlugin(mcp, mcpAuthorization)];
    // 提问属于父会话，因为派生执行没有客户端可以回答。
    // 提问和审批走不同流程；只有支持交互回答的客户端才注册提问工具。
    const asked = interactive === false ? [] : [createAskUserPlugin({
      ask: async (questions) => {
        let settle = (): void => {};
        const cancelled = new Promise<'cancelled'>((resolve) => {
          settle = () => resolve('cancelled');
        });
        state.asks.add(settle);
        updateWaitingForUser(state as HostSessionState, connection, true, 'input');
        try {
          const outcome = await Promise.race([
            // 等待用户回答不设超时。取消使用当前轮次对应的 signal 和请求编号。
            connection.request(QUESTION_METHOD, { sessionId: id, projectRoot: env.projectRoot, questions }),
            cancelled,
          ]);
          if (outcome === 'cancelled') {
            throw new KernelError('ask_user_cancelled', { detail: `${id}: the round was cancelled while the question waited for an answer` });
          }
          return outcome;
        } catch (error) {
          if (error instanceof KernelError) throw error;
          // 明确返回客户端答复失败或通道断开；Host 不能代替用户编造答案。
          logger?.log?.('ask user request failed', { sessionId: id, code: errorCode(error), reason: errorMessage(error) ?? String(error) });
          throw new KernelError('ask_user_host_gone', { detail: `${id}: ${errorMessage(error) ?? String(error)}` });
        } finally {
          state.asks.delete(settle);
          updateWaitingForUser(state as HostSessionState, connection, false, 'input');
        }
      },
    })];
    const assembly = loadAssembly(kernel, [...basePlugins, managedProcessPlugin(managedProcesses), ...asked, createSubagentPlugin({
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
      promptFragments: () => fragments,
      promptFragmentBytes: limitsOf(config).promptFragmentBytes,
      loopLimits: sessionLoopLimits(state),
    })]);
    cleanup.push(() => assembly.dispose());
    // 加载器已按字节预算处理项目指令片段，这里直接登记，避免重复截断。
    const maxBytes = config.instructions?.maxBytes ?? DEFAULT_INSTRUCTION_BYTES;
    const instructions = await loadInstructions({
      ...config.instructions,
      boundary: env.projectRoot,
      current: resolve(env.projectRoot, config.instructions?.current ?? '.'),
    });
    prompt.fragment({ name: 'instructions', anchor: 0, text: instructions.text, maxBytes });
    // 根据预算完整加入技能元数据，或改用简短的技能发现说明。
    // 所有模式都保留技能披露工具。
    if (skills.skills.length > 0) {
      prompt.fragment({ name: 'skills', anchor: 1, text: formatSkillCatalog(skills), maxBytes: SKILL_METADATA_BUDGET_BYTES });
    }
    // 按加载器解析的来源顺序加载扩展，只提供声明过的注册、事件和能力接口。
    // 每个已注册工具仍须经过 Kernel 参数校验和权限判定。
    const extensionsEnabled = state.permission.profile === 'full-access' && state.permission.network === 'unrestricted';
    const extensionDiagnostics = extensionsEnabled ? extensions.ignored : [
      ...extensions.ignored,
      ...extensions.paths.map((path) => ({
        code: 'extension_requires_full_access', path,
        detail: 'extensions run inside the Host process and require full-access with unrestricted network permission',
      })),
    ];
    for (const diagnostic of extensionDiagnostics) {
      logger?.log?.('extension source is not loaded', { code: diagnostic.code, path: diagnostic.path, reason: diagnostic.detail });
    }
    const installedExtensions = await loadExtensions(extensionsEnabled ? extensions.paths : [], {
      registerTool: (tool) => {
        return kernel.register(checkedToolDefinition(tool));
      },
      registerFragment: (fragment) => {
        // 拒绝重复的提示片段名称，确保模式选择只会命中一个扩展。
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
      // 能力请求通过 Kernel 执行，以应用参数校验、权限判定和会话记录。
      request: (tool, args) => kernel.call(tool, args),
    });
    cleanup.push(() => installedExtensions.dispose());
    for (const diagnostic of installedExtensions.diagnostics) {
      // 扩展加载失败时撤销它的登记、记录诊断，然后继续加载其他扩展。
      logger?.log?.('extension is not loaded', { code: diagnostic.code, path: diagnostic.path, reason: diagnostic.detail });
    }
    // 应用模式时，先校验并安装新的提示片段和工具限制，再撤销旧限制。
    // 任何一步失败都保留旧模式。记录成功变更；模式只能隐藏已登记工具，不能添加工具。
    state.adopt = (file) => adoptSessionMode({
      file,
      kernel,
      prompt,
      fragments,
      promptFragmentBytes: limitsOf(config).promptFragmentBytes,
      session,
      mode: state.mode,
    });
    // 根据扩展登记的工具和提示片段校验模式选择。
    // 只有以可写方式打开会话时才恢复未完成的工具调用；只读路径不修改记录。
    if (recover) {
      const repaired = await repairUnresolvedCalls(session, { readOnly: new Set(kernel.readOnly()) });
      for (const event of repaired) logger?.log?.('unanswered tool call repaired', { sessionId: id, callId: event.callId, tool: event.tool });
    }
    // 优先采用客户端选定的模式；否则恢复记录中的模式并校验摘要。
    // 模式定义已变化时要求用户明确选择，避免静默改变可用工具。
    let wanted = initial?.mode ?? explicitMode ?? modeName;
    if (initial?.mode === undefined && explicitMode === undefined && recover && modePaths !== undefined) {
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
    if (initial?.persistGeneration === true) {
      await session.append(sessionGenerationEvent(state.generation));
    }
    if (initial?.persistLoopIterations === true && initial.loopIterations !== undefined) {
      await session.append({ kind: 'sessionLoopIterations', ignorable: true, iterations: initial.loopIterations });
    }
    // 压缩属于会话。摘要请求使用底层提供方，不向客户端转发流式内容。
    // 未配置模型上下文窗口时关闭压缩。
    const rebuildCompaction = (model: Record<string, unknown>) => {
      const selectedModel = resolveModel(model);
      const limits = compactionLimitsOf(config, selectedModel.serviceContextTokens);
      return limits === undefined ? null : createCompaction({
        provider: compactionProgressProvider(live, (event) => {
          if (state.progressId !== undefined) observeLoopProgress(state as HostSessionState, connection, state.progressId, event);
        }),
        session,
        directory,
        id,
        limits,
        logger,
        requestPrefix: () => ({ system: prompt.render(), tools: kernel.manifest() }),
      });
    };
    const compaction = rebuildCompaction(state.generation.model ?? {});
    const loopCompaction: LoopCompaction = {
      prepare: (request, signal) => state.compaction?.prepare(request, signal) ?? Promise.resolve(request.messages),
      recover: (error, request, signal) => state.compaction?.recover(error, request, signal) ?? Promise.resolve(null),
      observe: async (request, events) => {
        const current = state.compaction;
        if (current !== undefined && current !== null) await current.observe(request, events);
        else {
          const usage = usageEvent(request, events);
          if (usage !== null) await session.append(usage);
        }
      },
    };
    const loop = createLoop({
      kernel,
      provider: observedProvider(live, (event) => connection.notify({ notify: 'delta', sessionId: id, event })),
      prompt,
      session,
      limits: sessionLoopLimits(state),
      compaction: loopCompaction,
      onProgress: (event) => {
        if (state.progressId !== undefined) observeLoopProgress(state as HostSessionState, connection, state.progressId, event);
      },
      // 在轮次开始时保存有效生成设置的快照。`apiKeyEnv` 是环境变量名，不是密钥值。
      turnContext: () => {
        const model = resolveModel(state.generation.model ?? {});
        return {
          model: state.generation.provider.model ?? null,
          outputTokens: state.generation.provider.outputTokens ?? null,
          thinkingEffort: state.generation.options.thinkingEffort ?? 'default',
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
    const runDelegated: HostSessionState['runDelegated'] = async (input, options) => {
      const contract = options.delegation?.outputSchema === undefined
        ? undefined : createOutputSchemaContract(options.delegation.outputSchema);
      let structuredSubmitted = false;
      let structured: unknown;
      let disposeResultTool: (() => void) | undefined;
      let undoOutputContract = () => {};
      let undoDelegationMode = () => {};
      let delegatedMode: { source: string; name: string; layer: string; digest: string; tools: string[]; prompt: string[] } | undefined;
      try {
        if (options.delegation?.mode !== undefined) {
          const resolvedMode = await resolveModeSelection(options.delegation.mode, state.environment.modePaths);
          if (resolvedMode !== undefined) {
            const applied = applyModeToPrompt({
              file: resolvedMode.application,
              kernel,
              prompt,
              fragments,
              maxBytes: limitsOf(state.environment.config).promptFragmentBytes,
              alreadyAppliedPromptFragments: state.mode.file === undefined
                ? []
                : state.mode.file.prompt === '*' ? fragments.map((fragment) => fragment.name) : state.mode.file.prompt,
            });
            undoDelegationMode = applied.undo;
            delegatedMode = {
              source: resolvedMode.source,
              name: resolvedMode.name,
              layer: resolvedMode.layer,
              digest: applied.digest,
              tools: applied.tools,
              prompt: applied.prompt,
            };
          }
        }
        if (contract !== undefined) {
          disposeResultTool = registerDelegationResultTool(kernel, contract, (value) => {
            structured = value;
            structuredSubmitted = true;
          });
          undoOutputContract = prompt.fragment({
            name: 'delegated-output-contract',
            anchor: 1,
            text: outputSchemaInstructions(contract),
            maxBytes: MAX_DELEGATION_SCHEMA_BYTES + 1024,
          });
        }
        const result = await loop.run(input, {
          signal: options.signal,
          user: options.user,
          onProgress: options.onProgress,
          completesRun: contract === undefined ? [] : [DELEGATION_RESULT_TOOL],
          ...(contract === undefined && delegatedMode === undefined ? {} : {
            turnContext: {
              ...(delegatedMode === undefined ? {} : { delegationMode: delegatedMode }),
              ...(contract === undefined ? {} : { delegationSchemaDigest: contract.digest }),
            },
          }),
        });
        const validation = contract === undefined
          ? undefined
          : structuredSubmitted
            ? { status: 'valid' as const, schemaDigest: contract.digest }
            : { status: 'invalid' as const, schemaDigest: contract.digest, errors: ['The run ended without submitting a structured result.'] };
        return {
          ...result,
          ...(structuredSubmitted ? { structured } : {}),
          ...(validation === undefined ? {} : { validation }),
        };
      } finally {
        try { undoDelegationMode(); }
        finally {
          try { undoOutputContract(); }
          finally { disposeResultTool?.(); }
        }
      }
    };
    // 当前轮次和待处理审批都限定在所属会话内。
    return Object.assign(state, { chain, kernel, assembly, extensions: installedExtensions, mcp, loop, runDelegated, templates, compaction, rebuildCompaction });
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
    initial?: InitialSessionSettings,
  ): Promise<{ sessionId: string }> {
    if (closing !== undefined) throw new KernelError('host_closed');
    const pending = build(id, connection, recover, mode, env, workspaceOrigin, initial).then((state) => {
      sessions.set(id, state);
      return { sessionId: id };
    });
    building.add(pending);
    return pending.finally(() => building.delete(pending));
  }

  async function sessionConfiguration(state: HostSessionState): Promise<Record<string, unknown>> {
    const generationView = (generation: SessionGeneration) => ({
      model: {
        provider: typeof resolveModel(generation.model).serviceId === 'string' ? resolveModel(generation.model).serviceId : 'legacy',
        model: generation.provider.model,
      },
      thinking: {
        supported: generation.provider.thinkingCapability !== undefined,
        efforts: generation.provider.thinkingCapability?.efforts ?? [],
        defaultEffort: generation.provider.thinkingCapability?.defaultEffort ?? null,
        effort: generation.options.thinkingEffort ?? 'default',
      },
      outputTokens: generation.provider.outputTokens ?? null,
      contextTokens: generation.provider.contextTokens ?? null,
      maxOutputTokens: generation.provider.maxOutputTokens ?? null,
    });
    const latest = state.environment.store === undefined
      ? state.environment.config
      : (await state.environment.store.read()).values;
    const modelConfig = isRecord(latest.model) ? latest.model : modelConfigOf(state.environment.config);
    const services: Record<string, unknown>[] = modelServices(modelConfig.services).map((service) => ({
      id: service.id,
      name: service.name,
      api: service.api,
      models: service.models.map((model) => {
        const settings = service.modelSettings?.find((one) => one.id === model);
        const thinking = thinkingCapabilityOf(service.api, service.baseURL, model);
        return {
          id: model,
          ...(settings?.name === undefined ? {} : { name: settings.name }),
          ...(settings?.contextTokens === undefined ? {} : { contextTokens: settings.contextTokens }),
          ...(settings?.outputTokens === undefined ? {} : { outputTokens: settings.outputTokens }),
          thinking: thinking === undefined
            ? { supported: false, efforts: [], defaultEffort: null }
            : { supported: true, efforts: thinking.efforts, defaultEffort: thinking.defaultEffort },
        };
      }),
    }));
    if (typeof modelConfig.model === 'string' && typeof modelConfig.api === 'string' && typeof modelConfig.baseURL === 'string') {
      const thinking = thinkingCapabilityOf(modelConfig.api, modelConfig.baseURL, modelConfig.model);
      services.push({
        id: 'legacy', name: 'Legacy model', api: modelConfig.api,
        models: [{
          id: modelConfig.model,
          ...(typeof modelConfig.serviceContextTokens === 'number' ? { contextTokens: modelConfig.serviceContextTokens } : {}),
          ...(typeof modelConfig.outputTokens === 'number' ? { outputTokens: modelConfig.outputTokens } : {}),
          thinking: thinking === undefined
            ? { supported: false, efforts: [], defaultEffort: null }
            : { supported: true, efforts: thinking.efforts, defaultEffort: thinking.defaultEffort },
        }],
      });
    }
    const modes = state.environment.modePaths === undefined
      ? { modes: [], invalid: [], truncated: false }
      : await listModes(state.environment.modePaths);
    const pending = state.pendingGeneration === undefined && state.pending === undefined && state.pendingLoopIterations === undefined
      ? null
      : {
          mode: state.pending?.name ?? null,
          loopIterations: state.pendingLoopIterations ?? null,
          generation: state.pendingGeneration === undefined ? null : generationView(state.pendingGeneration),
        };
    return {
      sessionId: state.id,
      applies: 'unchanged',
      effective: {
        mode: state.mode.file?.name ?? null,
        loopIterations: state.loopIterations,
        policy: { mode: state.chain.mode, source: state.chain.modeSource, default: state.chain.configuredMode() },
        permission: sessionPermissionView(state, canControlPermission),
        generation: generationView(state.generation),
      },
      pending,
      available: {
        modes,
        policies: ['ask', 'auto', 'never', 'default'],
        permissionProfiles: ['read-only', 'workspace-write', 'full-access'],
        permissionNetworks: ['policy', 'unrestricted', 'disabled'],
        services,
      },
      denials: state.chain.denials(),
      delegation: knownGrant === undefined ? null : {
        grantId: knownGrant.id,
        maxPermissionProfile: knownGrant.maxPermissionProfile,
        maxNetwork: knownGrant.maxNetwork,
        allowedPolicies: knownGrant.allowedPolicies,
        allowedMcpServers: knownGrant.allowedMcpServers,
        allowedMcpTools: knownGrant.allowedMcpTools,
      },
    };
  }

  async function configureSession(state: HostSessionState, params: HostMethodParams, connection: HostClientConnection): Promise<Record<string, unknown>> {
    const modeChanged = params.mode !== undefined;
    const policyChanged = params.policy !== undefined;
    const permissionChanged = params.permissionProfile !== undefined || params.permissionNetwork !== undefined;
    const loopChanged = params.loopIterations !== undefined;
    const generationChanged = params.provider !== undefined || params.model !== undefined
      || params.thinkingEffort !== undefined || params.outputTokens !== undefined
      || params.resetModel === true || params.resetThinking === true || params.resetOutputTokens === true;
    const categories = Number(modeChanged) + Number(policyChanged) + Number(permissionChanged) + Number(loopChanged) + Number(generationChanged);
    if (categories > 1) throw new KernelError('session_configure_one_category');
    if (categories === 0) return await sessionConfiguration(state);
    if (agentControl !== undefined && !agentControl.operator) throw new KernelError('agent_control_operator_required');

    if (permissionChanged) {
      return await setPermission(state, params.permissionProfile ?? state.permission.profile,
        params.permissionNetwork, undefined, undefined, undefined, undefined);
    }

    if (modeChanged) {
      const requestedName = params.mode === 'default' ? state.environment.modeName ?? DEFAULT_MODE : requiredString(params.mode, 'mode');
      if (state.environment.modePaths === undefined) throw new KernelError('host_mode_paths_required');
      const requested = await loadMode(requestedName, state.environment.modePaths);
      const current = state.mode.file;
      let applies: 'now' | 'next_round' | 'unchanged' = 'unchanged';
      if (current?.name === requested.name && current.layer === requested.layer) {
        if (state.pending !== undefined) {
          state.pending = undefined;
          applies = state.running === undefined ? 'now' : 'next_round';
        }
      } else if (state.running === undefined) {
        await state.adopt(requested);
        applies = 'now';
      } else {
        state.pending = requested;
        applies = 'next_round';
      }
      return { ...(await sessionConfiguration(state)), applies };
    }

    if (policyChanged) {
      let nextOverride: PolicyMode | null;
      if (params.policy === 'default') {
        const grant = await activeDelegation();
        if (grant !== undefined) assertDelegationPolicy(grant, state.chain.configuredMode());
        nextOverride = null;
      } else if (params.policy === 'ask' || params.policy === 'auto' || params.policy === 'never') {
        const grant = await activeDelegation();
        if (grant !== undefined) assertDelegationPolicy(grant, params.policy);
        nextOverride = params.policy;
      }
      else throw new KernelError('policy_mode_unknown');
      await appendPolicyState(state.session, state.chain, nextOverride);
      state.policyOverride = nextOverride;
      if (nextOverride === null) state.chain.resetMode();
      else state.chain.setMode(nextOverride);
      if (agentControl !== undefined && params.policy !== 'default') {
        await recordDelegationEvent(agentControl.storePath, {
          kind: 'grant.used', grantId: agentControl.grantId, policy: params.policy as 'ask' | 'auto' | 'never',
        });
      }
      return { ...(await sessionConfiguration(state)), applies: 'next_decision' };
    }

    if (loopChanged) {
      const iterations = params.loopIterations;
      if (typeof iterations !== 'number' || !Number.isSafeInteger(iterations) || iterations < 1) {
        throw new KernelError('host_loop_limits_invalid', { detail: 'iterations must be a positive safe integer' });
      }
      if (iterations === (state.pendingLoopIterations ?? state.loopIterations)) {
        return { ...(await sessionConfiguration(state)), applies: 'unchanged' };
      }
      await state.session.append({ kind: 'sessionLoopIterations', ignorable: true, iterations });
      if (state.running === undefined) {
        state.loopIterations = iterations;
        state.pendingLoopIterations = undefined;
      } else state.pendingLoopIterations = iterations;
      return { ...(await sessionConfiguration(state)), applies: state.running === undefined ? 'now' : 'next_round' };
    }

    const hasProvider = params.provider !== undefined;
    const hasModel = params.model !== undefined;
    if (hasProvider !== hasModel) throw new KernelError('session_model_selection_invalid');
    if (params.resetModel === true && (hasProvider || hasModel)) throw new KernelError('session_configure_conflict');
    if (params.resetThinking === true && params.thinkingEffort !== undefined) throw new KernelError('session_configure_conflict');
    if (params.resetOutputTokens === true && params.outputTokens !== undefined) throw new KernelError('session_configure_conflict');

    const previous = state.pendingGeneration ?? state.generation;
    let model = previous.model;
    let explicit = previous.explicit === true;
    if (params.resetModel === true) {
      const latest = state.environment.store === undefined ? state.environment.config : (await state.environment.store.read()).values;
      model = { ...modelConfigOf(state.environment.config), ...(isRecord(latest.model) ? latest.model : {}) };
      explicit = false;
    } else if (hasProvider && hasModel) {
      const selection = modelSelection({ provider: params.provider, model: params.model });
      const latest = state.environment.store === undefined ? state.environment.config : (await state.environment.store.read()).values;
      model = { ...modelConfigOf(state.environment.config), ...(isRecord(latest.model) ? latest.model : {}), selection };
      checkedSessionModel(model, selection);
      explicit = true;
    }

    const options: { outputTokens?: number; thinkingEffort?: HostGenerationOptions['thinkingEffort'] } = { ...previous.options };
    if (params.resetOutputTokens === true) delete options.outputTokens;
    else if (params.outputTokens !== undefined) {
      if (!Number.isSafeInteger(params.outputTokens) || params.outputTokens < 1) throw new KernelError('provider_output_budget_invalid');
      options.outputTokens = params.outputTokens;
    }
    if (params.resetThinking === true || params.thinkingEffort === 'default') delete options.thinkingEffort;
    else if (params.thinkingEffort !== undefined) {
      if (!['none', 'low', 'high', 'max'].includes(params.thinkingEffort)) throw new KernelError('provider_thinking_effort_invalid');
      options.thinkingEffort = params.thinkingEffort as HostGenerationOptions['thinkingEffort'];
    }
    const provider = deriveProvider({ ...state.environment.config, model }, options);
    const generation: SessionGeneration = { provider, model, ...(explicit ? { explicit: true } : {}), options };
    const before = JSON.stringify({ model: previous.model, explicit: previous.explicit === true, options: previous.options });
    const after = JSON.stringify({ model, explicit, options });
    if (before === after) return { ...(await sessionConfiguration(state)), applies: 'unchanged' };
    const compaction = state.running === undefined ? state.rebuildCompaction(model) : undefined;
    await state.session.append(sessionGenerationEvent(generation));
    if (state.running === undefined) {
      state.generation = generation;
      state.pendingGeneration = undefined;
      state.compaction = compaction ?? null;
    } else state.pendingGeneration = generation;
    return { ...(await sessionConfiguration(state)), applies: state.running === undefined ? 'now' : 'next_round' };
  }

  async function setPermission(
    state: HostSessionState,
    profileValue: unknown,
    networkValue: unknown,
    confirmFullAccess: unknown,
    confirmNetwork: unknown,
    confirmPartialWorkspaceWrite: unknown,
    confirmWorkspaceTrust: unknown,
  ): Promise<Record<string, unknown>> {
    const grant = await activeDelegation();
    if (!permissionControl && agentControl === undefined) throw new KernelError('permission_control_unavailable');
    if (agentControl !== undefined && !agentControl.operator) throw new KernelError('agent_control_operator_required');
    if (state.permissionChanging) throw new KernelError('permission_change_in_progress', { detail: state.id });
    if (state.running !== undefined) throw new KernelError('permission_session_running', { detail: state.id });
    if (profileValue !== 'read-only' && profileValue !== 'workspace-write' && profileValue !== 'full-access') {
      throw new KernelError('permission_profile_invalid');
    }
    const network = networkValue === undefined ? state.permission.network : networkValue;
    if (network !== 'policy' && network !== 'unrestricted' && network !== 'disabled') {
      throw new KernelError('permission_network_mode_invalid');
    }
    if (grant !== undefined) {
      try { assertDelegationPermission(grant, profileValue, network); }
      catch (error) {
        await recordDelegationEvent(agentControl!.storePath, {
          kind: 'permission.denied', grantId: grant.id,
          ...(typeof profileValue === 'string' ? { permissionProfile: profileValue as PermissionProfile } : {}),
          ...(typeof network === 'string' ? { network: network as PermissionNetwork } : {}),
          code: error instanceof KernelError ? error.code : 'agent_control_permission_exceeds_grant',
        });
        throw error;
      }
    }
    if (grant === undefined && profileValue === 'full-access' && state.permission.profile !== 'full-access' && confirmFullAccess !== true) {
      throw new KernelError('permission_full_access_confirmation_required');
    }
    if (grant === undefined && network === 'unrestricted' && state.permission.network !== 'unrestricted' && confirmNetwork !== true) {
      throw new KernelError('permission_network_confirmation_required');
    }
    const confirmedPartialWorkspaceWrite = profileValue === 'workspace-write' && (grant === undefined
      ? confirmPartialWorkspaceWrite === true
        || state.permission.profile === 'workspace-write' && state.permission.partialWorkspaceWriteConfirmed
      : grant.confirmedPartialWorkspaceWrite);
    if (profileValue === 'workspace-write' && state.permission.partialWorkspaceWriteConfirmationRequired
      && !confirmedPartialWorkspaceWrite) {
      throw new KernelError('permission_partial_sandbox_confirmation_required');
    }
    if (confirmWorkspaceTrust === true && !permissionControl) {
      throw new KernelError('workspace_trust_control_unavailable');
    }
    if (confirmWorkspaceTrust === true && !state.permission.workspaceTrusted) {
      await setTrusted(state.environment.projectRoot, true);
    }
    const next = createPermissionContext(profileValue, network, state.permission.capabilities,
      permissionOptionsOf(state.permission, confirmedPartialWorkspaceWrite,
        state.permission.workspaceTrusted || confirmWorkspaceTrust === true));
    if (next.profile === state.permission.profile && next.network === state.permission.network) {
      state.permission = next;
      return { sessionId: state.id, permission: sessionPermissionView(state, canControlPermission), applies: 'unchanged' };
    }
    if (state.extensions.loaded.length > 0 && (next.profile !== 'full-access' || next.network !== 'unrestricted')) {
      throw new KernelError('permission_extension_restart_required', {
        detail: 'a loaded extension runs as trusted code in this Host process; close it before lowering this session permission',
      });
    }
    const header = await state.session.header();
    if ((header?.formatVersion ?? 0) < 2) {
      throw new KernelError('session_permission_format_unsupported', {
        detail: 'permission changes require a session record with format version 2 or newer',
      });
    }
    state.permissionChanging = true;
    try {
      if (grant !== undefined) {
        await recordDelegationEvent(agentControl!.storePath, {
          kind: 'permission.selected', grantId: grant.id, permissionProfile: next.profile, network: next.network,
        });
      }
      await state.session.append({
        kind: 'sessionPermission',
        profile: next.profile,
        network: next.network,
        source: grant === undefined ? 'trusted-ui' : 'agent-control',
        ...(grant === undefined ? {} : { grantId: grant.id }),
        confirmedFullAccess: grant === undefined
          ? next.profile === 'full-access' && state.permission.profile !== 'full-access' && confirmFullAccess === true
          : next.profile === 'full-access' && grant.confirmedFullAccess,
        confirmedNetwork: grant === undefined
          ? next.network === 'unrestricted' && state.permission.network !== 'unrestricted' && confirmNetwork === true
          : next.network === 'unrestricted' && grant.confirmedUnrestrictedNetwork,
        confirmedPartialWorkspaceWrite,
      });
      state.permission = next;
      await state.managedProcesses.stopAll();
      return { sessionId: state.id, permission: sessionPermissionView(state, canControlPermission), applies: 'now' };
    } finally {
      if (sessions.get(state.id) === state) state.permissionChanging = false;
    }
  }

  const host: Host = {
    async handle(rawMessage: Pick<HostRequest, 'method' | 'params'>, connection: HostClientConnection): Promise<unknown> {
      if (closing !== undefined) throw new KernelError('host_closed');
      const rawParams = rawMessage.params;
      validateCall(rawMessage.method, rawParams);
      const message: HostRequestWithParams = { ...rawMessage, params: rawParams };
      const { sessionId = '', input = '' } = message.params;
      const grant = await activeDelegation();
      if (grant !== undefined) {
        await assertDelegationProject(grant, message.params.projectRoot ?? defaultEnvironment.projectRoot);
        const ownedState = sessions.get(sessionId);
        if (ownedState !== undefined) await assertDelegationProject(grant, ownedState.environment.projectRoot);
      }

      switch (message.method) {
        case 'workspace.trust': {
          if (!permissionControl) throw new KernelError('workspace_trust_control_unavailable');
          if (typeof message.params.trusted !== 'boolean') throw new KernelError('protocol_args_invalid', { detail: 'trusted must be a boolean' });
          if (message.params.trusted && message.params.confirmWorkspaceTrust !== true) {
            throw new KernelError('workspace_trust_confirmation_required');
          }
          const environment = await environmentFor(message.params.projectRoot);
          await setTrusted(environment.projectRoot, message.params.trusted);
          const identity = workspaceIdentity(environment.projectRoot);
          for (const state of sessions.values()) {
            if (workspaceIdentity(state.environment.projectRoot) !== identity) continue;
            state.permission = createPermissionContext(state.permission.profile, state.permission.network, state.permission.capabilities,
              permissionOptionsOf(state.permission, state.permission.partialWorkspaceWriteConfirmed, message.params.trusted));
          }
          return { projectRoot: environment.projectRoot, trusted: message.params.trusted };
        }
        case 'session.create': {
          const id = randomUUID();
          const origin = message.params.workspaceOrigin;
          // 保留客户端是否明确选择项目这一信息；只看路径无法区分显式选择和默认项目。
          if (origin !== undefined && origin !== 'explicit' && origin !== 'default') {
            throw new KernelError('workspace_origin_unknown', { detail: `${origin}; the call takes 'explicit' or 'default', or nothing at all` });
          }
          const env = await environmentFor(message.params.projectRoot);
          const initial = await initialSessionSettings(env, message.params, grant);
          const created = await buildSession(id, connection, false, undefined, env,
            origin ?? (message.params.projectRoot === undefined ? 'default' : 'explicit'), initial);
          if (grant !== undefined) await recordDelegationEvent(agentControl!.storePath, { kind: 'grant.used', grantId: grant.id });
          await noteWorkspace(env);
          const hasInitialSettings = message.params.initialMode !== undefined || message.params.initialPolicy !== undefined
            || message.params.initialPermissionProfile !== undefined || message.params.initialPermissionNetwork !== undefined
            || message.params.confirmInitialWorkspaceTrust !== undefined
            || message.params.initialProvider !== undefined || message.params.initialModel !== undefined
            || message.params.initialThinkingEffort !== undefined || message.params.initialOutputTokens !== undefined
            || message.params.initialLoopIterations !== undefined;
          return hasInitialSettings ? { ...created, settingsApplied: true } : created;
        }
        case 'session.open': {
          // 按会话所属项目定位已打开的会话，与 `session.read` 使用相同规则。
          // 未指定项目根目录时，可能会在错误目录中查找其他项目创建的会话。
          if (sessions.has(sessionId)) {
            // 重新打开当前 Host 已拥有的会话只读状态，不得打断正在运行的轮次。
            // 会话空闲时立即应用新模式；轮次运行期间则等到边界再应用。
            const state = open(sessionId);
            if (grant !== undefined) await recordDelegationEvent(agentControl!.storePath, { kind: 'grant.used', grantId: grant.id });
            if (message.params.mode !== undefined) {
              if (state.environment.modePaths === undefined) throw new KernelError('host_mode_paths_required');
              const requested = await loadMode(message.params.mode, state.environment.modePaths);
              if (state.running === undefined) await state.adopt(requested);
              else state.pending = requested;
            }
            return { sessionId };
          }
          // 从明确选择的项目环境中解析会话记录目录和工具访问边界。
          const env = await environmentFor(message.params.projectRoot);
          // 派生会话记录是只读历史，不能恢复为可写会话；通过 `session.read` 读取。
          const branch = /^(.+)\.sub-(\d+)$/.exec(sessionId);
          if (branch !== null) {
            throw new KernelError('session_is_branch', { detail: `${sessionId} is a derived branch of ${branch[1]}; open the parent, or read that record with session.read` });
          }
          // 会话不存在时不要创建空记录，避免把打开失败误报为恢复成功。
          // 先校验编号，保留格式错误对应的错误码。
          const path = recordPathOf(sessionId, env);
          try {
            await access(path);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            const filename = `${sessionId}.jsonl`;
            const legacy = sessionDirectories(env.config).slice(1);
            let legacyRecord = false;
            for (const directory of legacy) {
              try {
                await access(join(directory, filename));
                legacyRecord = true;
                break;
              } catch (legacyError) {
                if ((legacyError as NodeJS.ErrnoException).code !== 'ENOENT') throw legacyError;
              }
            }
            if (!legacyRecord) throw new KernelError('session_not_found', { detail: sessionId });
            const adopted = await adoptForSessionDirectory(env.config, env.directory, env.projectRoot, sessionId);
            if (adopted?.busy.includes(filename)) throw new KernelError('session_locked', { detail: sessionId });
            if (adopted?.conflicts.includes(filename)) {
              throw new KernelError('session_adoption_write_failed', { detail: `${sessionId}: existing legacy records conflict` });
            }
            try {
              await access(path);
            } catch (adoptionError) {
              if ((adoptionError as NodeJS.ErrnoException).code !== 'ENOENT') throw adoptionError;
              throw new KernelError('session_not_found', { detail: sessionId });
            }
          }
          // 新打开的会话也在轮次边界应用模式变更。
          const opened = await buildSession(sessionId, connection, true, message.params.mode, env);
          if (grant !== undefined) await recordDelegationEvent(agentControl!.storePath, { kind: 'grant.used', grantId: grant.id });
          await noteWorkspace(env);
          return opened;
        }
        case 'session.close': {
          const state = open(sessionId);
          // 关闭前必须由客户端明确取消运行中的轮次，确保结果已记录。
          if (state.permissionChanging) throw new KernelError('permission_change_in_progress', { detail: sessionId });
          if (state.running !== undefined) throw new KernelError('run_already_running', { detail: sessionId });
          await retire(state);
          evictEnvironment(state.environment);
          return { sessionId };
        }
        case 'session.label': {
          const state = open(sessionId);
          const { name, archived } = message.params;
          // 请求没有造成变化时不写入会话事件。
          if (name === undefined && archived === undefined) throw new KernelError('session_label_empty', { detail: sessionId });
          const trimmed = name?.trim() ?? '';
          // 会话名称会显示在列表中，因此拒绝控制字符和纯空白名称。
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
          // 分支只复制已经写入的记录；父会话之后产生的事件仍留在父记录中。
          // 新分支首次打开时，在自己的记录锁内恢复未完成调用。
          const state = sessions.get(sessionId);
          assertSessionId(sessionId);
          const env = state?.environment ?? await environmentFor(message.params.projectRoot);
          return await branchSession(env.directory, sessionId, { at: message.params.at, projectRoot: env.projectRoot });
        }
        case 'sessions.list': {
          // 当前与旧目录都只读扫描；迁移只在用户明确打开旧会话时发生。
          const { projectRoot, limit } = message.params;
          const scope = projectRoot ?? defaultEnvironment.projectRoot;
          const config = await readOnlySessionConfig(scope);
          return { sessions: await listWorkspaceSessions(config, { projectRoot: scope, limit }) };
        }
        case 'sessions.search': {
          // 搜索会话列表使用的同一目录，并在扫描记录前拒绝空查询。
          const { projectRoot, sessionId: scoped, limit } = message.params;
          const needle = requiredString(message.params.query, 'query').trim();
          if (needle === '') throw new KernelError('search_query_empty', { detail: 'a search query has to say what to look for' });
          // 在所选会话的项目目录中搜索完整记录，包括溢出文件。
          // 解析记录路径前先校验会话编号。
          if (scoped !== undefined) assertSessionId(scoped);
          const open = scoped === undefined ? undefined : sessions.get(scoped);
          const scope = projectRoot ?? defaultEnvironment.projectRoot;
          const config = open?.environment.config ?? await readOnlySessionConfig(scope);
          return {
            hits: await searchSessionDirectories(sessionDirectories(config), {
              query: needle,
              sessionId: scoped,
              projectRoot: open === undefined ? scope : undefined,
              limit,
            }),
          };
        }
        case 'paths.list': {
          // 由 Host 查找 `@` 文件候选，前端不直接扫描项目文件。
          // 加载所选项目环境；无法加载时返回 `host_project_root_unsupported`。
          const { projectRoot, query, limit } = message.params;
          const env = await environmentFor(projectRoot);
          return await listProjectFiles(env.projectRoot, typeof query === 'string' ? query : '', limit);
        }
        case 'session.read': {
          // 返回已持久化记录，让客户端重连后可以恢复会话内容。
          // `limit` 和 `before` 用于分页，`at` 指定一条事件；派生会话也走同一读取流程。
          return await readRecord(sessionId, message.params);
        }
        case 'session.observe': {
          const env = await environmentFor(requiredString(message.params.projectRoot, 'projectRoot'));
          const path = recordPathOf(sessionId, env);
          try { await access(path); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new KernelError('session_not_found', { detail: sessionId });
            throw error;
          }
          const opened = sessions.get(sessionId);
          const snapshot = await readForClient(opened?.session ?? createSessionLog({ directory: env.directory, id: sessionId }), sessionId, {
            fullResults: message.params.fullResults,
            ...(message.params.limit === undefined ? {} : { limit: message.params.limit as number }),
            ...(message.params.before === undefined ? {} : { before: message.params.before as number }),
            ...(message.params.at === undefined ? {} : { at: message.params.at as number }),
          }, env);
          return { ...snapshot, writerActive: opened?.running !== undefined || await sessionWriterActive(path) };
        }
        case 'session.control': {
          const env = await environmentFor(requiredString(message.params.projectRoot, 'projectRoot'));
          return await requestAgentControl(env.projectRoot, sessionId, message.params.request as AgentControlRequest);
        }
        case 'session.export': {
          // Host 负责读取和排版完整记录并写出文件，客户端只选择目标路径。
          // 用户通过保存对话框选择的导出路径不属于模型工具写入，不受项目边界限制。
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
            // 先确定导出快照的末尾序号，避免读取期间追加的新事件混入本次导出。
            unfinished: sessions.get(sessionId)?.running !== undefined,
          });
          // 同时导出父会话记录引用的派生会话内容。
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
            // 对每个导出文件分别返回结果，包括路径冲突和写入失败，并附上主文件路径。
            const done = await writeExport(requiredString(message.params.path, 'path'), main, branches);
            return { written: done.written, skipped: [...skipped, ...done.skipped], failed: done.failed };
          } catch (cause) {
            if (cause instanceof KernelError) throw cause;
            // 无法创建目标目录时，报告整批导出尚未开始。
            throw new KernelError('host_export_write_failed', { cause, detail: `${message.params.path}: ${errorMessage(cause) ?? String(cause)}` });
          }
        }
        case 'run.start': {
          const state = open(sessionId);
          return await execute(state, async (signal, report) => {
          // 开始轮次前展开提示模板，同时保留原始输入和模板元数据。
          // 未知模板命令应返回错误，不能把未展开的文本发送给模型。
          const invocation = parseInvocation(input);
          let text = input;
          const origin = message.params.origin;
          if (origin !== undefined && origin !== 'human' && origin !== 'controller') throw new KernelError('protocol_args_invalid', { detail: 'origin must be human or controller' });
          let user: Record<string, unknown> = { origin: origin ?? 'human' };
          if (invocation !== undefined) {
            const expanded = await expandTemplate(findTemplate(state.templates, invocation.command), invocation.arguments);
            text = expanded.text;
            user = { ...user, raw: input, arguments: expanded.arguments, source: expanded.source, digest: expanded.digest };
          }
          return await state.runDelegated(text, {
            signal, user, onProgress: report, delegation: message.params.delegation,
          });
          }, connection);
        }
        case 'run.cancel': {
          const state = open(sessionId);
          if (state.running === undefined) throw new KernelError('run_not_running', { detail: sessionId });
          // 通过当前循环处理取消，让工具和模型请求收到同一个取消信号。
          state.running.abort();
          await state.managedProcesses.stopAll();
          return { cancelled: true };
        }
        case 'policy.set': {
          // 只修改会话级策略覆盖，不改写配置中的默认值。
          const mode = requiredString(message.params.mode, 'mode');
          return await serializeSessionConfiguration(sessionId, async () => {
            const state = open(sessionId);
            await configureSession(state, { policy: mode }, connection);
            return { policy: state.chain.mode, policySource: state.chain.modeSource, policyDefault: state.chain.configuredMode() };
          });
        }
        case 'permission.set': {
          return await serializeSessionConfiguration(sessionId, () => setPermission(
            open(sessionId),
            message.params.permissionProfile,
            message.params.permissionNetwork,
            message.params.confirmFullAccess,
            message.params.confirmNetwork,
            message.params.confirmPartialWorkspaceWrite,
            message.params.confirmWorkspaceTrust,
          ));
        }
        case 'mode.set': {
          const name = requiredString(message.params.name, 'name');
          return await serializeSessionConfiguration(sessionId, async () => {
            const state = open(sessionId);
            await configureSession(state, { mode: name }, connection);
            return {
              mode: state.mode.file?.name ?? null,
              layer: state.mode.file?.layer ?? null,
              pending: state.pending?.name ?? null,
              tools: state.kernel.manifest().map((entry) => entry.name),
            };
          });
        }
        case 'status.get': {
          const state = open(sessionId);
          return {
            sessionId,
            running: state.running !== undefined,
            progress: state.progress ?? null,
            // 只返回当前模式可用的工具，不返回全部已登记工具。
            tools: state.kernel.manifest().map((entry) => entry.name),
            mode: state.mode.file?.name ?? null,
            modeLayer: state.mode.file?.layer ?? null,
            pendingMode: state.pending?.name ?? null,
            // 返回会话当前使用的模型，以及等待下一轮边界生效的设置。
            model: state.generation.provider.model ?? null,
            outputTokens: state.generation.provider.outputTokens ?? null,
            selectedModel: modelSelectionOf(state.generation.model)?.model ?? state.generation.provider.model ?? null,
            serviceId: modelSelectionOf(state.generation.model)?.provider ?? resolveModel(state.generation.model).serviceId ?? 'legacy',
            pendingServiceId: state.pendingGeneration === undefined ? null : modelSelectionOf(state.pendingGeneration.model)?.provider ?? null,
            pendingModel: state.pendingGeneration?.provider.model ?? null,
            contextTokens: state.generation.provider.contextTokens ?? null,
            thinking: {
              available: state.generation.provider.thinkingCapability?.efforts ?? [],
              defaultEffort: state.generation.provider.thinkingCapability?.defaultEffort ?? null,
              effective: state.generation.options.thinkingEffort ?? 'default',
              pending: state.pendingGeneration?.options.thinkingEffort ?? null,
            },
            // 分别返回当前模式和策略，并说明策略来自配置默认值还是会话覆盖。
            policy: state.chain.mode,
            policySource: state.chain.modeSource,
            policyDefault: state.chain.configuredMode(),
            permission: sessionPermissionView(state, canControlPermission),
            denials: state.chain.denials(),
            delegation: knownGrant === undefined ? null : {
              grantId: knownGrant.id,
              maxPermissionProfile: knownGrant.maxPermissionProfile,
              maxNetwork: knownGrant.maxNetwork,
              allowedPolicies: knownGrant.allowedPolicies,
              allowedMcpServers: knownGrant.allowedMcpServers,
              allowedMcpTools: knownGrant.allowedMcpTools,
            },
            // 这里只返回条数；记录内容由 `session.read` 提供。
            eventCount: (await state.session.read()).length,
            // 返回工具名称、说明和参数模式，供客户端选择工具。
            templates: state.templates.templates.map(({ command, description, hint }) => ({ command, description, hint })),
            // 返回上下文窗口、压力阈值、投影 Token 数和提供方最近报告的用量。
            // 模型窗口未知时返回 null，因为此时无法估算上下文压力。
            usage: state.compaction === null ? null : await state.compaction.context(),
          };
        }
        case 'session.configure': {
          return await serializeSessionConfiguration(sessionId, () => configureSession(open(sessionId), message.params, connection));
        }
        case 'workspaces.list':
          // 返回持久工作区登记表及默认工作区身份，供客户端显示。
          return await readRegistry();
        case 'workspace.default.set': {
          // 空身份用于清除默认工作区。校验指定路径，并分别报告路径不存在、目标不是目录和目录不可读。
          const directory = String(message.params.directory).trim();
          if (directory === '') return await setDefaultWorkspace(null);
          await classifyProjectRoot(resolve(directory));
          return await setDefaultWorkspace(directory, { name: message.params.name });
        }
        case 'workspace.remove': {
          const directory = message.params.directory;
          if (typeof directory !== 'string' || directory.trim() === '') throw new KernelError('workspace_directory_required');
          const identity = workspaceIdentity(directory);
          // 运行中的会话继续使用原工作区；先等该轮结束，再从登记表移除。
          const running = [...sessions.values()].find((state) => workspaceIdentity(state.environment.projectRoot) === identity && state.running !== undefined);
          if (running !== undefined) throw new KernelError('workspace_in_use', { detail: directory });
          return await unregisterWorkspace(directory);
        }
        case 'history.read':
          // 偏好文件路径由 Host 管理，客户端不能指定数据根目录下的任意文件。
          return { entries: await loadHistory() };
        case 'history.append': {
          // 将最新发送的输入放在最前面，删除重复项，并裁剪到配置的条数上限。
          // 返回在锁内完成读—改—写后的结果。
          return { entries: await rememberHistory(historyPathOf(), [String(message.params.text)]) };
        }
        case 'model.select': {
          const selection = modelSelection({ provider: message.params.provider, model: message.params.model });
          return await serializeSessionConfiguration(sessionId, async () => {
            const state = open(sessionId);
            await configureSession(state, { provider: selection.provider, model: selection.model }, connection);
            const generation = state.pendingGeneration ?? state.generation;
            return { model: generation.provider.model, serviceId: selection.provider, when: state.running === undefined ? 'now' : 'round' };
          });
        }
        case 'models.discover': {
          // 已保存密钥只能用于绑定的服务；未保存的服务必须明确提供临时密钥。
          if (message.params.temporaryKey === undefined) {
            const env = await environmentFor(message.params.projectRoot);
            // 项目配置可以引用环境变量，但不能据此授权读取系统凭据。
            // 只信任用户配置中的服务绑定；项目、本地和命令行覆盖必须使用临时密钥。
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
          // 桌面草稿和偏好文件由 Host 管理。
          return await readPrefs();
        case 'prefs.write': {
          const value = parsePrefsJson(String(message.params.json));
          return await savePrefs(prefsPathOf(), value, { version: requiredString(message.params.version, 'version') });
        }
        case 'agent-control.list': {
          if (!permissionControl) throw new KernelError('agent_control_trusted_ui_required');
          return await listDelegationGrants(delegationPathOf());
        }
        case 'agent-control.create': {
          if (!permissionControl) throw new KernelError('agent_control_trusted_ui_required');
          if (message.params.confirmWorkspaceTrust !== true) throw new KernelError('workspace_trust_confirmation_required');
          if (permission.partialWorkspaceWriteConfirmationRequired
            && (message.params.maxPermissionProfile === 'workspace-write' || message.params.maxPermissionProfile === 'full-access')
            && message.params.confirmPartialWorkspaceWrite !== true) {
            throw new KernelError('permission_partial_sandbox_confirmation_required');
          }
          const projectRoot = requiredString(message.params.projectRoot, 'projectRoot');
          const project = await environmentFor(projectRoot);
          await setTrusted(project.projectRoot, true);
          const projectIdentity = workspaceIdentity(project.projectRoot);
          for (const state of sessions.values()) {
            if (workspaceIdentity(state.environment.projectRoot) !== projectIdentity) continue;
            state.permission = createPermissionContext(state.permission.profile, state.permission.network, state.permission.capabilities,
              permissionOptionsOf(state.permission, state.permission.partialWorkspaceWriteConfirmed, true));
          }
          const input: CreateDelegationGrantInput = {
            name: requiredString(message.params.grantName, 'grantName'),
            projectRoot: project.projectRoot,
            defaultPermissionProfile: message.params.defaultPermissionProfile as PermissionProfile,
            maxPermissionProfile: message.params.maxPermissionProfile as PermissionProfile,
            defaultNetwork: message.params.defaultNetwork as PermissionNetwork,
            maxNetwork: message.params.maxNetwork as PermissionNetwork,
            defaultPolicy: message.params.defaultPolicy as CreateDelegationGrantInput['defaultPolicy'],
            allowedPolicies: [
              ...(message.params.allowedPolicyAsk === true ? ['ask' as const] : []),
              ...(message.params.allowedPolicyAuto === true ? ['auto' as const] : []),
              ...(message.params.allowedPolicyNever === true ? ['never' as const] : []),
            ],
            allowOperator: message.params.allowOperator as boolean,
            allowedMcpServers: message.params.allowedMcpServers as string[] | undefined,
            allowedMcpTools: message.params.allowedMcpTools as string[] | undefined,
            confirmFullAccess: message.params.confirmFullAccess as boolean,
            confirmUnrestrictedNetwork: message.params.confirmUnrestrictedNetwork as boolean,
            confirmPartialWorkspaceWrite: message.params.confirmPartialWorkspaceWrite === true,
            expiresAt: message.params.expiresAt === '' ? null : requiredString(message.params.expiresAt, 'expiresAt'),
          };
          return await createDelegationGrant(delegationPathOf(), input, requiredString(message.params.version, 'version'));
        }
        case 'agent-control.revoke': {
          if (!permissionControl) throw new KernelError('agent_control_trusted_ui_required');
          const grantId = requiredString(message.params.grantId, 'grantId');
          const result = await revokeDelegationGrant(
            delegationPathOf(), grantId, requiredString(message.params.version, 'version'),
          );
          await Promise.all([...sessions.values()]
            .filter((state) => state.managedGrantId === grantId)
            .map((state) => state.managedProcesses.stopAll()));
          return result;
        }
        case 'mcp.trust.list': {
          if (!permissionControl) throw new KernelError('mcp_trust_trusted_ui_required');
          const env = await environmentFor(message.params.projectRoot);
          const session = message.params.sessionId === undefined ? undefined : open(requiredString(message.params.sessionId, 'sessionId'));
          if (session !== undefined && session.environment !== env) throw new KernelError('session_project_forbidden');
          const configuredServers = await currentMcpConfigs(env);
          await stopMcpServersWithChangedConfig(env, configuredServers);
          const store = await listMcpTrust(mcpTrustPathOf());
          const servers = await Promise.all(configuredServers.map(async (server) => {
            const sessionTrust = session?.mcpTrust.get(mcpTrustKey(server.name, server.identityDigest));
            const projectIdentity = workspaceIdentity(await realpath(env.projectRoot));
            const projectTrust = store.entries.find((entry) => entry.scope === 'project' && entry.projectIdentity === projectIdentity
              && entry.server === server.name && entry.identityDigest === server.identityDigest);
            const userTrust = store.entries.find((entry) => entry.scope === 'user'
              && entry.server === server.name && entry.identityDigest === server.identityDigest);
            const scopes = {
              session: sessionTrust === undefined ? null : { source: sessionTrust.source, trusted: sessionTrust.trusted, updatedAt: sessionTrust.updatedAt },
              project: projectTrust === undefined ? null : { source: projectTrust.source, trusted: projectTrust.trusted, updatedAt: projectTrust.updatedAt },
              user: userTrust === undefined ? null : { source: userTrust.source, trusted: userTrust.trusted, updatedAt: userTrust.updatedAt },
            };
            const trust = scopes.session !== null ? { scope: 'session' as const, ...scopes.session }
              : scopes.project !== null ? { scope: 'project' as const, ...scopes.project }
                : scopes.user !== null ? { scope: 'user' as const, ...scopes.user }
                  : undefined;
            return {
              name: server.name,
              command: server.command,
              args: server.args,
              cwd: server.cwd,
              environmentNames: server.environmentNames,
              identityDigest: server.identityDigest,
              trustScopes: scopes,
              trust: trust === undefined ? null : { scope: trust.scope, source: trust.source, trusted: trust.trusted, updatedAt: trust.updatedAt },
            };
          }));
          return { version: store.version, servers };
        }
        case 'mcp.trust.set': {
          if (!permissionControl) throw new KernelError('mcp_trust_trusted_ui_required');
          const env = await environmentFor(message.params.projectRoot);
          const serverName = requiredString(message.params.server, 'server');
          const expectedIdentity = requiredString(message.params.identityDigest, 'identityDigest');
          const configuredServers = await currentMcpConfigs(env);
          await stopMcpServersWithChangedConfig(env, configuredServers);
          const server = configuredServers.find((item) => item.name === serverName);
          if (server === undefined) throw new KernelError('mcp_server_unknown', { detail: serverName });
          if (server.identityDigest !== expectedIdentity) throw new KernelError('mcp_server_config_changed', { detail: serverName });
          const scope = requiredString(message.params.scope, 'scope');
          if (scope !== 'session' && scope !== 'project' && scope !== 'user') throw new KernelError('mcp_trust_scope_invalid');
          if (typeof message.params.trusted !== 'boolean') throw new KernelError('protocol_args_invalid', { detail: 'trusted must be a boolean' });
          if (message.params.trusted && (message.params.confirmTrust !== true || message.params.confirmExternalAccess !== true)) {
            throw new KernelError('mcp_trust_confirmation_required');
          }
          if (scope === 'session') {
            const sessionId = requiredString(message.params.sessionId, 'sessionId');
            const state = open(sessionId);
            if (state.environment !== env) throw new KernelError('session_project_forbidden');
            const sessionServer = state.environment.mcpConfigs.find((item) => item.name === serverName);
            if (sessionServer?.identityDigest !== server.identityDigest) throw new KernelError('mcp_session_config_stale');
            const updatedAt = new Date().toISOString();
            await state.session.append({
              kind: 'sessionMcpTrust', ignorable: true, server: serverName, identityDigest: server.identityDigest,
              source: 'trusted-ui', trusted: message.params.trusted, updatedAt,
            });
            state.mcpTrust.set(mcpTrustKey(serverName, server.identityDigest), { source: 'trusted-ui', trusted: message.params.trusted, updatedAt });
            if (!message.params.trusted) await state.mcp.revoke(serverName);
            return { scope, server: serverName, trusted: message.params.trusted, updatedAt };
          }

          const store = await setMcpServerTrust(mcpTrustPathOf(), {
            scope: scope as McpTrustScope,
            projectRoot: env.projectRoot,
            server: serverName,
            identityDigest: server.identityDigest,
            trusted: message.params.trusted,
          }, requiredString(message.params.version, 'version'));
          if (!message.params.trusted) {
            for (const state of sessions.values()) {
              const current = state.environment.mcpConfigs.find((item) => item.name === serverName);
              if (current === undefined) continue;
              if (scope === 'project' && state.environment !== env) continue;
              if (scope === 'user' && current.identityDigest !== server.identityDigest) continue;
              const sessionTrust = state.mcpTrust.get(mcpTrustKey(serverName, current.identityDigest));
              const effective = sessionTrust ?? await mcpServerTrust(mcpTrustPathOf(), state.environment.projectRoot, serverName, current.identityDigest);
              if (effective?.trusted !== true) await state.mcp.revoke(serverName);
            }
          }
          return { version: store.version, scope, server: serverName, trusted: message.params.trusted };
        }
        case 'mcp.trust.tools': {
          if (!permissionControl) throw new KernelError('mcp_trust_trusted_ui_required');
          const env = await environmentFor(message.params.projectRoot);
          const serverName = requiredString(message.params.server, 'server');
          const configuredServers = await currentMcpConfigs(env);
          await stopMcpServersWithChangedConfig(env, configuredServers);
          const server = configuredServers.find((item) => item.name === serverName);
          if (server === undefined) throw new KernelError('mcp_server_unknown', { detail: serverName });
          const session = message.params.sessionId === undefined ? undefined : open(requiredString(message.params.sessionId, 'sessionId'));
          if (session !== undefined && session.environment !== env) throw new KernelError('session_project_forbidden');
          if (session !== undefined) {
            const sessionServer = session.environment.mcpConfigs.find((item) => item.name === serverName);
            if (sessionServer?.identityDigest !== server.identityDigest) throw new KernelError('mcp_session_config_stale');
          }
          const sessionTrust = session?.mcpTrust.get(mcpTrustKey(serverName, server.identityDigest));
          const trust = sessionTrust ?? await mcpServerTrust(mcpTrustPathOf(), env.projectRoot, serverName, server.identityDigest);
          if (trust?.trusted !== true) throw new KernelError('mcp_server_untrusted', { detail: serverName });
          const registry = createMcpRegistry([server]);
          try {
            const tools = await registry.toolsOf(serverName);
            return { server: serverName, identityDigest: server.identityDigest, tools: tools.map(({ name, description, digest }) => ({ name, description, digest })) };
          } finally {
            await registry.close();
          }
        }
        case 'config.get': {
          // 使用明确的允许字段构造响应；参数模式本身允许出现未声明的属性。
          // 项目配置是不可信输入，可能包含凭据或其他私密内容。
          // 同一遍读取值、来源和文件版本，确保客户端得到一致快照。
          // 只读取所选项目的可写配置层。请求携带项目身份，响应不返回项目路径。
          const env = await environmentFor(message.params.projectRoot);
          if (env.store === undefined) return {
            ...shownConfigOf(env.config),
            services: modelServices(env.config.model?.services),
            selection: env.config.model?.selection === undefined ? null : modelSelection(env.config.model.selection),
            layers: [], sources: {},
          };
          const { layers, sources, values, rules, ruleSources, ruleLayers, rulesSource } = await env.store.read();
          return {
            ...shownConfigOf(values),
            services: modelServices(values.model?.services),
            selection: values.model?.selection === undefined ? null : modelSelection(values.model.selection),
            // 返回配置中的默认策略；`status.get` 返回会话当前生效的策略。
            policyMode: values.policy.mode,
            layers,
            sources,
            rules,
            ruleSources,
            ruleLayers,
            rulesSource,
          };
        }
        case 'config.set': {
          // 配置存储负责允许字段、值校验和配置层到文件的映射；Host 只转发这些字段。
          if (defaultEnvironment.store === undefined) throw new KernelError('config_write_unsupported');
          const { value, op, index, ruleTool, ruleDecision, ruleMatch, ruleReason } = message.params;
          const field = requiredString(message.params.field, 'field');
          const layer = requiredString(message.params.layer, 'layer');
          const version = requiredString(message.params.version, 'version');
          // 协议层校验字段类型，`checkedRule` 校验规则内容。
          const given = { tool: ruleTool, decision: ruleDecision, match: ruleMatch, reason: ruleReason };
          const rule = Object.values(given).every((item) => item === undefined) ? undefined : given;
          const env = await environmentFor(message.params.projectRoot);
          if (env.store === undefined) throw new KernelError('config_write_unsupported');
          const { key, table, shadowed, shadowedBy, changed, effective, layers, ...saved } = await env.store.write({ layer, field, value, version, op, index, rule }, async (candidate, editedLayer) => {
            if (!field.startsWith('model.')) return;
            if (layer === 'user') hostProviderFromConfig(createConfig({ user: editedLayer }));
            for (const target of layer === 'user' ? [...environments.values()] : [env]) {
              if (target.store === undefined) continue;
              const own = target === env ? candidate : await target.store.preview(layer, editedLayer);
              const config = { ...target.config, ...own };
              // 首次设置允许逐项填写未完成的模型配置；完整配置中的能力错误必须在写入前拒绝。
              hostProviderFromConfig(config);
              if (field === 'model.selection') deriveProvider(config);
              if (field === 'model.services' && isRecord(config.model)) {
                if (config.model.selection !== undefined) resolveModel(config.model);
                for (const service of modelServices(config.model.services)) {
                  for (const setting of service.modelSettings ?? []) {
                    deriveProvider({
                      ...config,
                      model: { ...config.model, selection: { provider: service.id, model: setting.id } },
                    });
                  }
                }
              }
              if (field !== 'model.outputTokens' && field !== 'model.services') continue;
              for (const state of sessions.values()) {
                if (state.environment !== target) continue;
                const generation = state.pendingGeneration ?? state.generation;
                if (generation.explicit !== true) continue;
                if (field === 'model.services' && modelSelectionOf(generation.model)?.provider === 'legacy') continue;
                const key = field === 'model.outputTokens' ? 'outputTokens' : 'services';
                const effective = isRecord(config.model) ? config.model[key] : undefined;
                deriveProvider({ ...config, model: { ...generation.model, [key]: effective } }, generation.options);
              }
            }
          });
          // 按配置层优先级计算写入后的有效模型服务设置。
          // 返回立即采用变更的会话；其他会话在下一轮边界采用。
          // 更高优先级配置覆盖本次写入时，不改变会话，并说明覆盖来源。
          // 策略和审批规则变更从下一次判定开始生效。
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
          // 压缩只影响下一次请求的上下文，无法改变已经发出的请求。
          if (state.running !== undefined) throw new KernelError('compact_turn_running', { detail: sessionId });
          if (state.compaction === null) {
            throw new KernelError('compact_window_unset', { detail: 'limits.contextTokens is not written, so there is no window to compact against' });
          }
          return await execute(state, async (signal) => {
          const compaction = state.compaction;
          if (compaction === null) throw new KernelError('compact_window_unset');
          const done = await compaction.compactNow(signal);
          // 保留预算后找不到可用事件边界时，返回无法压缩的结果。
          if (done === null) throw new KernelError('compact_nothing_to_cut', { detail: sessionId });
          return { sessionId, ...done };
          }, connection, 'compaction');
        }
        default:
          // 执行到此处说明分发表与协议中的方法定义不一致。
          throw new KernelError('protocol_method_unhandled', { detail: message.method });
      }
    },

    // 连接断开时取消该连接正在运行的轮次，并按加载顺序的逆序释放插件。
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

// Electron Main 和脚本使用的标准输入输出传输层；双方每行交换一个 JSON 帧。
export function serveHost({ input = process.stdin, output = process.stdout, config, ...rest }: HostOptions & { input?: Readable; output?: Writable }): Host {
  const host = createHost({ config, ...rest });
  const connection = createConnection({
    input,
    output,
    // 格式错误的帧属于连接错误，不是某个请求失败；将错误交给客户端决定是否重连。
    onFault: (error) => connection.notify({ notify: 'fault', code: errorCode(error), detail: errorDetail(error) }),
    onClose: () => {
      void host.release().catch((error: unknown) => rest.logger?.error?.('host release failed', { code: errorCode(error), detail: errorMessage(error) }));
    },
  });
  connection.onRequest((message) => host.handle(message, connection));
  return host;
}
