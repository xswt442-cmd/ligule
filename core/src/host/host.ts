// Host 管理会话、Agent 循环、工具和策略状态；客户端通过协议与它通信。
// 模型提供方与策略由外部注入，会话事件通过会话记录接口持久化。
import { createHash, randomUUID } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import { mkdirSync } from 'node:fs';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { KernelError } from '../kernel/error.js';
import { SETTLE_GRACE_MS, settleWithin } from '../kernel/settle.js';
import { createTaskBudget, type TaskBudget, type TaskWork } from '../kernel/task-budget.js';
import { currentKernelExecutionContext, withKernelExecutionContext, withoutKernelExecutionContext } from '../kernel/execution-context.js';
import {
  assertDelegationCompletion, createOutputSchemaContract, DELEGATION_RESULT_TOOL, MAX_DELEGATION_SCHEMA_BYTES, outputSchemaInstructions,
  registerDelegationResultTool, completedRunResult, failedRunResult, structuredOutputDigest,
  type DelegationSpec,
} from '../delegation.js';
import {
  assertDelegationMcpServer, assertDelegationMcpTool, assertDelegationMode, assertDelegationModelSelection, assertDelegationPermission,
  assertDelegationPolicy, boundedOutputTokens, createDelegationGrant, delegationPathOf,
  listDelegationGrants, recordDelegationEvent, revokeDelegationGrant,
  type CreateDelegationGrantInput, type DelegationGrant, type DelegationPolicy,
} from './agent-control.js';
import { mcpServerTrust, mcpTrustKey, mcpTrustPathOf } from './mcp-trust.js';
import { createPermissionContext, DEFAULT_PERMISSION_CONTEXT, permissionDenial, type PermissionContext, type PermissionContextOptions, type PermissionNetwork, type PermissionProfile } from '../kernel/permission.js';
import { createKernel, type Kernel } from '../kernel/kernel.js';
import { createFileWriteQueue } from '../kernel/file-write-queue.js';
import { loadAssembly, type Plugin } from '../kernel/assembly.js';
import {
  completeExtensionRun, loadExtensions, prepareExtensionRequest,
  type ExtensionHookRegistry,
} from '../kernel/extensions.js';
import { applyModeToPrompt, DEFAULT_MODE, listModes, loadMode, resolveModeSelection } from '../kernel/modes.js';
import { agentPresetDirectories } from '../kernel/agent-presets.js';
import { registerWorkspace, workspaceIdentity } from '../kernel/workspace.js';
import { isTrusted, setTrusted } from '../kernel/workspace-trust.js';
import { credentialStatus, deleteCredential, storeCredential } from '../kernel/credentials.js';
import { modelServices, modelSelection, resolveModel, type ModelSelection } from '../kernel/model-services.js';
import { POLICY_SEMANTICS, createDecisionChain, isPolicyMode, isPolicyRule, policyArgsHash, readPersistedPolicyMode, readPolicyMode, type DecisionChain, type PolicyAskResult, type PolicyMode, type PolicyState } from '../kernel/policy.js';
import { createPromptAssembly } from '../kernel/prompt.js';
import { BASE_SYSTEM_PROMPT } from '../kernel/base-prompt.js';
import { createSessionLog, type SessionLog } from '../session/session.js';
import { publishRunResult, type RunAcceptance } from '../session/run.js';
import type { SessionEvent } from '../session/format.js';
import { chooseResumeMode, sessionDirectories, sessionDirectory } from '../session/list.js';
import { adoptForSessionDirectory } from '../session/adopt.js';
import { readConfig, writeConfig } from './handlers/config.js';
import { createMcpExtensionHandlers } from './handlers/mcp-extensions.js';
import { handleProjectRequest } from './handlers/project.js';
import { createRunSubmissionHandler, handleRunRequest, runOriginOf } from './handlers/run.js';
import { createSessionHandlers } from './handlers/session.js';
import { handleSubrunRequest } from './handlers/subrun.js';
import { createWorkspacePrefsHandlers } from './handlers/workspace-prefs.js';
import { listProjectDirectory, readProjectFile } from './project-files.js';
import { projectGitDiffVersion, readProjectGitDiff } from './project-git.js';
import { compactionLimitsOf, loopLimitsOf, sessionLoopLimits, taskLimitsOf } from './runtime-limits.js';
export { compactionLimitsOf } from './runtime-limits.js';
import { createCompaction } from '../session/compaction.js';
import { TRUSTED_AGENT_CONTROL_ORIGIN } from './agent-control-runtime.js';
import { controllerScopeOf, mayRecordHumanRun, maySetPermission, requirePermissionControl, requireTrustedUi, runChannelOf, runOriginBasis, runScopesOf, type ControlTrust } from './capabilities.js';
import { admitEntry } from './entry.js';
import { usageEvent } from '../session/usage.js';
import { summarizeUsage } from '../session/usage-summary.js';
import { readSessionRecord } from '../session/record.js';
import { inactiveGrantOutcome, isGrantActive, selectReviewEvidence, staleReviewOutcome } from './review-evidence.js';
import { repairUnresolvedCalls } from '../session/repair.js';
import { readPolicyOverride } from '../session/format.js';
import { SPILL_NAME } from '../session/spill.js';
import { assertNoLegacyTrashConfig, boundaryOf, limitsOf, workingDirectoryOf, type CapabilityConfig } from '../capability/limits.js';
import { isWithin, resolveWithin } from '../capability/paths.js';
import { runManagedExec, type ExecControlArguments, type ExecRunContext } from '../capability/exec.js';
import { createFiniteCommandRegistry, type FiniteCommandOwner } from '../capability/finite-command.js';
import { createProcessOwnership } from './process-ownership.js';
import { createManagedProcessRegistry, managedProcessPlugin } from '../capability/managed-process.js';
import { loadInstructions, DEFAULT_INSTRUCTION_BYTES } from '../capability/instructions.js';
import { SKILL_METADATA_BUDGET_BYTES, discoverSkills, formatSkillCatalog, skillDirectories } from '../kernel/skills.js';
import { discoverTemplates, expandTemplate, findTemplate, parseInvocation, templateDirectories } from '../kernel/templates.js';
import { createLoop, type LoopCompaction, type LoopProgressEvent, type LoopProgressPhase } from '../kernel/loop.js';
import { appendRequestDiagnostic, configureRequestDiagnostics, createRequestDiagnosticStore, requestDiagnosticSnapshot } from '../kernel/request-diagnostics.js';
import { minimalPlugin } from '../tools/minimal.js';
import { networkPlugin } from '../tools/network.js';
import { createTodoWritePlugin } from '../tools/todo-write.js';
import { createReadImagePlugin } from '../tools/read-image.js';
import { createReadDocumentPlugin } from '../tools/read-document.js';
import { createPresentPlugin, type ViewRequestArguments, type ViewRequestResult } from '../tools/present.js';
import { listArtifacts, previewArtifact, inspectArtifact, resolveArtifact, type ArtifactScope } from './artifacts.js';
import { readToolResult } from './tool-result-view.js';
import { readRecordPage, type SessionReadDeps } from './session-read.js';
import { applyStorageCleanup, inspectStorage, previewStorageCleanup, type StoragePlanState, type StorageScanState } from './storage-service.js';
import { createSessionImagePreview } from './image-preview.js';
import { browserView, createStatusView, sessionPermissionView } from './status-view.js';
import { verifySideSelection } from './side-selection.js';
import { createSearchSupport } from './search.js';
import { createBrowserSupport, type BrowserSupport } from '../capability/browser.js';
import { assertBrowserArguments, browserToolPolicy, BROWSER_SERVER } from '../capability/browser-policy.js';
import { createScreenshotPlugin } from '../tools/screenshot.js';
import { createMediaStore } from '../capability/media.js';
import { checkedImageReferences } from '../media.js';
import { createSkillPlugin } from '../tools/skill.js';
import { createMcpPlugin, type McpAuthorization } from '../tools/mcp.js';
import { createSubagentPlugin } from '../tools/subagent.js';
import { createCompactPlugin } from '../tools/compact.js';
import { createCustomToolsPlugin, discoverCustomTools } from '../tools/custom.js';
import { createAskUserPlugin } from '../tools/ask-user.js';
import { createMcpRegistry, mcpServerConfigs } from '../capability/mcp.js';
import { createRunSteeringInbox } from '../kernel/run-steering.js';
import { discoverModels } from '../model/discovery.js';
import { apiRoot } from '../model/http.js';
import { thinkingCapabilityOf } from '../model/thinking.js';
import type { ModelRequest, ProviderEvent } from '../kernel/loop.js';
import { createConnection, type HostRequest } from './connection.js';
import { APPROVAL_METHOD, QUESTION_METHOD, SIDE_SELECTION_MAX_BYTES, VIEW_REQUEST_METHOD, requiredString, validateCall, type HostMethodParams } from './protocol.js';
import { createConfig, mergePolicyRules } from '../kernel/config.js';
import { dataRoot, loadConfigLayers } from '../kernel/config-file.js';
import { createTelemetry, currentTelemetryContext, emitTelemetry, telemetryEnabled, type TelemetryOptions } from '../kernel/telemetry.js';
import type { SkillRegistry } from '../kernel/skills.js';
import type { PolicyRule } from '../kernel/config-edit.js';
import type { ToolDefinition } from '../kernel/kernel.js';
import { adoptSessionMode, type SessionModeState } from './session-mode.js';
import { providerFromConfig, modelSelectionOf, type HostGenerationOptions, type HostProvider } from './provider.js';
import { createSessionReviewer, narrowReviewerSettings, reviewerRouteFields, reviewerSettings } from './reviewer.js';
import type { PolicyReviewRecord, PolicyReviewRequest } from '../kernel/policy.js';
import type { ReviewFacts } from '../kernel/reviewer.js';
import { approvalArgsDigest, summarizeApproval } from './approval.js';
import { runAcceptanceScope, runLivenessOf } from './run-records.js';
import { runResourcesOf } from './run-resources.js';
import { createFileChangeStore } from '../session/file-changes.js';
import { checkedCheckDeclaration, type CheckDeclaration } from '../session/checks.js';
import { checkedExecutionLogReference } from '../session/execution-log.js';
import { runEvidenceReferences } from '../session/run-evidence.js';
import { checkEventOf, sampleCheckScope } from './checks.js';
import { parseInitialGenerationSettings } from './session-initial-settings.js';
import { settingsToolCatalog as buildSettingsToolCatalog } from './tool-catalog.js';
import type {
  AdoptionResult, DelegatedRunResult, EnvironmentSeed, Host, HostClientConnection, HostConfigSnapshot, HostOptions,
  HostProgressSnapshot, HostSessionBase, HostSessionState, PendingRunAsk, ProjectEnvironment, RuntimeConfig,
  SessionGeneration,
} from './types.js';
export { providerFromConfig, hostProviderFromConfig } from './provider.js';
export { shownConfigOf } from './handlers/config.js';
export type { EnvironmentSeed, Host, HostOptions, HostProgressSnapshot, HostSessionState } from './types.js';

interface InitialSessionSettings {
  readonly mode?: string;
  readonly policy?: Exclude<PolicyMode, 'default'>;
  readonly sessionPolicyRules?: readonly PolicyRule[];
  readonly operation?: { readonly operationId: string; readonly sourceSessionId: string };
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

type ModeState = SessionModeState;
type PolicyRememberScope = 'session' | 'project' | 'user';

function policyRuleKey(rule: Pick<PolicyRule, 'tool' | 'match' | 'target' | 'path' | 'argsHash'>): string {
  return JSON.stringify([rule.tool, rule.match ?? '', rule.target ?? '', rule.path ?? '', rule.argsHash ?? '']);
}

/**
 * 把一条 Policy 规则投影成复审事实。作用域字段（target/path/argsHash）必须原样带上，
 * 否则 Reviewer 会把“只对这一条命令生效”的拒绝看成泛化的拒绝。
 */
function reviewRuleOf(rule: PolicyRule, source: 'session' | 'config'): NonNullable<ReviewFacts['rules']>[number] {
  return {
    tool: rule.tool,
    decision: rule.decision,
    source,
    ...(rule.match === undefined ? {} : { match: rule.match }),
    ...(rule.target === undefined ? {} : { target: rule.target }),
    ...(rule.path === undefined ? {} : { path: rule.path }),
    ...(rule.argsHash === undefined ? {} : { argsHash: rule.argsHash }),
  };
}

type OperationTerminalState = 'exited' | 'failed' | 'cancelled' | 'unknown';

interface HostSessionRetirement {
  managedProcessesClosed: boolean;
  finiteCommandsClosed: boolean;
  mcpClosed: boolean;
  extensionsDisposed: boolean;
  assemblyDisposed: boolean;
  sessionClosed: boolean;
}

interface HostRequestWithParams {
  readonly method: string;
  readonly params: HostMethodParams;
}

interface ExtensionPromptFragment {
  readonly name: string;
  readonly text: string;
  readonly source: string;
}

function trackAsk(state: HostSessionBase, pending: PendingRunAsk, runId?: string): void {
  state.asks.add(pending);
  if (runId === undefined) return;
  const asks = state.asksByRun.get(runId) ?? new Set<PendingRunAsk>();
  asks.add(pending);
  state.asksByRun.set(runId, asks);
}

function untrackAsk(state: HostSessionBase, pending: PendingRunAsk, runId?: string): void {
  state.asks.delete(pending);
  if (runId === undefined) return;
  const asks = state.asksByRun.get(runId);
  asks?.delete(pending);
  if (asks?.size === 0) state.asksByRun.delete(runId);
}

function settleRunAsks(state: HostSessionBase, runId: string): string[] {
  const pending = [...(state.asksByRun.get(runId) ?? [])];
  for (const ask of pending) ask.settle();
  return pending.map((ask) => ask.requestId);
}

function runInputRevisionOf(state: HostSessionBase, runId: string | undefined): number {
  return runId === undefined ? 0 : state.runInputRevisions?.get(runId) ?? 0;
}

function advanceRunInputRevision(state: HostSessionBase, runId: string): void {
  const revisions = state.runInputRevisions ??= new Map();
  revisions.set(runId, runInputRevisionOf(state, runId) + 1);
}

function modelConfigOf(config: HostConfigSnapshot): Record<string, unknown> {
  return isRecord(config.model) ? config.model : {};
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
export { SESSION_NAME_MAX } from './handlers/session.js';

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

/** 由可信通道与作用域派生的 Run 来源证据；请求参数不能指定。 */
function runProvenanceOf(trust: ControlTrust, bridge: boolean, origin: 'human' | 'controller',
  scope: string): import('../session/run.js').RunProvenance {
  const via = runChannelOf(trust, bridge);
  if (origin === 'human') return { via, resolvedBy: runOriginBasis(trust, bridge) };
  return { via, resolvedBy: scope === 'controller:local' ? 'controller-local' : 'controller-grant' };
}

/** Grant 可以同时约束 Session 的 Mode、模型与输出预算；Run 开始时复核，避免配置变更绕过上限。 */
function withOutputCeiling(options: HostGenerationOptions, ceiling: number | undefined): HostGenerationOptions {
  return ceiling === undefined ? options : { ...options, outputTokensCeiling: ceiling };
}

function assertGrantSessionScope(grant: DelegationGrant, state: HostSessionState): void {
  const mode = state.mode.file?.name;
  if (mode !== undefined) assertDelegationMode(grant, mode);
  const selection = modelSelectionOf(state.generation.model);
  if (selection !== undefined) assertDelegationModelSelection(grant, `${selection.provider}/${selection.model}`);
  else if (typeof state.generation.provider.model === 'string') assertDelegationModelSelection(grant, state.generation.provider.model);
}

function errorDetail(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  return typeof error.detail === 'string' ? error.detail : undefined;
}

function telemetryOptionsOfUserLayer(layer: Record<string, unknown> | undefined): TelemetryOptions | undefined {
  const raw = layer?.telemetry;
  if (raw === undefined) return undefined;
  if (!isRecord(raw) || Object.keys(raw).some(key => !['enabled', 'otlpEndpoint'].includes(key))) {
    throw new KernelError('telemetry_config_invalid', { detail: 'user telemetry configuration accepts only enabled and otlpEndpoint' });
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    throw new KernelError('telemetry_config_invalid', { detail: 'telemetry.enabled must be a boolean' });
  }
  if (raw.otlpEndpoint !== undefined && typeof raw.otlpEndpoint !== 'string') {
    throw new KernelError('telemetry_config_invalid', { detail: 'telemetry.otlpEndpoint must be a string' });
  }
  if (raw.enabled !== true) {
    return { enabled: false, ...(typeof raw.otlpEndpoint === 'string' ? { otlpEndpoint: raw.otlpEndpoint } : {}) };
  }
  const directory = join(dataRoot(), 'telemetry');
  try { mkdirSync(directory, { recursive: true, mode: 0o700 }); }
  catch (cause) { throw new KernelError('telemetry_storage_unavailable', { cause }); }
  return { enabled: true, directory, ...(typeof raw.otlpEndpoint === 'string' ? { otlpEndpoint: raw.otlpEndpoint } : {}) };
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

// 将流式事件转发给客户端，同时把原事件交回循环。
// 保留提供方能力和模型信息；每轮开始时解析当前提供方，使配置变更从下一轮生效。
function observedProvider(provider: HostProvider, onDelta: (event: ProviderEvent) => void): HostProvider {
  return {
    get name() { return provider.name; },
    get model() { return provider.model; },
    get pending() { return provider.pending; },
    get capabilities() { return provider.capabilities; },
    get requiresCompletion() { return provider.requiresCompletion; },
    get imageInput() { return provider.imageInput; },
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
function currentProvider(read: () => HostProvider, authorize: () => void, task?: () => TaskBudget | undefined): HostProvider {
  return {
    get name() { return read().name; },
    get model() { return read().model; },
    get pending() { return read().pending; },
    get capabilities() { return read().capabilities; },
    get requiresCompletion() { return read().requiresCompletion; },
    get imageInput() { return read().imageInput; },
    get outputTokens() { return read().outputTokens; },
    get contextTokens() { return read().contextTokens; },
    get thinkingCapability() { return read().thinkingCapability; },
    get thinkingEffort() { return read().thinkingEffort; },
    withModel(model) {
      const provider = read().withModel(model);
      return currentProvider(() => provider, authorize, task);
    },
    withGeneration(options) {
      const provider = read().withGeneration(options);
      return currentProvider(() => provider, authorize, task);
    },
    async *stream(request, options) {
      const provider = read();
      if (provider.pending !== true) authorize();
      const budget = task?.();
      budget?.consumeModelCall();
      const active = budget?.request(options?.signal);
      try { yield* provider.stream(request, active === undefined ? options : { signal: active.signal }); }
      catch (error) { throw active?.signal.aborted === true && active.signal.reason instanceof KernelError ? active.signal.reason : error; }
      finally { active?.dispose(); }
    },
  };
}

function hasModelCredentialBinding(model: Record<string, unknown>, api: unknown, baseURL: unknown, reference: unknown): boolean {
  if (typeof baseURL !== 'string') return false;
  const address = new URL(apiRoot(baseURL)).href;
  const matches = (candidateApi: unknown, candidateURL: unknown, candidateReference: unknown) =>
    candidateApi === api && candidateReference === reference && typeof candidateURL === 'string' && new URL(apiRoot(candidateURL)).href === address;
  return modelServices(model.services).some((service) => matches(service.api, service.baseURL, service.apiKeyEnv))
    || (typeof model.model === 'string' && matches(model.api, model.baseURL, model.apiKeyEnv ?? 'LIGULE_API_KEY'));
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

// 同时解析模式名称和搜索路径，确保启动与运行时切换使用同一规则。
// 扩展来源由加载器提供；`paths` 会被加载，`ignored` 会写入诊断记录。
export function createHost({
  config, provider, plugins = [minimalPlugin, networkPlugin], policy, logger, modeName, modePaths, skillRegistry,
  templateRegistry, extensions = { paths: [], ignored: [] }, loadEnvironment, configStore, configLayers, configStoreFor,
  deriveProvider = providerFromConfig, interactive = false, permission = DEFAULT_PERMISSION_CONTEXT, permissionControl = false,
  agentControl, screenCaptureConsent = false, telemetry: telemetryOptions,
}: HostOptions): Host {
  if (typeof screenCaptureConsent !== 'boolean') throw new KernelError('screen_capture_consent_invalid');
  // Share file mutation ordering across this Host's Session Kernels only.
  const fileWriteQueue = createFileWriteQueue();
  const telemetry = createTelemetry(telemetryOptions ?? telemetryOptionsOfUserLayer(configLayers?.user), code => {
    try { logger?.log?.('telemetry storage unavailable', { code, severity: 'error' }); }
    catch { /* Storage diagnostics must not affect Host or Agent work. */ }
  });
  // 每个项目环境持有自己的配置快照、提供方、策略、模式、记录目录和可写配置层。
  // 在加载环境时校验配置，避免等到第一次模型请求才发现错误。
  // 文件系统边界同时限制工具访问范围和指令文件向上查找的范围。
  // 用户配置由所有项目共享；项目共享层和本地层只属于各自项目。
  // 加载器负责解析配置文件路径；Host 通过层名、允许字段和版本读写配置。
  function prepareEnvironment(own: EnvironmentSeed): ProjectEnvironment {
    if (!Object.isFrozen(own.config)) throw new KernelError('host_config_must_be_frozen');
    assertNoLegacyTrashConfig(own.config);
    if (typeof own.config.boundary !== 'string' || own.config.boundary === '') throw new KernelError('host_boundary_required');
    if (typeof own.provider?.stream !== 'function') throw new KernelError('host_provider_required');
    if (own.modeName !== undefined && own.modePaths === undefined) throw new KernelError('host_mode_paths_required');
    if (own.config.workspaceRoot !== undefined && typeof own.config.workspaceRoot !== 'string') {
      throw new KernelError('host_workspace_root_invalid');
    }
    const root = resolve(own.config.workspaceRoot ?? own.config.boundary);
    const runtimeConfig: RuntimeConfig = Object.freeze({ ...own.config, workspaceRoot: root, boundary: resolve(root, own.config.boundary) });
    const mcpConfig = isRecord(own.config.mcp) ? { mcp: { servers: own.config.mcp.servers } } : {};
    const configuredMcp = mcpServerConfigs(mcpConfig, process.env, root);
    if (configuredMcp.some(server => server.name === BROWSER_SERVER)) throw new KernelError('browser_server_name_reserved');
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
      mcpConfigs: configuredMcp,
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
  const controlTrust: ControlTrust = { permissionControl, agentControl };
  // 状态视图在 status-view.ts；这里只固定模型选择的投影方式。
  const statusView = createStatusView({ modelSelectionOf });
  // 展示的“权限可改”与本机执行判定调用同一个函数，避免两处各维护一套条件。
  // 可信 UI 的 Host 对所有连接可信（它只承载本机 TUI/桌面自身），桥连接按自身通道放行；
  // 普通 MCP 客户端两条路径都不成立，因此展示值必须走这里而不是 Host 级的 permissionControl。
  const mayChangePermission = (bridge: boolean): boolean => maySetPermission(controlTrust, bridge);
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

  async function browserForEnvironment(env: ProjectEnvironment): Promise<BrowserSupport> {
    env.browserSupport ??= createBrowserSupport(env.config, env.layers);
    const browser = await env.browserSupport;
    if (browser.server !== undefined && !env.mcpConfigs.some(server => server.name === BROWSER_SERVER)) env.mcpConfigs.push(browser.server);
    return browser;
  }

  async function currentMcpConfigs(env: ProjectEnvironment): Promise<ReturnType<typeof mcpServerConfigs>> {
    await browserForEnvironment(env);
    if (loadEnvironment === undefined) return env.mcpConfigs;
    const latest = await loadConfigLayers({ projectRoot: env.projectRoot });
    const config = createConfig({
      ...latest,
      ...(env.layers.flag === undefined ? {} : { flag: env.layers.flag }),
    });
    const mcpConfig = isRecord(config.mcp) ? { mcp: { servers: config.mcp.servers } } : {};
    const servers = mcpServerConfigs(mcpConfig, process.env, env.projectRoot);
    if (servers.some(server => server.name === BROWSER_SERVER)) throw new KernelError('browser_server_name_reserved');
    const browser = await createBrowserSupport({ ...config, boundary: env.config.boundary, workspaceRoot: env.projectRoot },
      { ...latest, ...(env.layers.flag === undefined ? {} : { flag: env.layers.flag }) });
    return [...servers, ...(browser.server === undefined ? [] : [browser.server])];
  }

  function customToolsPluginOf(customTools: Awaited<ReturnType<typeof discoverCustomTools>>) {
    if (customTools.tools.length === 0) return undefined;
    const code = 'custom_tool_name_conflicts_with_registered_tool';
    const reportConflict = (name: string) => {
      const path = customTools.sources[name] ?? name;
      if (customTools.diagnostics.some((diagnostic) => diagnostic.code === code && diagnostic.path === path)) return;
      customTools.diagnostics.push({ code, path, detail: `${name} conflicts with an already registered tool` });
      logger?.log?.('custom tool is not loaded', { code, path });
    };
    return {
      name: 'ligule-custom-tools',
      setup(kernel: Kernel) {
        // Parent setup records conflicts. Child setup sees those diagnostics and must not retry rejected declarations.
        const available = customTools.tools.filter((tool) => !customTools.diagnostics.some((diagnostic) =>
          diagnostic.code === code && diagnostic.path === (customTools.sources[tool.name] ?? tool.name)));
        return createCustomToolsPlugin(available, reportConflict).setup(kernel);
      },
    } satisfies Plugin<Kernel>;
  }

  // Settings can inspect the Host-configured runtime registry before opening a conversation.
  // Assemble metadata and check configured credential availability without running tools or connecting MCP.
  async function settingsToolCatalog(env: ProjectEnvironment, skills: SkillRegistry, customTools: Awaited<ReturnType<typeof discoverCustomTools>>): Promise<ReturnType<Kernel['catalog']>> {
    const search = await createSearchSupport(env.config, env.layers);
    await browserForEnvironment(env);
    const customToolPlugin = customToolsPluginOf(customTools);
    return await buildSettingsToolCatalog({
      config: env.config,
      provider: env.provider,
      policy: env.policy,
      directory: env.directory,
      modePaths: env.modePaths,
      skills,
      plugins,
      customToolPlugin,
      searchPlugin: search.plugin,
      mcpConfigs: env.mcpConfigs,
      interactive,
    });
  }

  async function stopMcpServersWithChangedConfig(env: ProjectEnvironment, current: ReturnType<typeof mcpServerConfigs>): Promise<void> {
    for (const state of sessions.values()) {
      if (state.environment !== env) continue;
      for (const previous of env.mcpConfigs) {
        const next = current.find((server) => server.name === previous.name);
        if (next === undefined || next.identityDigest !== previous.identityDigest) await revokeSessionMcp(state, previous.name);
      }
    }
  }

  async function revokeSessionMcp(state: HostSessionState, name: string): Promise<void> {
    await Promise.all([state.mcp, ...state.childMcp.keys()].map(registry => registry.revoke(name)));
    if (name === BROWSER_SERVER) await Promise.all([state.id, ...state.childMcp.values()].map(id => state.browser.clearSession(id)));
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
    if (params.confirmInitialWorkspaceTrust === true) requireTrustedUi('workspace-trust', controlTrust);
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
      if (grant !== undefined) assertDelegationModelSelection(grant, `${selection.provider}/${selection.model}`);
    }
    let policy: Exclude<PolicyMode, 'default'> | undefined;
    const requestedPolicy = params.initialPolicy ?? grant?.defaultPolicy;
    if (requestedPolicy !== undefined) {
      // 旧客户端的 `none` 只降级为新语义的 `ask`，不会升级成不审批的 `never`。
      const mode = requestedPolicy === 'none' ? 'ask' : readPolicyMode(requestedPolicy, false);
      if (mode === undefined) throw new KernelError('policy_mode_unknown');
      if (grant !== undefined) assertDelegationPolicy(grant, mode);
      policy = mode;
    }
    const hasInitialPermission = params.initialPermissionProfile !== undefined || params.initialPermissionNetwork !== undefined;
    let initialPermission: InitialSessionSettings['permission'];
    if (hasInitialPermission) {
      requirePermissionControl(controlTrust);
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
    const parsedGeneration = parseInitialGenerationSettings(params);
    const options: { outputTokens?: number; thinkingEffort?: HostGenerationOptions['thinkingEffort'] } = {
      ...(parsedGeneration.outputTokens === undefined ? {} : { outputTokens: boundedOutputTokens(grant, parsedGeneration.outputTokens) }),
      ...(parsedGeneration.thinkingEffort === undefined ? {} : { thinkingEffort: parsedGeneration.thinkingEffort }),
    };
    const loopIterations = parsedGeneration.loopIterations;
    const ceiling = grant?.maxOutputTokens;
    const generationOptions = withOutputCeiling(options, ceiling);
    const persistGeneration = selection !== undefined || Object.keys(options).length > 0;
    // 未显式选择模型时沿用 Host 默认生成设置；Grant 有预算上限时仍需重新派生 Provider。
    const provider = persistGeneration
      ? deriveProvider({ ...env.config, model }, generationOptions)
      : ceiling === undefined
        ? env.generation?.provider ?? env.provider
        : deriveProvider({ ...env.config, model }, withOutputCeiling(env.generation?.options ?? {}, ceiling));
    const mode = params.initialMode === undefined
      ? undefined
      : params.initialMode === 'default' ? env.modeName ?? DEFAULT_MODE : requiredString(params.initialMode, 'initialMode');
    if (mode !== undefined) {
      if (env.modePaths === undefined) throw new KernelError('host_mode_paths_required');
      await loadMode(mode, env.modePaths);
      if (grant !== undefined) assertDelegationMode(grant, mode);
    }
    if (params.confirmInitialWorkspaceTrust === true) await setTrusted(env.projectRoot, true);
    return {
      ...(mode === undefined ? {} : { mode }),
      ...(policy === undefined ? {} : { policy }),
      ...(initialPermission === undefined ? {} : { permission: initialPermission }),
      ...(loopIterations === undefined ? {} : { loopIterations }),
      persistLoopIterations: loopIterations !== undefined,
      generation: { provider, model, ...(selection === undefined ? {} : { explicit: true }), options: generationOptions },
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
  const finiteCheckContexts = new Map<string, {
    readonly session: SessionLog;
    readonly config: CapabilityConfig;
    readonly permissionAtStart: PermissionContext;
    readonly currentPermission: () => PermissionContext;
  }>();
  const storagePlans = new Map<string, StoragePlanState>();
  const storageScans = new Map<string, StorageScanState>();
  const retiringSessions = new Set<string>();
  const retirementProgress = new Map<string, HostSessionRetirement>();
  const retirementTasks = new Map<string, Promise<void>>();
  const pendingApprovalDetails = new Map<string, { sessionId: string; args: Record<string, unknown>; argumentSha256: string }>();
  const building = new Set<Promise<unknown>>();
  let closing: Promise<void> | undefined;
  async function recordOperationFinished(state: HostSessionState, terminal: {
    readonly state: OperationTerminalState;
    readonly exitCode?: number;
    readonly errorCode?: string;
  }): Promise<void> {
    if (state.operationOnly !== true || state.operationId === undefined || state.operationFinished === true) return;
    state.operationFinished = true;
    try {
      await state.session.append({ kind: 'operationFinished', ignorable: true, operationId: state.operationId,
        state: terminal.state, ...(terminal.exitCode === undefined ? {} : { exitCode: terminal.exitCode }),
        ...(terminal.errorCode === undefined ? {} : { errorCode: terminal.errorCode }), finishedAt: new Date().toISOString() });
    } catch (error) {
      state.operationFinished = false;
      throw error;
    }
  }
  const finiteCommands = createFiniteCommandRegistry({
    validateOwner: async (owner) => {
      if (owner.grantId !== undefined) {
        const active = await activeDelegation();
        if (active?.id !== owner.grantId) throw new KernelError('agent_control_grant_revoked');
      }
      if (owner.workspaceTrusted && !(await isTrusted(owner.projectRoot))) {
        throw new KernelError('exec_workspace_untrusted', { detail: 'workspace trust was revoked while a finite command was running' });
      }
    },
    onTerminal: async (terminal) => {
      const operationState = sessions.get(terminal.owner.sessionId);
      if (operationState?.operationOnly === true && operationState.operationId === terminal.owner.runId) {
        try {
          await recordOperationFinished(operationState, {
            state: ['exited', 'failed', 'cancelled', 'unknown'].includes(terminal.state) ? terminal.state : 'unknown',
            ...(terminal.exitCode === undefined ? {} : { exitCode: terminal.exitCode }),
            ...(terminal.errorCode === undefined ? {} : { errorCode: terminal.errorCode }),
          });
        } catch (error) {
          logger?.log?.('operation result could not be recorded', {
            code: errorCode(error) ?? 'operation_record_failed', sessionId: operationState.id,
            operationId: operationState.operationId,
          });
        }
      }
      const declaration = terminal.owner.check;
      if (declaration === undefined) return;
      const context = finiteCheckContexts.get(terminal.executionId);
      if (context === undefined) return;
      try {
        const header = await context.session.header();
        if ((header?.formatVersion ?? 0) < 5) return;
        const events = await context.session.read();
        const accepted = events.find((event) => event.kind === 'execution' && event.executionId === terminal.executionId
          && event.state === 'accepted');
        const terminalEvent = events.findLast((event) => event.kind === 'execution' && event.executionId === terminal.executionId
          && ['exited', 'cancelled', 'failed'].includes(String(event.state)));
        if (accepted === undefined || terminalEvent === undefined) return;
        // 检查结果自己带上命令的起止时刻与日志引用；旧记录缺这些字段时保持缺失，由读取方显示未知。
        const started = events.findLast((event) => event.kind === 'execution' && event.executionId === terminal.executionId
          && event.state === 'started');
        const startedFields: Record<string, unknown> = isRecord(started) ? started : {};
        const acceptedFields: Record<string, unknown> = isRecord(accepted) ? accepted : {};
        const terminalFields: Record<string, unknown> = isRecord(terminalEvent) ? terminalEvent : {};
        const startedAt = typeof startedFields.startedAt === 'string' ? startedFields.startedAt
          : typeof acceptedFields.startedAt === 'string' ? acceptedFields.startedAt : undefined;
        const endedAt = typeof terminalFields.finishedAt === 'string' ? terminalFields.finishedAt : undefined;
        const checkLogsRef = checkedExecutionLogReference(terminalFields.logsRef);
        const scoped = new Set(declaration.scope);
        const knownScopedChange = events.some((event) => (event.kind === 'tool' || event.kind === 'workspaceFileChange')
          && event.seq > accepted.seq && event.seq < terminalEvent.seq
          && Array.isArray(event.fileChanges) && event.fileChanges.some((change) => isRecord(change)
            && typeof change.path === 'string' && scoped.has(change.path) && change.outcome !== 'unchanged'));
        const current = context.currentPermission();
        const canReadStart = context.permissionAtStart.capabilities.filesystemRead !== 'unavailable';
        const canReadNow = current.capabilities.filesystemRead !== 'unavailable';
        const samplePermission = canReadStart && canReadNow ? context.permissionAtStart : {
          ...context.permissionAtStart,
          capabilities: { ...context.permissionAtStart.capabilities, filesystemRead: 'unavailable' as const },
        };
        const scopeEnd = await sampleCheckScope(context.config, samplePermission, declaration);
        await context.session.append(checkEventOf({
          sessionId: terminal.owner.sessionId,
          runId: terminal.owner.runId,
          callId: terminal.owner.callId,
          executionId: terminal.executionId,
          declaration,
          executionState: terminal.state === 'exited' || terminal.state === 'cancelled' || terminal.state === 'failed'
            ? terminal.state : 'unknown',
          ...(terminal.exitCode === undefined ? {} : { exitCode: terminal.exitCode }),
          ...(terminal.errorCode === undefined ? {} : { errorCode: terminal.errorCode }),
          ...(terminal.logs === undefined ? {} : { logs: terminal.logs }),
          ...(terminal.logUnavailableReason === undefined ? {} : { logUnavailableReason: terminal.logUnavailableReason }),
          scopeStart: terminal.owner.checkScopeStart ?? declaration.scope.map((path) => ({
            path, status: 'unknown' as const, exists: null, version: null, sampledAt: new Date().toISOString(),
            reason: 'scope_start_unavailable',
          })),
          scopeEnd,
          knownScopedChange,
          ...(startedAt === undefined ? {} : { startedAt }),
          ...(endedAt === undefined ? {} : { endedAt }),
          ...(checkLogsRef === undefined ? {} : { logsRef: checkLogsRef }),
        }));
      } finally {
        finiteCheckContexts.delete(terminal.executionId);
      }
    },
  });

  const processOwnership = createProcessOwnership(finiteCommands);

  function open(id: string): HostSessionState {
    const state = sessions.get(id);
    if (state === undefined) throw new KernelError('session_not_open', { detail: id });
    if (retiringSessions.has(id)) throw new KernelError('session_closing', { detail: id });
    return state;
  }

  async function appendToolActivity(state: HostSessionState, phase: 'awaiting_approval' | 'awaiting_user', tool: string,
    requestId: string, callId?: string): Promise<void> {
    const context = currentKernelExecutionContext();
    const activeCallId = callId ?? context?.callId;
    if (context?.sessionId !== state.id || context.runId === undefined || activeCallId === undefined) return;
    await state.session.append({ kind: 'toolActivity', ignorable: true, sessionId: state.id, runId: context.runId,
      callId: activeCallId, tool, phase, requestId, at: new Date().toISOString() });
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
        if (['api', 'baseURL', 'apiKeyEnv', 'model', 'outputTokens', 'serviceOutputLimit', 'serviceContextTokens', 'serviceImageInput'].every((field) => previous[field] === next[field])) continue;
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
    if (!isPolicyMode(effective)) throw new KernelError('policy_mode_unknown');
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
    input: unknown,
    command: string | undefined,
    scope: PolicyRememberScope,
    target: 'file' | 'workspace' | 'tool' | 'command' | undefined,
    identityDigest: string | undefined,
  ): Promise<void> {
    const args = isRecord(input) ? input : {};
    let rule: PolicyRule;
    if (['create', 'write', 'edit', 'delete'].includes(tool)) {
      if ((target !== 'file' && target !== 'workspace') || typeof args.path !== 'string') {
        throw new KernelError('policy_memory_target_required', { detail: 'file approvals must be remembered for one file or one operation class in this workspace' });
      }
      const boundary = boundaryOf(state.environment.config);
      const path = target === 'workspace'
        ? await realpath(boundary)
        : await resolveWithin(boundary, args.path, { cwd: workingDirectoryOf(state.environment.config) });
      rule = { tool, decision: 'allow', target, path };
    } else if (tool.startsWith('mcp:')) {
      if (identityDigest === undefined) throw new KernelError('policy_memory_identity_unavailable');
      rule = { tool, decision: 'allow', argsHash: policyArgsHash(input, identityDigest) };
    } else if (command !== undefined) {
      rule = { tool, decision: 'allow', match: command };
    } else {
      rule = { tool, decision: 'allow' };
    }
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
  async function retire(state: HostSessionState, shutdown = false): Promise<void> {
    state.screenCapture.controller.abort(new KernelError('screen_capture_session_closed'));
    const inFlight = retirementTasks.get(state.id);
    if (inFlight !== undefined) {
      if (!shutdown) return await inFlight;
      try { await inFlight; } catch { /* Shutdown still releases the record lock after a failed close. */ }
      if (!sessions.has(state.id)) return;
    }
    let progress = retirementProgress.get(state.id);
    if (progress === undefined) {
      progress = {
        managedProcessesClosed: false,
        finiteCommandsClosed: false,
        mcpClosed: false,
        extensionsDisposed: false,
        assemblyDisposed: false,
        sessionClosed: false,
      };
      retirementProgress.set(state.id, progress);
    }
    retiringSessions.add(state.id);
    const work = (async () => {
      // 失败或取消结果已经写入记录；收尾只等待轮次结束，不覆盖其结果。
      // 关闭时给等待加上限：卡住的工具调用不能拖住 Host 退出，超时后继续释放进程与记录锁。
      const waited = await settleWithin(state.operation?.catch(() => undefined), SETTLE_GRACE_MS, shutdown
        ? () => logger?.log?.('session retirement timed out waiting for the run', { sessionId: state.id, severity: 'error' })
        : undefined);
      if (!waited && !shutdown) await state.operation?.catch(() => undefined);
      const failures: unknown[] = [];
      const resources = [
        ['finiteCommandsClosed', () => finiteCommands.stopSession(state.id)],
        ['managedProcessesClosed', () => state.managedProcesses.close()],
        ['mcpClosed', async () => { await state.mcp.close(); await state.browser.closeSession(state.id); }],
        ['extensionsDisposed', () => state.extensions.dispose()],
        ['assemblyDisposed', async () => { try { await state.subagents.close(); } finally { await state.assembly.dispose(); } }],
      ] as const;
      for (const [field, release] of resources) {
        if (progress![field]) continue;
        try {
          await release();
          progress![field] = true;
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0 && !shutdown) throw new AggregateError(failures, 'host_session_retire_failed');
      if (!progress!.sessionClosed) {
        try {
          await state.session.close();
          progress!.sessionClosed = true;
        } catch (error) {
          failures.push(error);
          if (!shutdown) throw new AggregateError(failures, 'host_session_retire_failed');
        }
      }
      sessions.delete(state.id);
      retirementProgress.delete(state.id);
      retiringSessions.delete(state.id);
      if (failures.length > 0) throw new AggregateError(failures, 'host_session_retire_failed');
    })();
    retirementTasks.set(state.id, work);
    try { await work; }
    finally {
      if (retirementTasks.get(state.id) === work) retirementTasks.delete(state.id);
    }
  }

  // 项目最后一个会话关闭后移除其环境，让下次打开时重新加载配置。
  // Host 默认环境没有加载器入口可重建，因此继续保留。
  function evictEnvironment(environment: ProjectEnvironment): void {
    if (environment === defaultEnvironment) return;
    for (const other of sessions.values()) if (other.environment === environment) return;
    environments.delete(environment.projectRoot);
  }

  function progressSnapshotOf(state: HostSessionState): HostProgressSnapshot | null {
    const progress = state.progress;
    return progress === undefined ? null : {
      ...progress,
      ...(state.taskBudget === undefined ? {} : { task: state.taskBudget.snapshot() }),
    };
  }

  function publishProgress(state: HostSessionState, connection: HostClientConnection): void {
    state.progressNotificationAt = Date.now();
    connection.notify({ notify: 'progress', sessionId: state.id, progress: progressSnapshotOf(state) });
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
    const layers = state.environment.layers;
    // 凭据目标随轮次冻结；项目配置只能引用用户或命令行明确选择的服务绑定。
    // 不携带配置层的进程内调用由调用方显式提供完整配置。
    state.modelCredentialBindings = Object.keys(layers).length === 0 ? undefined
      : modelConfigOf(createConfig({ user: layers.user ?? {}, flag: layers.flag ?? {} }));
    const controller = new AbortController();
    let browserCleanup: Promise<unknown> | undefined;
    const stopBrowser = () => { browserCleanup = revokeSessionMcp(state, BROWSER_SERVER).then(() => undefined, error => error); };
    controller.signal.addEventListener('abort', stopBrowser, { once: true });
    const progress = beginProgress(state, connection, initialPhase);
    const settleAsks = (): void => { for (const ask of state.asks) ask.settle(); };
    controller.signal.addEventListener('abort', settleAsks, { once: true });
    state.running = controller;
    const operation = (async (): Promise<T> => {
      try {
        return await action(controller.signal, progress.report);
      } finally {
        controller.signal.removeEventListener('abort', settleAsks);
        controller.signal.removeEventListener('abort', stopBrowser);
        const browserCleanupError = await browserCleanup;
        changeProgressPhase(state, connection, 'settling');
        try {
          await serializeSessionConfiguration(state.id, async () => {
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
              // Keep new submissions behind this queue until all pending settings have settled.
              state.running = undefined;
            }
          });
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
        if (browserCleanupError !== undefined) throw browserCleanupError;
      }
    })();
    state.operation = operation;
    try {
      return await operation;
    } finally {
      if (state.operation === operation) state.operation = undefined;
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

  function recordPathOf(id: string, env: { readonly directory: string } = defaultEnvironment): string {
    assertSessionId(id);
    return join(env.directory, `${id}.jsonl`);
  }

  // 只为当前页包含的记录读取溢出文件。
  async function fillSpills(events: SessionEvent[], env: { readonly directory: string }): Promise<SessionEvent[]> {
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

  // 使用稳定递增的事件序号分页；读模型在 session-read.ts，这里只绑定打开中的会话与环境。
  const sessionReadDeps: SessionReadDeps = {
    opened: id => sessions.get(id),
    defaultEnvironment,
    branchOwner,
    assertSessionId,
    recordPathOf,
    fillSpills,
  };

  // 图片预览的并发上限与读取逻辑在 image-preview.ts；这里绑定环境与打开中的会话。
  const previewSessionImage = createSessionImagePreview({
    environmentFor: projectRoot => environmentFor(projectRoot),
    opened: id => sessions.get(id),
    recordPathOf,
  });

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
    await session.append({ kind: 'sessionPolicy', ignorable: true, ...chain.snapshot(), override, semantics: POLICY_SEMANTICS });
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
    // 可信层里残留的路由字段从不生效，也不能看起来像生效：明确拒绝，让用户删掉它们。
    // 校验放在创建任何会话资源之前：否则会先写出一条只含权限事件的残缺记录。
    // 不可信层（项目配置）写进来的同名字段更不可能生效，只记一条诊断，不阻断会话。
    const trustedLayers = Object.keys(env.layers).length === 0
      ? undefined
      : createConfig({ user: env.layers.user ?? {}, flag: env.layers.flag ?? {} });
    const trustedRouteFields = trustedLayers === undefined
      ? reviewerRouteFields(config)
      : reviewerRouteFields(trustedLayers);
    if (trustedRouteFields.length > 0) {
      throw new KernelError('reviewer_route_removed', {
        detail: `the [reviewer] table still sets ${trustedRouteFields.join(', ')}; the reviewer always uses the session model, so remove those fields`,
      });
    }
    // 将已持久化的会话事件同时发送给客户端和已加载扩展。
    const listeners: ((event: SessionEvent) => void)[] = [];
    const asks = new Set<PendingRunAsk>();
    const asksByRun = new Map<string, Set<PendingRunAsk>>();
    const requestDiagnostics = createRequestDiagnosticStore();
    const modeState: ModeState = { file: undefined, tools: [], undo: () => {} };
    const configuredLoopLimits = loopLimitsOf(config);
    const search = await createSearchSupport(config, env.layers);
    const browser = await browserForEnvironment(env);
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
      for (const listener of listeners) withoutKernelExecutionContext(() => listener(event));
    });
    await finiteCommands.accountDirectory(directory);
    const existingEvents = await session.read();
    const existingOperation = existingEvents.find((event) => event.kind === 'operationStarted');
    await finiteCommands.restoreSession({
      sessionId: id,
      projectIdentity: workspaceIdentity(env.projectRoot),
      projectRoot: env.projectRoot,
      session,
      events: existingEvents,
    });
    const inheritedImages = recover ? existingEvents.flatMap(event =>
      event.kind === 'tool' && isRecord(event.result) && event.result.images !== undefined
        ? checkedImageReferences(event.result.images) : []) : [];
    const media = createMediaStore({ ...config, workspaceRoot: env.projectRoot }, id, inheritedImages);
    const fileChanges = createFileChangeStore(session);
    // 新会话继承项目当前有效的生成设置。配置写入后，初始快照可能已过期，优先读取环境的最新设置。
    const workspaceTrusted = await isTrusted(env.projectRoot);
    const basePermission = recover ? permission : initial?.permission?.context ?? permission;
    const sessionPermission = createPermissionContext(
      recover ? 'read-only' : basePermission.profile,
      recover ? 'policy' : basePermission.network,
      basePermission.capabilities,
      permissionOptionsOf(basePermission, recover ? false : basePermission.partialWorkspaceWriteConfirmed, workspaceTrusted),
    );
    const managedProcesses = createManagedProcessRegistry({
      ...(agentControl === undefined ? {} : {
        validateOwner: async () => {
          const active = await activeDelegation();
          if (active?.id !== agentControl.grantId) throw new KernelError('agent_control_grant_revoked');
        },
      }),
      validateWorkspaceTrust: async () => {
        if (!(await isTrusted(env.projectRoot))) {
          throw new KernelError('exec_workspace_untrusted', { detail: 'workspace trust was revoked while a managed process was running' });
        }
      },
    });
    const state: HostSessionBase = {
      id,
      search: search.status,
      browser,
      browserPaused: false,
      childMcp: new Map(),
      session,
      listeners,
      asks,
      asksByRun,
      requestDiagnostics,
      mcpTrust: new Map(),
      sessionPolicyRules: [...(initial?.sessionPolicyRules ?? [])],
      operationOnly: initial?.operation !== undefined || existingOperation !== undefined,
      ...(initial?.operation === undefined && existingOperation === undefined ? {} : {
        operationId: initial?.operation?.operationId ?? String(existingOperation?.operationId),
        operationSourceSessionId: initial?.operation?.sourceSessionId ?? String(existingOperation?.sourceSessionId),
      }),
      operationRevoked: false,
      operationFinished: existingEvents.some((event) => event.kind === 'operationFinished'),
      running: undefined,
      mode: modeState,
      pending: undefined,
      environment: env,
      managedProcesses,
      fileChanges,
      ...(agentControl === undefined ? {} : { managedGrantId: agentControl.grantId }),
      permission: sessionPermission,
      screenCapture: { enabled: false, source: 'none', controller: new AbortController() },
      policyOverride: initial?.policy ?? null,
      loopIterations: initial?.loopIterations ?? configuredLoopLimits.iterations,
      loopModelCalls: configuredLoopLimits.modelCalls,
      loopMaxParallelTools: configuredLoopLimits.maxParallelTools,
      generation: initial?.generation ?? env.generation ?? { provider, model: modelConfigOf(config), options: {} },
      adopt: async () => {},
    };
    // 调用时解析生成设置，让循环、压缩和派生执行都能读取会话的最新配置。
    const live = currentProvider(() => state.generation.provider, () => {
      const bindings = state.modelCredentialBindings;
      if (bindings === undefined) return;
      const configuredModel = state.generation.model ?? {};
      // 没有模型配置时，提供方由进程内调用者注入，不使用配置中的 HTTP 凭据。
      if (Object.keys(configuredModel).length === 0) return;
      const model = resolveModel(configuredModel);
      if (!hasModelCredentialBinding(bindings, model.api, model.baseURL, model.apiKeyEnv ?? 'LIGULE_API_KEY')) {
        throw new KernelError('provider_credential_unbound', { detail: 'the selected model endpoint and credential reference must be bound in user configuration or command-line flags' });
      }
    }, () => state.taskBudget);
    let recoveredPolicyState: PolicyState | undefined;
    await session.acquire();
    const cleanup = [];
    try {
    const captureGrant = await activeDelegation();
    // Grant 会在会话存续期间被撤销或过期：复审前重新读一次，本次复审的事实与证据共用这份快照。
    let liveGrant: typeof captureGrant = captureGrant;
    // 重读失败说明授权状态未知：按失效处理，别让空白被读成“没有约束”。
    let grantCheckFailed = false;
    const initialCapture = agentControl === undefined ? screenCaptureConsent : captureGrant?.allowScreenCapture === true;
    if (initialCapture) {
      if (recover && ((await session.header())?.formatVersion ?? 0) < 1) throw new KernelError('session_screen_capture_format_unsupported');
      await session.append({ kind: 'screenCapture', ignorable: true, enabled: true,
        source: agentControl === undefined ? 'startup' : 'grant', at: new Date().toISOString() });
      state.screenCapture.enabled = true;
      state.screenCapture.source = agentControl === undefined ? 'startup' : 'grant';
    }
    const authorizeScreenCapture = async (): Promise<AbortSignal> => {
      if (!state.screenCapture.enabled) throw new KernelError('screen_capture_not_authorized');
      if (agentControl !== undefined && (await activeDelegation())?.allowScreenCapture !== true) throw new KernelError('screen_capture_not_authorized');
      state.screenCapture.controller.signal.throwIfAborted();
      return state.screenCapture.controller.signal;
    };
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
        const recoveredOverride = readPolicyOverride(savedPolicy.override, savedPolicy.semantics);
        if (recoveredOverride === 'unknown') {
          throw new KernelError('session_policy_event_invalid', { detail: 'the saved approval mode cannot be interpreted' });
        }
        recoveredPolicyState = {
          override: recoveredOverride,
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
        // 续开记录只持久化显式输出预算；上限由当前 Grant 重新派生，避免旧记录绕过新上限。
        const options = withOutputCeiling(generationOptionsOf(saved), grant?.maxOutputTokens);
        state.generation = { provider: deriveProvider({ ...config, model }, options), model, explicit: selection !== undefined, options };
      } else {
        const previous = events.filter((event) => event.kind === 'modelSelection').at(-1);
        if (previous !== undefined) {
          const selection = modelSelection({ provider: previous.provider, model: previous.model });
          const model = { ...(env.generation?.model ?? modelConfigOf(config)), selection };
          const options = withOutputCeiling({}, grant?.maxOutputTokens);
          state.generation = { provider: deriveProvider({ ...config, model }, options), model, explicit: true, options };
        } else if (grant?.maxOutputTokens !== undefined && env.generation !== undefined) {
          // 续开记录没有显式选择时沿用 Host 的默认生成设置，但仍需套上当前 Grant 的预算上限。
          const model = env.generation.model;
          const options = withOutputCeiling(env.generation.options, grant.maxOutputTokens);
          state.generation = { provider: deriveProvider({ ...config, model }, options), model, options };
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
    // 复审只在配置显式启用时存在；未启用时 `auto` 与 P9.5 行为一致。
    const mergedReviewSettings = reviewerSettings(config);
    // 项目配置不能自己打开付费请求：`enabled` 只认用户配置与命令行；预算只能被收紧，
    // 不能被合并后的项目层放大。
    const trustedReviewSettings = trustedLayers === undefined
      ? mergedReviewSettings
      : reviewerSettings(trustedLayers);
    const reviewSettings = mergedReviewSettings === undefined || trustedReviewSettings === undefined
      ? undefined
      : narrowReviewerSettings(mergedReviewSettings, trustedReviewSettings);
    // 复审不选自己的模型：它用的就是这一轮 Run 的 Session generation（同一个 Provider、
    // 同一个端点、同一份凭据绑定），只额外压一个输出预算。
    if (reviewSettings !== undefined) {
      const ignoredRouteFields = reviewerRouteFields(config);
      if (ignoredRouteFields.length > 0) {
        try {
          logger?.log?.('reviewer ignores route fields from an untrusted configuration layer', {
            sessionId: id, fields: ignoredRouteFields.join(','),
          });
        } catch { /* 记录失败不影响会话 */ }
      }
    }
    const reviewer = reviewSettings === undefined ? undefined : (() => {
      return createSessionReviewer({
        settings: reviewSettings,
        provider: () => state.generation.provider.withGeneration({ outputTokensCeiling: reviewSettings.maxOutputTokens }),
        factsOf: (request: PolicyReviewRequest): ReviewFacts => ({
          tool: request.tool,
          args: request.input,
          ...(request.command === undefined ? {} : { command: request.command }),
          policyMode: request.policy,
          permission: { profile: state.permission.profile, network: state.permission.network },
          boundary: env.projectRoot,
          workingDirectory: env.projectRoot,
          workspaceTrusted,
          ...(request.reason === undefined ? {} : { reason: request.reason }),
          // 用户原文只作事实，不会进入主 Agent 的模型投影。
          // 只有人类写的约束算授权事实；外控写入的“用户原文”只是请求。
          userInstructions: (state.reviewEvidence?.constraints ?? []).filter((item) => item.source === 'user').map((item) => item.text),
          ...(state.reviewEvidence === undefined ? {} : { evidence: state.reviewEvidence }),
          rules: [
            ...state.sessionPolicyRules.map((rule) => reviewRuleOf(rule, 'session')),
            ...(policy?.rules ?? []).map((rule) => reviewRuleOf(rule, 'config')),
          ],
          ...(liveGrant === undefined ? {} : {
            grant: {
              id: liveGrant.id,
              active: !grantCheckFailed && isGrantActive(liveGrant),
              scope: liveGrant.projectRoot,
              ...(liveGrant.allowedPolicies === undefined ? {} : { allowedPolicies: liveGrant.allowedPolicies }),
            },
          }),
        }),
        logger: (message, detail) => {
          try { logger?.log?.(message, { ...detail, sessionId: id }); } catch { /* 记录失败不影响审批结果 */ }
        },
        onUsage: (event) => {
          // 复审用量单独成账（purpose=reviewer），与主 Agent 的 usage 事件分开统计。
          if (event === null) return;
          void session.append(event).catch((error: unknown) => {
            try { logger?.log?.('failed to record reviewer usage', { sessionId: id, session_error: String(error) }); } catch { /* 忽略 */ }
          });
        },
      });
    })();

    if (reviewer !== undefined) state.reviewer = reviewer;
    // 复审结论写入会话审计（不影响模型投影）：只记录结论、原因码和耗时。
    // 用量由独立的 `purpose: 'reviewer'` usage 事件记账，审计事件不再重复记 token。
    const recordReview = reviewer === undefined ? undefined : async (request: PolicyReviewRequest): Promise<PolicyReviewRecord> => {
      const startedAt = Date.now();
      // 复审前重新读一次 Grant：会话创建时的那份快照无法反映之后的撤销与到期。
      // 重读失败说明授权状态未知：保留旧记录但按失效处理，让复审转人工而不是沿用旧放行依据。
      // 复审期间也要再读一次：撤销之后才到达的 allow 不能沿用复审前的结论。
      const refreshGrant = async (): Promise<void> => {
        if (agentControl === undefined) return;
        try {
          liveGrant = await activeDelegation();
          grantCheckFailed = false;
        } catch {
          grantCheckFailed = true;
        }
      };
      await refreshGrant();
      // 每次复审前从原始 Session 事件重建可信证据：早期约束、撤销与收紧、相关历史都带 seq。
      // Grant 是否有效由 Host 单独判定并可能直接转人工，因此不混进证据列表。
      const evidence = await selectReviewEvidence(session, { tool: request.tool });
      const appendAudit = async (record: {
        readonly decision: 'allow' | 'deny' | 'ask-human';
        readonly reasonCode?: string;
        readonly reason?: string;
        readonly includedSeqs?: readonly number[];
      }): Promise<void> => {
        try {
          await session.append({
            kind: 'policyReview',
            ignorable: true,
            at: new Date().toISOString(),
            tool: request.tool,
            review: record.decision,
            ...(record.reasonCode === undefined ? {} : { reasonCode: record.reasonCode }),
            make: 'session-reviewer',
            durationMs: Date.now() - startedAt,
            // 证据来源可回查：只记真正送进提示词的序号，预算丢掉的历史不冒领。
            ...(record.includedSeqs === undefined || record.includedSeqs.length === 0 ? {} : { evidenceSeqs: [...record.includedSeqs] }),
            ...(record.reason === undefined ? {} : { reason: record.reason }),
          });
        } catch (error) {
          logger?.log?.('failed to record the review decision', { sessionId: id, session_error: String(error) });
        }
      };
      if (evidence === undefined) {
        // 读不到原始日志时不能复用上一轮的约束：自动放行的安全性依赖“证据仍然是当前的”。
        // 复用旧快照会让撤销或收紧失效，所以本次直接转人工，并把结论写进审计。
        state.reviewEvidence = undefined;
        const stale = staleReviewOutcome();
        await appendAudit(stale);
        return stale;
      }
      state.reviewEvidence = evidence;
      // Grant 的有效性由 Host 判定，不交给模型：撤销、到期或重读失败都必须直接拦下，
      // 否则失效的授权只能作为提示词里的一条事实，仍然可能被复审放行。
      if (grantCheckFailed || (liveGrant !== undefined && !isGrantActive(liveGrant))) {
        const inactive = inactiveGrantOutcome();
        await appendAudit(inactive);
        return inactive;
      }
      const outcome = await reviewer.review(request);
      // 复审是一次真实网络请求，期间 Grant 可能被撤销或到期。撤销之后才到达的 allow
      // 不能沿用复审前的检查：那会把“授权已经收回”变成“模型同意所以放行”。
      await refreshGrant();
      if (outcome.decision === 'allow' && (grantCheckFailed || (liveGrant !== undefined && !isGrantActive(liveGrant)))) {
        const inactive = inactiveGrantOutcome();
        await appendAudit(inactive);
        return inactive;
      }
      await appendAudit(outcome);
      return outcome;
    };
    const chain = createDecisionChain({
      ...policy,
      rules: mergePolicyRules([
        { source: 'session', rules: state.sessionPolicyRules },
        { source: 'config', rules: policy?.rules ?? [] },
      ]).rules as PolicyRule[],
      ...(recordReview === undefined ? {} : { review: recordReview }),
      ask: async ({ tool, input, command, reason, shell, executable, policy, policySource, policyForced, rememberable, scriptBinding, callId, identityDigest }): Promise<PolicyAskResult> => {
        const telemetryContext = telemetryEnabled(telemetry) ? currentTelemetryContext() : undefined;
        const telemetryApprovalRunId = telemetryContext?.runId
          ?? (telemetryContext?.sessionId === undefined || telemetryContext.sessionId === id ? state.activeRunId : undefined);
        const rememberScopes: PolicyRememberScope[] = permissionControl && rememberable
          ? ['session', ...(state.environment.store === undefined ? [] : ['project' as const, 'user' as const])]
          : [];
        const requestId = randomUUID();
        const childRunId = currentKernelExecutionContext()?.runId;
        const interactionRunId = childRunId ?? state.activeRunId;
        const requestSteeringRevision = runInputRevisionOf(state, interactionRunId);
        let summary;
        try {
          summary = summarizeApproval({
            requestId, sessionId: id, runId: state.progressId, callId, identityDigest, tool, args: input, command, reason,
            policy, policySource, policyForced,
            ...(shell === undefined ? {} : { shell, executable }),
          });
        } catch (error) {
          const failure = error instanceof KernelError ? error : new KernelError('policy_approval_unreviewable', { cause: error });
          return { decision: 'unavailable' as const, code: failure.code, reason: 'This operation could not be reviewed safely.' };
        }
        const approvalArgs = structuredClone(input) as Record<string, unknown>;
        pendingApprovalDetails.set(requestId, { sessionId: id, args: approvalArgs, argumentSha256: summary.argumentSha256 });
        let approvalActive = true;
        let settle = (): void => {};
        const cancelled = new Promise<{ decision: 'cancelled'; code: string }>((resolve) => {
          settle = () => { approvalActive = false; resolve({ decision: 'cancelled', code: 'policy_approval_cancelled' }); };
        });
        const pendingAsk = { requestId, settle };
        trackAsk(state, pendingAsk, interactionRunId);
        if (childRunId !== undefined) state.subagents?.interaction(childRunId, 'approval', true);
        const endInteraction = state.taskBudget?.startInteraction();
        updateWaitingForUser(state as HostSessionState, connection, true, 'approval');
        const approvalStartedAt = telemetryContext === undefined ? 0n : process.hrtime.bigint();
        if (telemetryContext?.executionId !== undefined) emitTelemetry(telemetry, { type: 'approval.started',
          executionId: telemetryContext.executionId, ...(telemetryApprovalRunId === undefined ? {} : { runId: telemetryApprovalRunId }),
          sessionId: telemetryContext.sessionId ?? id,
          ...(telemetryContext.userSeq === undefined ? {} : { userSeq: telemetryContext.userSeq }),
          ...(telemetryContext.parentExecutionId === undefined ? {} : { parentExecutionId: telemetryContext.parentExecutionId }),
          ...(telemetryContext.parentRunId === undefined ? {} : { parentRunId: telemetryContext.parentRunId }),
          ...(telemetryContext.parentCallId === undefined ? {} : { parentCallId: telemetryContext.parentCallId }),
          ...(callId === undefined ? {} : { callId }), requestId });
        try {
          // 仅在等待事件已经落盘后才向客户端发起审批，避免持久化失败时出现未记账的等待状态。
          await appendToolActivity(state as HostSessionState, 'awaiting_approval', tool, requestId, callId);
          const answer = await Promise.race([
            connection.request(APPROVAL_METHOD, {
              ...summary,
              projectRoot: env.projectRoot,
              rememberable: rememberScopes.length > 0,
              rememberScopes,
              ...(state.operationSourceSessionId === undefined ? {} : { sourceSessionId: state.operationSourceSessionId }),
              ...(scriptBinding === undefined ? {} : { scriptBinding }),
            }).then(async (value) => {
              if (!approvalActive || requestSteeringRevision !== runInputRevisionOf(state, interactionRunId)) {
                return { decision: 'cancelled' as const, code: 'policy_approval_cancelled' };
              }
              const response = isRecord(value) ? value : value === true ? { decision: 'allow' } : value === false ? { decision: 'deny' } : {};
              const source = response.source === 'controller' ? 'controller' as const : 'human' as const;
              if (response.decision === 'allow') {
                if (approvalArgsDigest(input) !== summary.argumentSha256) {
                  return { decision: 'error' as const, code: 'policy_approval_arguments_changed' };
                }
                const rememberScope = response.rememberScope;
                if (rememberScope === undefined) return { decision: 'allow' as const, source };
                if (source !== 'human') return { decision: 'error' as const, code: 'policy_memory_trusted_user_required' };
                if (rememberScope !== 'session' && rememberScope !== 'project' && rememberScope !== 'user') {
                  return { decision: 'error' as const, code: 'policy_memory_unavailable' };
                }
                if (!rememberScopes.includes(rememberScope)) return { decision: 'error' as const, code: 'policy_memory_unavailable' };
                const rememberTarget = response.rememberTarget;
                if (rememberTarget !== undefined && rememberTarget !== 'file' && rememberTarget !== 'workspace'
                  && rememberTarget !== 'tool' && rememberTarget !== 'command') {
                  return { decision: 'error' as const, code: 'policy_memory_target_invalid' };
                }
                try {
                  await rememberPolicyRule(
                    state as HostSessionState, tool, input, command, rememberScope, rememberTarget, identityDigest,
                  );
                } catch (error) {
                  const failure = error instanceof KernelError ? error : new KernelError('policy_memory_write_failed', { cause: error });
                  logger?.log?.('approval memory was not saved', { tool, code: failure.code });
                  return { decision: 'error' as const, code: failure.code, reason: failure.detail ?? 'the remembered rule was not saved' };
                }
                return { decision: 'allow' as const, source };
              }
              if (response.decision === 'deny') {
                return {
                  decision: 'deny' as const,
                  source,
                  code: source === 'human' ? 'ask_declined' : 'controller_declined',
                  reason: source === 'human' ? 'the user declined' : 'the controller declined',
                };
              }
              if (response.decision === 'unavailable' || response.decision === 'error'
                || response.decision === 'cancelled' || response.decision === 'timeout') {
                const decision = response.decision as 'unavailable' | 'error' | 'cancelled' | 'timeout';
                return {
                  decision,
                  code: typeof response.code === 'string' ? response.code : 'policy_approval_channel_error',
                  ...(typeof response.reason === 'string' ? { reason: response.reason } : {}),
                };
              }
              return { decision: 'error' as const, code: 'policy_approval_response_invalid' };
            }, (error) => {
              const code = errorCode(error) ?? 'policy_approval_channel_error';
              logger?.log?.(`approval failed for ${tool}`, { tool, code });
              return { decision: 'error' as const, code, reason: 'approval channel failed' };
            }),
            cancelled,
          ]);
          if (telemetryContext?.executionId !== undefined) emitTelemetry(telemetry, { type: 'approval.finished', executionId: telemetryContext.executionId,
            ...(telemetryApprovalRunId === undefined ? {} : { runId: telemetryApprovalRunId }), sessionId: telemetryContext.sessionId ?? id,
            ...(telemetryContext.userSeq === undefined ? {} : { userSeq: telemetryContext.userSeq }),
            ...(telemetryContext.parentExecutionId === undefined ? {} : { parentExecutionId: telemetryContext.parentExecutionId }),
            ...(telemetryContext.parentRunId === undefined ? {} : { parentRunId: telemetryContext.parentRunId }),
            ...(telemetryContext.parentCallId === undefined ? {} : { parentCallId: telemetryContext.parentCallId }),
            ...(callId === undefined ? {} : { callId }), requestId,
            durationMs: Number((process.hrtime.bigint() - approvalStartedAt) / 1_000_000n),
            decision: answer.decision === 'allow' ? 'allow' : answer.decision === 'deny' ? 'deny'
              : answer.decision === 'cancelled' ? 'cancelled' : 'error',
            ...(answer.decision === 'error' || answer.decision === 'cancelled' ? { errorCode: answer.code } : {}) });
          return answer;
        } finally {
          approvalActive = false;
          endInteraction?.();
          pendingApprovalDetails.delete(requestId);
          untrackAsk(state, pendingAsk, interactionRunId);
          if (childRunId !== undefined) state.subagents?.interaction(childRunId, 'approval', false);
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
    let extensionHookRegistry: ExtensionHookRegistry | undefined;
    const createFiniteCommandController = (commandSessionId: string, commandSession: SessionLog, projectRoot: string) => {
      const projectIdentity = workspaceIdentity(projectRoot);
      const ownerOf = async (context: ExecRunContext, check?: CheckDeclaration): Promise<FiniteCommandOwner> => {
        if (context.sessionId !== commandSessionId || typeof context.runId !== 'string' || context.runId === ''
          || typeof context.callId !== 'string' || context.callId === '') {
          throw new KernelError('execution_context_unavailable');
        }
        const owner: FiniteCommandOwner = {
          projectIdentity,
          projectRoot,
          sessionId: commandSessionId,
          runId: context.runId,
          callId: context.callId,
          ...(context.parentRunId === undefined ? {} : { parentRunId: context.parentRunId }),
          ...(state.managedGrantId === undefined ? {} : { grantId: state.managedGrantId }),
          workspaceTrusted: context.permission.workspaceTrusted,
        };
        if (check === undefined) return owner;
        const declaration = checkedCheckDeclaration(check);
        if (declaration === undefined) throw new KernelError('exec_check_declaration_invalid');
        const header = await commandSession.header();
        if ((header?.formatVersion ?? 0) < 5) throw new KernelError('check_session_format_unsupported');
        return { ...owner, check: declaration,
          checkScopeStart: await sampleCheckScope(context.config, context.permission, declaration) };
      };
      return {
        async start(args: { command?: unknown; cwd?: string; check?: CheckDeclaration }, context: ExecRunContext, waitMs: number) {
          const owner = await ownerOf(context, args.check);
          const budget = state.taskBudget;
          if (budget === undefined) throw new KernelError('execution_task_budget_unavailable');
          const reservation = await finiteCommands.reserve({
            owner,
            session: commandSession,
            timeoutMs: limitsOf(config).execTimeoutMs,
            signal: context.signal,
            startWork: () => {
              const work = budget.startWork();
              if (state.operationOnly !== true || state.taskBudget !== budget) return work;
              let disposed = false;
              const dispose = () => {
                if (disposed) return;
                disposed = true;
                work.dispose();
                if (state.taskBudget === budget) {
                  state.lastTask = budget.snapshot();
                  state.taskBudget = undefined;
                  budget.dispose();
                }
              };
              const tracked: TaskWork = {
                suspend: () => work.suspend(),
                resume: () => work.resume(),
                dispose,
              };
              return tracked;
            },
          });
          if (owner.check !== undefined) finiteCheckContexts.set(reservation.executionId, {
            session: commandSession, config: context.config, permissionAtStart: context.permission, currentPermission: () => state.permission,
          });
          try {
            return await runManagedExec(args, context, (lease) => finiteCommands.attach(reservation, lease, context.signal, waitMs),
              { capturePagedLogs: true });
          } catch (error) {
            await finiteCommands.failReservation(reservation, error).catch(() => undefined);
            finiteCheckContexts.delete(reservation.executionId);
            throw error;
          }
        },
        async control(args: ExecControlArguments, context: ExecRunContext) {
          const owner = await ownerOf(context);
          switch (args.action) {
            case 'status': return finiteCommands.status(owner, args.executionId);
            case 'wait': return await finiteCommands.wait(owner, args.executionId, args.waitMs ?? 30_000, context.signal);
            case 'logs': return finiteCommands.logs(owner, args.executionId, args.cursor, args.limitBytes);
            case 'cancel': return await finiteCommands.cancel(owner, args.executionId);
          }
        },
      };
    };
    const kernel = createKernel({ config, policy: chain, session, logger, fileChangeStore: state.fileChanges,
      fileWriteQueue,
      permissionForCall: () => state.permission,
      policyOverrideForSession: () => state.policyOverride,
      extensionHooks: () => extensionHookRegistry,
      taskBudget: () => state.taskBudget,
      execController: () => createFiniteCommandController(id, state.session, env.projectRoot),
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
    const assertMcpAccess = (server: string): void => {
      if (server !== BROWSER_SERVER) return;
      if (state.permissionChanging) throw new KernelError('permission_change_in_progress');
      const denied = permissionDenial(state.permission, 'external');
      if (denied !== undefined) throw new KernelError(denied.code, { detail: denied.reason });
      if (state.browserPaused) throw new KernelError('browser_stopped');
    };
    const sessionMcpConfigs = await Promise.all(mcpConfigs.map(server => server.name === BROWSER_SERVER ? browser.session(id) : server));
    const mcp = createMcpRegistry(sessionMcpConfigs, { toolPolicy: browserToolPolicy, assertServerAccess: assertMcpAccess,
      afterCall: name => name === BROWSER_SERVER ? browser.clearSession(id) : Promise.resolve() });
    cleanup.push(() => browser.closeSession(id));
    cleanup.push(() => mcp.close());
    const authorizeMcpServer = async (server: string): Promise<void> => {
      if (server === BROWSER_SERVER) {
        assertMcpAccess(server);
        await browser.verify();
      }
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
      if (server === BROWSER_SERVER) {
        if (browserToolPolicy(server, tool, { type: 'object', properties: {} }) === undefined) throw new KernelError('browser_tool_denied');
        if (tool === 'browser_take_screenshot' && live.imageInput !== true) throw new KernelError('model_image_input_unsupported');
      }
      const grant = await activeDelegation();
      if (grant !== undefined) {
        await assertDelegationProject(grant, env.projectRoot);
        assertDelegationMcpTool(grant, `mcp:${server}/${tool}`);
      }
    };
    const mcpAuthorization: McpAuthorization = {
      authorizeArguments: (server, tool, args) => { if (server === BROWSER_SERVER) assertBrowserArguments(tool, args); },
      authorizeServer: authorizeMcpServer,
      authorizeTool: authorizeMcpTool,
      identityDigest: (server) => mcpConfigs.find((entry) => entry.name === server)?.identityDigest,
    };
    // 用户在数据根 tools/ 声明的命令工具与技能同源：发现于用户目录，加载不授予额外权限，
    // 执行仍按 exec 能力走 Permission 与 Policy 判定链。
    const customTools = await discoverCustomTools(join(dataRoot(), 'tools'));
    for (const diagnostic of customTools.diagnostics) {
      logger?.log?.('custom tool is not loaded', { code: diagnostic.code, path: diagnostic.path, reason: diagnostic.detail });
    }
    const customToolPlugin = customToolsPluginOf(customTools);
    const loaded = [
      ...plugins,
      ...(skills.skills.length === 0 ? [] : [createSkillPlugin(skills, () => mcp.servers())]),
    ];
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
    const basePlugins = [...loaded, ...(search.plugin === undefined ? [] : [search.plugin])];
    // 提问属于父会话，因为派生执行没有客户端可以回答。
    // 提问和审批走不同流程；只有支持交互回答的客户端才注册提问工具。
    const asked = interactive === false ? [] : [createAskUserPlugin({
      ask: async (questions) => {
        const childRunId = currentKernelExecutionContext()?.runId;
        const interactionRunId = childRunId ?? state.activeRunId;
        const questionSteeringRevision = runInputRevisionOf(state, interactionRunId);
        const requestId = randomUUID();
        let settle = (): void => {};
        const cancelled = new Promise<'cancelled'>((resolve) => {
          settle = () => resolve('cancelled');
        });
        const pendingAsk = { requestId, settle };
        trackAsk(state, pendingAsk, interactionRunId);
        if (childRunId !== undefined) state.subagents?.interaction(childRunId, 'question', true);
        const endInteraction = state.taskBudget?.startInteraction();
        updateWaitingForUser(state as HostSessionState, connection, true, 'input');
        try {
          await appendToolActivity(state as HostSessionState, 'awaiting_user', 'ask_user', requestId);
          const outcome = await Promise.race([
            // 交互等待受整次任务累计等待预算约束。
            connection.request(QUESTION_METHOD, { requestId, sessionId: id, projectRoot: env.projectRoot, questions }).then((value) => {
              if (questionSteeringRevision !== runInputRevisionOf(state, interactionRunId)) {
                throw new KernelError('ask_user_cancelled', { detail: `${id}: the question was superseded by steering input` });
              }
              return value;
            }),
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
          endInteraction?.();
          untrackAsk(state, pendingAsk, interactionRunId);
          if (childRunId !== undefined) state.subagents?.interaction(childRunId, 'question', false);
          updateWaitingForUser(state as HostSessionState, connection, false, 'input');
        }
      },
    })];
    const subagents = createSubagentPlugin({
      config,
      fileWriteQueue,
      provider: live,
      chain,
      prompt,
      directory,
      sessionId: id,
      logger,
      plugins: basePlugins,
      customToolPlugin,
      authorizeScreenCapture,
      taskBudget: () => state.taskBudget,
      finiteCommands,
      createExecController: (childId, childSession) => createFiniteCommandController(childId, childSession, env.projectRoot),
      extensionHooks: () => extensionHookRegistry,
      telemetry,
      requestDiagnosticsEnabled: () => state.requestDiagnostics.enabled,
      onRequestDiagnostic: (diagnostic) => appendRequestDiagnostic(state.requestDiagnostics, diagnostic),
      onSubrunMessageAccepted: (runId) => settleRunAsks(state, runId),
      createMcp: async (childId, childMedia) => {
        const servers = await Promise.all(mcpConfigs.map(server => server.name === BROWSER_SERVER ? browser.session(childId) : server));
        const childRegistry = createMcpRegistry(servers, { toolPolicy: browserToolPolicy, assertServerAccess: assertMcpAccess,
          afterCall: name => name === BROWSER_SERVER ? browser.clearSession(childId) : Promise.resolve() });
        state.childMcp.set(childRegistry, childId);
        return { plugin: createMcpPlugin(childRegistry, mcpAuthorization, { media: childMedia,
          sourceFor: server => server === BROWSER_SERVER ? 'browser' : undefined }),
          close: async () => { try { await childRegistry.close(); await browser.closeSession(childId); } finally { state.childMcp.delete(childRegistry); } } };
      },
      modePaths,
      ...(modePaths === undefined ? {} : {
        presetDirectories: agentPresetDirectories(env.projectRoot, join(dirname(modePaths.shipped), 'agents'), dirname(modePaths.user)),
      }),
      modeFile: () => state.mode.file,
      promptFragments: () => fragments,
      promptFragmentBytes: limitsOf(config).promptFragmentBytes,
      loopLimits: sessionLoopLimits(state),
      parentSession: session,
    });
    const requestView = permissionControl ? async (args: ViewRequestArguments, context: import('../kernel/kernel.js').ToolContext): Promise<ViewRequestResult> => {
      const unavailable: ViewRequestResult = { status: 'view_unavailable', opened: false, read: false };
      const runId = context.runId;
      if (context.sessionId !== id || runId === undefined || state.activeRunId !== runId || state.operationOnly === true) {
        throw new KernelError('view_request_scope_invalid');
      }
      context.signal?.throwIfAborted();
      const denied = permissionDenial(state.permission, 'read');
      if (denied !== undefined) throw new KernelError(denied.code, { detail: denied.reason });

      let target: Record<string, unknown>;
      if (args.kind === 'file') {
        if (args.path === undefined || args.executionId !== undefined || args.subrunId !== undefined) {
          throw new KernelError('view_request_arguments_invalid');
        }
        const file = await readProjectFile(env.config, id, args.path, 0, 64_000);
        if (file.encoding !== 'utf8' || typeof file.version !== 'string') throw new KernelError('view_resource_unavailable');
        target = { kind: 'file', projectRoot: env.projectRoot, path: file.path, version: file.version };
      } else if (args.kind === 'directory') {
        if (args.path === undefined || args.executionId !== undefined || args.subrunId !== undefined) {
          throw new KernelError('view_request_arguments_invalid');
        }
        const directory = await listProjectDirectory(env.config, args.path, 0, 1);
        target = { kind: 'directory', projectRoot: env.projectRoot, path: directory.path };
      } else if (args.kind === 'diff') {
        if (args.path === undefined || args.executionId !== undefined || args.subrunId !== undefined) {
          throw new KernelError('view_request_arguments_invalid');
        }
        const diff = await readProjectGitDiff(env.projectRoot, boundaryOf(env.config), args.path);
        const version = projectGitDiffVersion(diff);
        if (version === undefined) throw new KernelError('view_resource_unavailable');
        target = { kind: 'git', projectRoot: env.projectRoot, path: diff.path, version };
      } else if (args.kind === 'command') {
        if (args.path !== undefined || args.executionId === undefined || args.subrunId !== undefined) {
          throw new KernelError('view_request_arguments_invalid');
        }
        let reference: Record<string, string> | undefined;
        for (const candidate of sessions.values()) {
          if (candidate.operationOnly !== true || candidate.operationId === undefined) continue;
          const events = await candidate.session.read();
          const operation = events.find(event => event.kind === 'operationStarted'
            && event.sourceSessionId === id && event.operationId === candidate.operationId);
          if (operation === undefined) continue;
          finiteCommands.status({ projectIdentity: workspaceIdentity(env.projectRoot),
            sessionId: candidate.id, runId: candidate.operationId }, args.executionId);
          reference = { sourceSessionId: id, operationSessionId: candidate.id,
            operationId: candidate.operationId, executionId: args.executionId };
          break;
        }
        if (reference === undefined) throw new KernelError('view_resource_unavailable');
        target = { kind: 'command', reference };
      } else {
        if (args.path !== undefined || args.executionId !== undefined || args.subrunId === undefined) {
          throw new KernelError('view_request_arguments_invalid');
        }
        const subrun = await state.subagents?.status(args.subrunId, runId);
        if (subrun === undefined) throw new KernelError('view_resource_unavailable');
        if (subrun.parentRunId !== runId || subrun.runId === undefined) throw new KernelError('view_resource_unavailable');
        target = { kind: 'subrun', sessionId: id, parentRunId: runId, subrunId: subrun.subrunId,
          childSessionId: subrun.sessionId, childRunId: subrun.runId };
      }

      const requestId = randomUUID();
      const createdAt = new Date().toISOString();
      await state.session.append({ kind: 'viewRequest', ignorable: true, source: 'desktop', requestId,
        runId, targetKind: args.kind, createdAt });
      let response: unknown;
      try {
        response = await connection.request(VIEW_REQUEST_METHOD, { sessionId: id, runId, requestId, target });
      } catch (error) {
        const failure = errorCode(error);
        if (['connection_closed', 'protocol_method_unknown', 'connection_handler_failed'].includes(failure ?? '')) {
          await state.session.append({ kind: 'viewRequestUnavailable', ignorable: true, source: 'desktop',
            requestId, runId, createdAt: new Date().toISOString() });
          return unavailable;
        }
        throw error;
      }
      context.signal?.throwIfAborted();
      if (!isRecord(response) || response.status !== 'sent') {
        await state.session.append({ kind: 'viewRequestUnavailable', ignorable: true, source: 'desktop',
          requestId, runId, createdAt: new Date().toISOString() });
        return unavailable;
      }
      await state.session.append({ kind: 'viewRequestDelivered', ignorable: true, source: 'desktop',
        requestId, runId, createdAt: new Date().toISOString() });
      connection.notify({ notify: 'view.ready', sessionId: id, requestId });
      return { status: 'sent', opened: false, read: false };
    } : undefined;
    const assembly = loadAssembly(kernel, [...basePlugins, createMcpPlugin(mcp, mcpAuthorization, { media,
      sourceFor: server => server === BROWSER_SERVER ? 'browser' : undefined }), createTodoWritePlugin({ session }),
      createReadImagePlugin({ media, supportsImages: () => live.imageInput === true }),
      createReadDocumentPlugin({ media, supportsImages: () => live.imageInput === true }),
      createPresentPlugin({ sessionId: id, workspaceRoot: env.projectRoot, session,
        ...(requestView === undefined ? {} : { requestView }) }),
      createScreenshotPlugin({ media, supportsImages: () => live.imageInput === true, authorize: authorizeScreenCapture }),
      managedProcessPlugin(managedProcesses), ...asked, createCompactPlugin({
      // 压缩实例随所选模型重建；工具经取值函数读取当前实例。派生子会话不注册此工具，
      // 子会话仍由自身构建的自动压缩管理预算。
      compaction: () => state.compaction ?? null,
      session,
      directory,
      id,
    }),
      ...(customToolPlugin === undefined ? [] : [customToolPlugin]),
      subagents]);
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
      request: async (tool, args) => {
        const parent = currentKernelExecutionContext();
        if (parent === undefined || !parent.scope.active) throw new KernelError('extension_request_context_unavailable');
        if (parent.signal.aborted) {
          const reason = parent.signal.reason;
          throw reason instanceof KernelError ? reason : new KernelError('loop_cancelled', { cause: reason });
        }
        if (parent.extensionHookPhase === 'beforeTool' || parent.extensionHookPhase === 'afterTool') {
          throw new KernelError('extension_hook_request_unavailable');
        }
        if (parent.extensionHookPhase === 'prepareRequest' || parent.extensionHookPhase === 'completeRun') {
          if (parent.extensionRequest === undefined) throw new KernelError('extension_request_context_unavailable');
          return await parent.extensionRequest(tool, args);
        }
        const callId = randomUUID();
        const child = { ...parent, callId, parentCallId: parent.callId, scope: { active: true } };
        try {
          return await withKernelExecutionContext(child, () => kernel.call(tool, args, {
            signal: parent.signal,
            callId,
            parentCallId: parent.callId,
            ...(parent.sessionId === undefined ? {} : { sessionId: parent.sessionId }),
            ...(parent.runId === undefined ? {} : { runId: parent.runId }),
            ...(parent.executionId === undefined ? {} : { executionId: parent.executionId }),
            ...(parent.userSeq === undefined ? {} : { userSeq: parent.userSeq }),
            ...(parent.parentRunId === undefined ? {} : { parentRunId: parent.parentRunId }),
            ...(parent.parentExecutionId === undefined ? {} : { parentExecutionId: parent.parentExecutionId }),
          }));
        } finally {
          child.scope.active = false;
        }
      },
    });
    extensionHookRegistry = installedExtensions.hooks;
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
      // 会话显式设置的输出预算优先于模型声明；两者都缺省时不预留。
      const override = state.generation.options.outputTokens;
      const limits = compactionLimitsOf(config, selectedModel.serviceContextTokens, override ?? selectedModel.outputTokens);
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
      prepare: (request, signal, collectDiagnostics) => state.compaction?.prepare(request, signal, collectDiagnostics) ?? Promise.resolve(request.messages),
      recover: (error, request, signal, collectDiagnostics) => state.compaction?.recover(error, request, signal, collectDiagnostics) ?? Promise.resolve(null),
      observe: async (request, events) => {
        const current = state.compaction;
        if (current !== undefined && current !== null) await current.observe(request, events);
        else {
          // 端点没报用量也要留一条：否则会话看起来一次请求都没发生过。
          const usage = usageEvent(request, events, 'agent', { unknownWhenUnreported: true });
          if (usage !== null) await session.append(usage);
        }
      },
      diagnostics: () => state.compaction?.diagnostics(),
      seedDiagnostics: (diagnostics) => state.compaction?.seedDiagnostics(diagnostics),
      resetDiagnostics: () => state.compaction?.resetDiagnostics(),
    };
    const loop = createLoop({
      kernel,
      provider: observedProvider(live, (event) => connection.notify({ notify: 'delta', sessionId: id, event })),
      prompt,
      session,
      limits: sessionLoopLimits(state),
      resolveImage: media.read,
      compaction: loopCompaction,
      telemetry,
      sessionId: id,
      telemetryModel: () => ({ provider: state.generation.provider.name,
        ...(state.generation.provider.model === null ? {} : { model: state.generation.provider.model }) }),
      requestDiagnosticsEnabled: () => state.requestDiagnostics.enabled,
      onRequestDiagnostic: (diagnostic) => appendRequestDiagnostic(state.requestDiagnostics, diagnostic),
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
      const budget = createTaskBudget(taskLimitsOf(config, state.loopModelCalls, options.delegation?.budget), options.signal);
      state.taskBudget = budget;
      const progress = state.progress;
      options.onProgress?.({
        kind: 'phase',
        phase: progress?.phase ?? 'preparing',
        modelCalls: progress?.modelCalls ?? 0,
        toolCalls: progress?.toolCalls ?? 0,
      });
      const abortTask = () => state.running?.abort(budget.signal.reason);
      budget.signal.addEventListener('abort', abortTask, { once: true });
      if (budget.signal.aborted) abortTask();
      let structuredSubmitted = false;
      let structured: unknown;
      let completionContext = '';
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
        // 复审装配把用户原文当作仍然有效的指令；它不会进入主 Agent 的模型投影。
        // `maxPerRun` 是每轮上限：新一轮开始就重置，长会话里复审不会提前失效。
        state.reviewer?.beginRun();
        const subagents = state.subagents;
        if (subagents === undefined) throw new KernelError('subagent_runtime_unavailable');
        // 本轮拥有的外部资源按同一生命周期收口；每个资源只提供自己的动作，阶段与失败合并由这里拥有。
        const acceptedRunId = options.acceptance?.runId;
        const runResources = acceptedRunId === undefined ? undefined : runResourcesOf([
          {
            name: 'subagents',
            beginCompletionCandidate: () => subagents.beginCompletionCandidate(acceptedRunId),
            resume: () => subagents.resumeParent(acceptedRunId),
            settle: async (status) => await subagents.settleParent(acceptedRunId, status),
            finish: async () => await subagents.finishParent(acceptedRunId),
          },
          {
            name: 'finite-commands',
            beginCompletionCandidate: () => finiteCommands.beginCompletionCandidate(state.id, acceptedRunId),
            resume: () => finiteCommands.resumeRun(state.id, acceptedRunId),
            settle: async (status) => await finiteCommands.settleRun(state.id, acceptedRunId, status),
            finish: async () => await finiteCommands.finishRun(state.id, acceptedRunId),
          },
        ]);
        const result = await loop.run(input, {
          signal: budget.signal,
          task: budget,
          source: options.source ?? 'controller',
          ...(options.steering === undefined ? {} : { steering: options.steering }),
          onAccepted: options.onAccepted,
          user: { ...options.user, ...(options.acceptance === undefined ? {} : { run: options.acceptance }) },
          prepareRequest: async (context) => await prepareExtensionRequest(installedExtensions.hooks, context,
            limitsOf(state.environment.config).promptFragmentBytes, budget),
          ...(installedExtensions.hooks.forPhase('completeRun').length === 0 ? {} : {
            completeRun: async (candidate) => {
              if (candidate.sessionId === undefined || candidate.runId === undefined || candidate.userSeq === undefined) {
                throw new KernelError('extension_hook_run_context_unavailable');
              }
              const decision = await completeExtensionRun(installedExtensions.hooks, {
                sessionId: candidate.sessionId,
                runId: candidate.runId,
                source: candidate.source,
                signal: candidate.signal,
                callId: candidate.callId,
                ...(candidate.parentCallId === undefined ? {} : { parentCallId: candidate.parentCallId }),
                ...(candidate.parentRunId === undefined ? {} : { parentRunId: candidate.parentRunId }),
                ...(candidate.executionId === undefined ? {} : { executionId: candidate.executionId }),
                ...(candidate.parentExecutionId === undefined ? {} : { parentExecutionId: candidate.parentExecutionId }),
                userSeq: candidate.userSeq,
                candidate: candidate.candidate,
                ...(structuredSubmitted ? { structuredDigest: structuredOutputDigest(structured) } : {}),
                ...(candidate.completedBy === undefined ? {} : { completedBy: candidate.completedBy }),
                summary: candidate.summary,
                request: async (name, args) => {
                  if (!kernel.readOnly().includes(name)) throw new KernelError('extension_request_read_only_required');
                  const requestSignal = currentKernelExecutionContext()?.signal ?? candidate.signal;
                  return await kernel.call(name, args, {
                    signal: requestSignal,
                    sessionId: candidate.sessionId,
                    runId: candidate.runId,
                    source: candidate.source,
                    callId: randomUUID(),
                    parentCallId: candidate.callId,
                    ...(candidate.executionId === undefined ? {} : { executionId: candidate.executionId }),
                    userSeq: candidate.userSeq,
                    ...(candidate.parentRunId === undefined ? {} : { parentRunId: candidate.parentRunId }),
                    ...(candidate.parentExecutionId === undefined ? {} : { parentExecutionId: candidate.parentExecutionId }),
                  });
                },
              }, limitsOf(state.environment.config).promptFragmentBytes, budget, completionContext);
              if (decision.decision === 'continue') completionContext = decision.context;
              return decision;
            },
          }),
          onCompletionInvalidated: () => {
            structuredSubmitted = false;
            structured = undefined;
          },
          ...(runResources === undefined ? {} : {
            runId: acceptedRunId!,
            settleSubruns: async (status: 'completed' | 'failed' | 'cancelled') => await runResources.settle(status),
            beginCompletionCandidate: () => runResources.beginCompletionCandidate(),
            resumeSubruns: () => runResources.resume(),
            finishSubruns: async () => await runResources.finish(),
            persistTerminal: async (status, summary, fields) => {
              const runId = options.acceptance!.runId;
              const evidence = runEvidenceReferences(await session.read(), runId);
              const evidenceOptions = {
                ...(evidence.fileChanges.length === 0 ? {} : { fileChanges: evidence.fileChanges }),
                ...(evidence.fileChangesTruncated === undefined ? {} : { fileChangesTruncated: true as const }),
                ...(evidence.checks.length === 0 ? {} : { checks: evidence.checks }),
                ...(evidence.checksTruncated === undefined ? {} : { checksTruncated: true as const }),
              };
              const result = status === 'completed'
                ? completedRunResult(runId, state.id, {
                  ...summary,
                  ...(typeof fields.completedBy === 'string' ? { completedBy: fields.completedBy } : {}),
                }, {
                  ...(structuredSubmitted ? { structured } : {}),
                  validation: contract === undefined ? { status: 'not_requested' } : { status: 'valid', schemaDigest: contract.digest },
                  ...evidenceOptions,
                })
                : failedRunResult(runId, state.id, typeof fields.code === 'string' ? fields.code : 'loop_failed',
                  fields.diagnostics as KernelError['diagnostics'], contract === undefined ? { status: 'not_requested' } : {
                    status: 'invalid', schemaDigest: contract.digest,
                    errors: ['The run ended before a valid structured result was submitted.'],
                  }, summary, evidenceOptions);
              return await publishRunResult(session.directory, workspaceIdentity(state.environment.projectRoot), state.id, runId, result);
            },
          }),
          onProgress: options.onProgress,
          completesRun: contract === undefined ? [] : [DELEGATION_RESULT_TOOL],
          validateCompletion: () => assertDelegationCompletion(contract, structuredSubmitted),
          turnContext: {
              task: budget.snapshot(),
              ...(options.acceptance === undefined ? {} : { runContext: runContextOf(state as HostSessionState, options.delegation) }),
              ...(delegatedMode === undefined ? {} : { delegationMode: delegatedMode }),
              ...(contract === undefined ? {} : { delegationSchemaDigest: contract.digest }),
          },
        });
        const validation = contract === undefined
          ? undefined
          : { status: 'valid' as const, schemaDigest: contract.digest };
        return {
          ...result,
          ...(options.acceptance === undefined ? {} : { runId: options.acceptance.runId }),
          ...(structuredSubmitted ? { structured } : {}),
          ...(validation === undefined ? {} : { validation }),
        };
      } finally {
        state.lastTask = budget.snapshot();
        state.taskBudget = undefined;
        budget.signal.removeEventListener('abort', abortTask);
        budget.dispose();
        try { undoDelegationMode(); }
        finally {
          try { undoOutputContract(); }
          finally { disposeResultTool?.(); }
        }
      }
    };
    // 当前轮次和待处理审批都限定在所属会话内。
    const customToolNames = customTools.tools.map((tool) => tool.name).filter((name) => !customTools.diagnostics.some((diagnostic) =>
      diagnostic.code === 'custom_tool_name_conflicts_with_registered_tool' && diagnostic.path === customTools.sources[name]));
    return Object.assign(state, { chain, kernel, assembly, subagents, extensions: installedExtensions, customToolDiagnostics: customTools.diagnostics,
      customToolNames,
      mcp, loop, runDelegated, templates, compaction, rebuildCompaction });
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

  async function sessionConfiguration(state: HostSessionState, bridge = false): Promise<Record<string, unknown>> {
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
        taskLimits: taskLimitsOf(state.environment.config, state.loopModelCalls),
        policy: { mode: state.chain.mode, source: state.chain.modeSource, default: state.chain.configuredMode() },
        permission: sessionPermissionView(state, mayChangePermission(bridge)),
        screenCapture: { enabled: state.screenCapture.enabled, source: state.screenCapture.source, changeAllowed: permissionControl },
        search: state.search,
        browser: browserView(state, permissionControl),
        generation: generationView(state.generation),
      },
      pending,
      available: {
        modes,
        policies: ['always', 'ask', 'auto', 'never', 'default'],
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
        allowScreenCapture: knownGrant.allowScreenCapture,
      },
    };
  }

  async function configureSession(state: HostSessionState, params: HostMethodParams, bridge = false): Promise<Record<string, unknown>> {
    const modeChanged = params.mode !== undefined;
    const policyChanged = params.policy !== undefined;
    const permissionChanged = params.permissionProfile !== undefined || params.permissionNetwork !== undefined;
    const loopChanged = params.loopIterations !== undefined;
    const generationChanged = params.provider !== undefined || params.model !== undefined
      || params.thinkingEffort !== undefined || params.outputTokens !== undefined
      || params.resetModel === true || params.resetThinking === true || params.resetOutputTokens === true;
    const categories = Number(modeChanged) + Number(policyChanged) + Number(permissionChanged) + Number(loopChanged) + Number(generationChanged);
    if (categories > 1) throw new KernelError('session_configure_one_category');
    if (categories === 0) return await sessionConfiguration(state, bridge);
    if (agentControl !== undefined && !agentControl.operator) throw new KernelError('agent_control_operator_required');

    if (permissionChanged) {
      return await setPermission(state, params.permissionProfile ?? state.permission.profile,
        params.permissionNetwork, undefined, undefined, undefined, undefined, bridge);
    }

    if (modeChanged) {
      const requestedName = params.mode === 'default' ? state.environment.modeName ?? DEFAULT_MODE : requiredString(params.mode, 'mode');
      if (state.environment.modePaths === undefined) throw new KernelError('host_mode_paths_required');
      const requested = await loadMode(requestedName, state.environment.modePaths);
      const modeGrant = await activeDelegation();
      if (modeGrant !== undefined) assertDelegationMode(modeGrant, requested.name);
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
      return { ...(await sessionConfiguration(state, bridge)), applies };
    }

    if (policyChanged) {
      let nextOverride: PolicyMode | null;
      if (params.policy === 'default') {
        const grant = await activeDelegation();
        if (grant !== undefined) assertDelegationPolicy(grant, state.chain.configuredMode());
        nextOverride = null;
      } else if (isPolicyMode(params.policy) || params.policy === 'none') {
        // 旧客户端发来的 `none` 降级为 `ask`；其余模式按当前契约校验。
        const mode: PolicyMode = params.policy === 'none' ? 'ask' : params.policy;
        const grant = await activeDelegation();
        if (grant !== undefined) assertDelegationPolicy(grant, mode);
        nextOverride = mode;
      }
      else throw new KernelError('policy_mode_unknown');
      await appendPolicyState(state.session, state.chain, nextOverride);
      state.policyOverride = nextOverride;
      if (nextOverride === null) state.chain.resetMode();
      else state.chain.setMode(nextOverride);
      if (agentControl !== undefined && params.policy !== 'default') {
        await recordDelegationEvent(agentControl.storePath, {
          kind: 'grant.used', grantId: agentControl.grantId, policy: nextOverride as 'always' | 'ask' | 'auto' | 'never',
        });
      }
      return { ...(await sessionConfiguration(state, bridge)), applies: 'next_decision' };
    }

    if (loopChanged) {
      const iterations = params.loopIterations;
      if (typeof iterations !== 'number' || !Number.isSafeInteger(iterations) || iterations < 1) {
        throw new KernelError('host_loop_limits_invalid', { detail: 'iterations must be a positive safe integer' });
      }
      if (iterations === (state.pendingLoopIterations ?? state.loopIterations)) {
        return { ...(await sessionConfiguration(state, bridge)), applies: 'unchanged' };
      }
      await state.session.append({ kind: 'sessionLoopIterations', ignorable: true, iterations });
      if (state.running === undefined) {
        state.loopIterations = iterations;
        state.pendingLoopIterations = undefined;
      } else state.pendingLoopIterations = iterations;
      return { ...(await sessionConfiguration(state, bridge)), applies: state.running === undefined ? 'now' : 'next_round' };
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
      const scopeGrant = await activeDelegation();
      if (scopeGrant !== undefined) assertDelegationModelSelection(scopeGrant, `${selection.provider}/${selection.model}`);
      explicit = true;
    }

    const options: { outputTokens?: number; thinkingEffort?: HostGenerationOptions['thinkingEffort'] } = { ...previous.options };
    if (params.resetOutputTokens === true) delete options.outputTokens;
    else if (params.outputTokens !== undefined) {
      if (!Number.isSafeInteger(params.outputTokens) || params.outputTokens < 1) throw new KernelError('provider_output_budget_invalid');
      const budgetGrant = await activeDelegation();
      options.outputTokens = boundedOutputTokens(budgetGrant, params.outputTokens);
    }
    if (params.resetThinking === true || params.thinkingEffort === 'default') delete options.thinkingEffort;
    else if (params.thinkingEffort !== undefined) {
      if (!['none', 'low', 'high', 'max'].includes(params.thinkingEffort)) throw new KernelError('provider_thinking_effort_invalid');
      options.thinkingEffort = params.thinkingEffort as HostGenerationOptions['thinkingEffort'];
    }
    const ceiling = (await activeDelegation())?.maxOutputTokens;
    const generationOptions = withOutputCeiling(options, ceiling);
    const provider = deriveProvider({ ...state.environment.config, model }, generationOptions);
    const generation: SessionGeneration = { provider, model, ...(explicit ? { explicit: true } : {}), options: generationOptions };
    const before = JSON.stringify({ model: previous.model, explicit: previous.explicit === true, options: previous.options });
    const after = JSON.stringify({ model, explicit, options: generationOptions });
    if (before === after) return { ...(await sessionConfiguration(state, bridge)), applies: 'unchanged' };
    const compaction = state.running === undefined ? state.rebuildCompaction(model) : undefined;
    await state.session.append(sessionGenerationEvent(generation));
    if (state.running === undefined) {
      state.generation = generation;
      state.pendingGeneration = undefined;
      state.compaction = compaction ?? null;
    } else state.pendingGeneration = generation;
    return { ...(await sessionConfiguration(state, bridge)), applies: state.running === undefined ? 'now' : 'next_round' };
  }

  async function setPermission(
    state: HostSessionState,
    profileValue: unknown,
    networkValue: unknown,
    confirmFullAccess: unknown,
    confirmNetwork: unknown,
    confirmPartialWorkspaceWrite: unknown,
    confirmWorkspaceTrust: unknown,
    bridge: boolean,
  ): Promise<Record<string, unknown>> {
    const grant = await activeDelegation();
    // 权限变更是可信 UI、经过认证的桥连接或 Grant operator 的能力；普通 MCP 客户端不接受。
    if (!maySetPermission(controlTrust, bridge)) {
      if (controlTrust.agentControl === undefined) throw new KernelError('permission_control_unavailable');
      throw new KernelError('agent_control_operator_required');
    }
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
    if (confirmWorkspaceTrust === true) requireTrustedUi('workspace-trust', controlTrust);
    if (confirmWorkspaceTrust === true && !state.permission.workspaceTrusted) {
      await setTrusted(state.environment.projectRoot, true);
    }
    const next = createPermissionContext(profileValue, network, state.permission.capabilities,
      permissionOptionsOf(state.permission, confirmedPartialWorkspaceWrite,
        state.permission.workspaceTrusted || confirmWorkspaceTrust === true));
    if (next.profile === state.permission.profile && next.network === state.permission.network) {
      state.permission = next;
      return { sessionId: state.id, permission: sessionPermissionView(state, mayChangePermission(bridge)), applies: 'unchanged' };
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
      const derivedOperations = [...sessions.values()].filter((candidate) => candidate.operationSourceSessionId === state.id);
      for (const operation of derivedOperations) {
        operation.operationRevoked = true;
        operation.running?.abort(new KernelError('operation_source_permission_changed'));
      }
      await processOwnership.stopAfterPermissionChange(state, derivedOperations.map((operation) => operation.id));
      if (permissionDenial(next, 'external') !== undefined) await revokeSessionMcp(state, BROWSER_SERVER);
      return { sessionId: state.id, permission: sessionPermissionView(state, mayChangePermission(bridge)), applies: 'now' };
    } finally {
      if (sessions.get(state.id) === state) state.permissionChanging = false;
    }
  }

  function runContextOf(state: HostSessionState, delegation?: DelegationSpec) {
    if (delegation?.outputSchema !== undefined) createOutputSchemaContract(delegation.outputSchema);
    const budget = taskLimitsOf(state.environment.config, state.loopModelCalls, delegation?.budget);
    return {
      workspace: workspaceIdentity(state.environment.projectRoot),
      mode: state.mode.file?.digest ?? state.mode.file?.name ?? null,
      permission: { profile: state.permission.profile, network: state.permission.network },
      policy: state.chain.mode,
      generation: { model: state.generation.model, options: state.generation.options },
      loopIterations: state.loopIterations,
      budget,
    };
  }

  async function operationSessionSettings(source: HostSessionState, operationId: string): Promise<{
    readonly initial: InitialSessionSettings;
    readonly workspaceOrigin?: 'explicit' | 'default';
  }> {
    const [events, header] = await Promise.all([source.session.read(), source.session.header()]);
    const savedPermission = events.filter((event) => event.kind === 'sessionPermission').at(-1);
    return {
      initial: {
        ...(source.mode.file === undefined ? {} : { mode: source.mode.file.name }),
        ...(source.policyOverride === null ? {} : { policy: source.policyOverride }),
        sessionPolicyRules: [...source.sessionPolicyRules],
        permission: {
          context: source.permission,
          confirmedFullAccess: savedPermission?.confirmedFullAccess === true,
          confirmedNetwork: savedPermission?.confirmedNetwork === true,
          confirmedPartialWorkspaceWrite: source.permission.partialWorkspaceWriteConfirmed
            || savedPermission?.confirmedPartialWorkspaceWrite === true,
        },
        loopIterations: source.loopIterations,
        persistLoopIterations: false,
        generation: source.generation,
        persistGeneration: false,
        operation: { operationId, sourceSessionId: source.id },
      },
      ...(header?.workspaceOrigin === undefined ? {} : { workspaceOrigin: header.workspaceOrigin }),
    };
  }

  async function executeRun(state: HostSessionState, input: string, origin: 'human' | 'controller',
    delegation: DelegationSpec | undefined, acceptance: RunAcceptance, connection: HostClientConnection,
    onAccepted?: (userSeq: number) => void): Promise<DelegatedRunResult> {
    if (state.running !== undefined) throw new KernelError('run_already_running');
    const steering = createRunSteeringInbox(state.session, acceptance.runId);
    state.runSteering = steering;
    state.runInputRevisions = new Map();
    state.activeRunId = acceptance.runId;
    try {
      return await execute(state, async (signal, report) => {
        const invocation = parseInvocation(input);
        let text = input;
        let user: Record<string, unknown> = { origin };
        if (invocation !== undefined) {
          const expanded = await expandTemplate(findTemplate(state.templates, invocation.command), invocation.arguments);
          text = expanded.text;
          user = { ...user, raw: input, arguments: expanded.arguments, source: expanded.source, digest: expanded.digest };
        }
        return await state.runDelegated(text, {
          signal, source: origin, user, onProgress: report, delegation, acceptance, steering,
          onAccepted: (userSeq) => { steering.activate(); onAccepted?.(userSeq); },
        });
      }, connection);
    } finally {
      try { await finiteCommands.finishRun(state.id, acceptance.runId); }
      finally {
        if (state.runSteering === steering) state.runSteering = undefined;
        if (state.activeRunId === acceptance.runId) state.activeRunId = undefined;
      }
    }
  }

  const workspacePrefs = createWorkspacePrefsHandlers({
    classifyProjectRoot,
    isWorkspaceRunning(identity) {
      for (const state of sessions.values()) {
        if (workspaceIdentity(state.environment.projectRoot) === identity && state.running !== undefined) return true;
      }
      return false;
    },
  });
  const sessionHandlers = createSessionHandlers({
    defaultEnvironment,
    imagePreview: previewSessionImage,
    record: sessionReadDeps,
    open,
    opened: id => sessions.get(id),
    environmentFor,
    readOnlyConfig: readOnlySessionConfig,
  });
  const submitRun = createRunSubmissionHandler({
    open,
    serialize: serializeSessionConfiguration,
    validate: runContextOf,
  });
  const mcpExtensions = createMcpExtensionHandlers({
    environmentFor,
    open,
    sessions: () => sessions.values(),
    currentMcpConfigs,
    stopMcpServersWithChangedConfig,
    revokeSessionMcp,
  });

  const host: Host = {
    async handle(rawMessage: Pick<HostRequest, 'method' | 'params'>, connection: HostClientConnection): Promise<unknown> {
      if (closing !== undefined) throw new KernelError('host_closed');
      const rawParams = rawMessage.params;
      validateCall(rawMessage.method, rawParams);
      const message: HostRequestWithParams = { ...rawMessage, params: rawParams };
      const { sessionId = '' } = message.params;
      const grant = await activeDelegation();
      if (grant !== undefined) {
        await assertDelegationProject(grant, message.params.projectRoot ?? defaultEnvironment.projectRoot);
        const ownedState = sessions.get(sessionId);
        if (ownedState !== undefined) await assertDelegationProject(grant, ownedState.environment.projectRoot);
      }
      // 身份与作用域只由 Host 所在的可信通道决定；连接上的桥标记由认证后端设置。
      // 进程内直接调用 Host（插件清理测试、Host 自身）没有通道对象，视作“非桥”。
      const bridge = connection !== undefined && connection[TRUSTED_AGENT_CONTROL_ORIGIN] === true;
      const controllerScope = controllerScopeOf(grant?.id);
      const runScopes = runScopesOf(controlTrust, bridge, controllerScope);
      const requireProjectFileAccess = async (state: HostSessionState, writing = false): Promise<void> => {
        if (controlTrust.permissionControl) return;
        const activeGrant = await activeDelegation();
        if (!bridge || activeGrant === undefined || state.managedGrantId !== activeGrant.id) {
          throw new KernelError('project_files_control_unavailable');
        }
        await assertDelegationProject(activeGrant, state.environment.projectRoot);
        assertGrantSessionScope(activeGrant, state);
        assertDelegationPermission(activeGrant, state.permission.profile, state.permission.network);
        if (writing && !activeGrant.allowOperator) throw new KernelError('agent_control_operator_required');
      };
      // 目标 Run 的可见性只在这里判定：接受记录里的作用域、调用方可见范围与 Grant 作用域。
      // 处理器只拿得到已经通过判定的会话事件，不再各自复制同一段判定。
      const runReferenceOf = async (state: HostSessionState, runId: string) => {
        const events = await state.session.read();
        return { events, scope: runAcceptanceScope(events, state.id, runId) };
      };
      const assertVisibleRunScope = (scope: string | undefined) => {
        if (scope !== undefined && runScopes !== undefined && !runScopes.includes(scope)) throw new KernelError('run_not_found');
      };
      const requireRunReference = async (state: HostSessionState, runId: string) => {
        const { events, scope } = await runReferenceOf(state, runId);
        if (scope === undefined) throw new KernelError('run_not_found');
        assertVisibleRunScope(scope);
        if (grant !== undefined) assertGrantSessionScope(grant, state);
        return { events, scope };
      };
      // 人工 Operation 的有限命令以 operationId 作为运行引用：只允许该操作会话查询自己那条已批准的命令。
      const requireExecutionReference = async (state: HostSessionState, runId: string): Promise<void> => {
        const { events, scope } = await runReferenceOf(state, runId);
        if (scope === undefined) {
          const operation = events.find((event) => event.kind === 'operationStarted' && event.operationId === runId);
          if (operation === undefined || state.operationOnly !== true || state.operationId !== runId) {
            throw new KernelError('run_not_found');
          }
          requireTrustedUi('operation-run', controlTrust);
        }
        assertVisibleRunScope(scope);
        if (grant !== undefined) assertGrantSessionScope(grant, state);
      };

      // 方法级准入只在分派前判定一次：Operation Session 能做什么（capabilities.ts）与
      // 哪些方法整方法要求可信本地 UI（entry.ts）各自只有一份声明，业务分支不再重复。
      const targeted = sessionId === '' ? undefined : sessions.get(sessionId);
      admitEntry({ method: message.method, trust: controlTrust, operationSession: targeted?.operationOnly === true });

      switch (message.method) {
        case 'workspace.trust': {
          if (typeof message.params.trusted !== 'boolean') throw new KernelError('protocol_args_invalid', { detail: 'trusted must be a boolean' });
          if (message.params.trusted && message.params.confirmWorkspaceTrust !== true) {
            throw new KernelError('workspace_trust_confirmation_required');
          }
          const environment = await environmentFor(message.params.projectRoot);
          await setTrusted(environment.projectRoot, message.params.trusted);
          const identity = workspaceIdentity(environment.projectRoot);
          const affectedSessions = [...sessions.values()].filter((state) => workspaceIdentity(state.environment.projectRoot) === identity);
          for (const state of affectedSessions) {
            state.permission = createPermissionContext(state.permission.profile, state.permission.network, state.permission.capabilities,
              permissionOptionsOf(state.permission, state.permission.partialWorkspaceWriteConfirmed, message.params.trusted));
          }
          if (!message.params.trusted) await processOwnership.stopAfterTrustChange(identity, affectedSessions);
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
        case 'session.side.create': {
          const source = open(sessionId);
          if (source.operationOnly === true) throw new KernelError('side_session_source_invalid');
          if (source.permissionChanging) throw new KernelError('permission_change_in_progress');
          const selection = requiredString(message.params.selection, 'selection');
          const selectionBytes = Buffer.byteLength(selection, 'utf8');
          if (selectionBytes > SIDE_SELECTION_MAX_BYTES || selection.includes('\u0000')) throw new KernelError('side_context_limit_exceeded');
          const sourceKind = message.params.sourceKind;
          if (sourceKind !== 'event' && sourceKind !== 'file' && sourceKind !== 'diff') {
            throw new KernelError('side_context_source_kind_invalid');
          }
          const readDenied = permissionDenial(source.permission, 'read');
          if (readDenied !== undefined) throw new KernelError(readDenied.code, { detail: readDenied.reason });

          const sourceEvents = await source.session.read();
          const verified = await verifySideSelection(sourceKind, selection, message.params, {
            sourceId: source.id,
            projectRoot: source.environment.projectRoot,
            config: source.environment.config,
            readEvent: seq => readRecordPage(source.id, { at: seq, fullResults: true }, sessionReadDeps) as unknown as Promise<{ events?: Record<string, unknown>[] }>,
            requireProjectFileAccess: () => requireProjectFileAccess(source),
          });
          const { sourceEventSeq, sourcePath, sourceVersion, sourceEvent } = verified;

          const eventRun = sourceEvent !== undefined && isRecord(sourceEvent.run) && typeof sourceEvent.run.runId === 'string'
            ? sourceEvent.run.runId : sourceEvent !== undefined && typeof sourceEvent.runId === 'string' ? sourceEvent.runId : undefined;
          const sourceRunId = message.params.sourceRunId === undefined
            ? sourceKind === 'event' ? eventRun : source.activeRunId
            : requiredString(message.params.sourceRunId, 'sourceRunId');
          if (message.params.sourceRunId !== undefined && eventRun !== undefined && sourceRunId !== eventRun) {
            throw new KernelError('side_context_run_mismatch');
          }
          if (sourceRunId !== undefined && runAcceptanceScope(sourceEvents, source.id, sourceRunId) === undefined) {
            throw new KernelError('side_context_run_not_found');
          }

          const sideSessionId = randomUUID();
          const sidePermission = createPermissionContext('read-only', 'disabled', {
            filesystemRead: source.permission.capabilities.filesystemRead,
            filesystemWrite: 'unavailable', network: 'unavailable', process: 'unavailable',
          }, permissionOptionsOf(source.permission, false, source.permission.workspaceTrusted));
          const sourceHeader = await source.session.header();
          const sideInitial: InitialSessionSettings = {
            ...(source.mode.file === undefined ? {} : { mode: source.mode.file.name }),
            ...(source.policyOverride === null ? {} : { policy: source.policyOverride }),
            permission: { context: sidePermission, confirmedFullAccess: false, confirmedNetwork: false,
              confirmedPartialWorkspaceWrite: false },
            loopIterations: source.loopIterations,
            persistLoopIterations: true,
            generation: source.generation,
            persistGeneration: true,
          };
          if (grant !== undefined) assertDelegationPermission(grant, 'read-only', 'disabled');
          await buildSession(sideSessionId, connection, false, undefined, source.environment,
            sourceHeader?.workspaceOrigin ?? 'explicit', sideInitial);
          const side = open(sideSessionId);
          const createdAt = new Date().toISOString();
          const selectionSha256 = createHash('sha256').update(selection, 'utf8').digest('hex');
          const context = {
            sourceKind, ...(sourceEventSeq === undefined ? {} : { sourceEventSeq }),
            ...(sourcePath === undefined ? {} : { sourcePath }), ...(sourceVersion === undefined ? {} : { sourceVersion }),
            selectionBytes, selectionSha256,
          };
          await side.session.append({ kind: 'sideSessionOrigin', ignorable: true, source: 'desktop',
            originSessionId: source.id, ...(sourceRunId === undefined ? {} : { originRunId: sourceRunId }), ...context, createdAt });
          await side.session.append({ kind: 'label', name: 'Side chat' });
          await source.session.append({ kind: 'sideSessionStarted', ignorable: true, source: 'desktop',
            sourceSessionId: source.id, sideSessionId, ...(sourceRunId === undefined ? {} : { sourceRunId }), ...context, createdAt });
          await noteWorkspace(source.environment);
          return { sessionId: sideSessionId, sourceSessionId: source.id,
            ...(sourceRunId === undefined ? {} : { sourceRunId }), ...context, createdAt };
        }
        case 'view.request.ack': {
          const source = open(sessionId);
          if (source.operationOnly === true) throw new KernelError('view_request_scope_invalid');
          const runId = requiredString(message.params.runId, 'runId');
          const requestId = requiredString(message.params.requestId, 'requestId');
          const action = message.params.action;
          if (action !== 'opened' && action !== 'dismissed') throw new KernelError('view_request_action_invalid');
          const events = await source.session.read();
          const requested = events.find(event => event.kind === 'viewRequest' && event.requestId === requestId);
          if (requested === undefined || requested.runId !== runId) throw new KernelError('view_request_not_found');
          if (!events.some(event => event.kind === 'viewRequestDelivered' && event.requestId === requestId && event.runId === runId)) {
            throw new KernelError('view_request_not_delivered');
          }
          if (events.some(event => ['viewRequestOpened', 'viewRequestDismissed'].includes(String(event.kind))
            && event.requestId === requestId)) throw new KernelError('view_request_already_resolved');
          const kind = action === 'opened' ? 'viewRequestOpened' : 'viewRequestDismissed';
          await source.session.append({ kind, ignorable: true, source: 'desktop', requestId, runId,
            createdAt: new Date().toISOString() });
          return { requestId, action, recorded: true };
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
              const requested = await loadMode(requiredString(message.params.mode, 'mode'), state.environment.modePaths);
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
          const opened = await buildSession(sessionId, connection, true,
            message.params.mode === undefined ? undefined : requiredString(message.params.mode, 'mode'), env);
          if (grant !== undefined) await recordDelegationEvent(agentControl!.storePath, { kind: 'grant.used', grantId: grant.id });
          await noteWorkspace(env);
          return opened;
        }
        case 'session.close': {
          const state = sessions.get(sessionId);
          if (state === undefined) throw new KernelError('session_not_open', { detail: sessionId });
          // 关闭前必须等整个轮次（含最终化）结束，确保结果和待应用配置都已记录。
          if (state.permissionChanging) throw new KernelError('permission_change_in_progress', { detail: sessionId });
          if (state.running !== undefined || state.operation !== undefined) {
            throw new KernelError('run_already_running', { detail: sessionId });
          }
          await retire(state);
          evictEnvironment(state.environment);
          return { sessionId };
        }
        case 'screen-capture.set': {
          const state = open(sessionId);
          const enabled = message.params.enabled === true;
          if (enabled && message.params.confirmScreenCapture !== true) throw new KernelError('screen_capture_confirmation_required');
          if (enabled && state.running !== undefined) throw new KernelError('run_already_running');
          if (enabled && state.permissionChanging) throw new KernelError('permission_change_in_progress');
          const decisionAt = new Date().toISOString();
          state.screenCapture.enabled = false;
          state.screenCapture.source = 'none';
          state.screenCapture.controller.abort(new KernelError(enabled ? 'screen_capture_replaced' : 'screen_capture_revoked'));
          const intent = enabled ? new AbortController() : state.screenCapture.controller;
          if (enabled) {
            state.screenCapture.controller = intent;
            state.permissionChanging = true;
          }
          try {
            if (enabled && agentControl !== undefined && (await activeDelegation())?.allowScreenCapture !== true) throw new KernelError('screen_capture_not_authorized');
            if (((await state.session.header())?.formatVersion ?? 0) < 1) throw new KernelError('session_screen_capture_format_unsupported');
            if (closing !== undefined) throw new KernelError('host_closed');
            if (sessions.get(sessionId) !== state || retiringSessions.has(sessionId)) throw new KernelError('session_closing');
            if (enabled) intent.signal.throwIfAborted();
            await state.session.append({ kind: 'screenCapture', ignorable: true, enabled, source: 'trusted-ui', at: decisionAt });
            if (enabled) {
              intent.signal.throwIfAborted();
              state.screenCapture.enabled = true;
              state.screenCapture.source = 'trusted-ui';
            }
            return { sessionId, enabled: state.screenCapture.enabled, source: state.screenCapture.source };
          } finally { if (enabled) state.permissionChanging = false; }
        }
        case 'session.label':
        case 'session.branch':
        case 'sessions.list':
        case 'sessions.search':
        case 'session.read':
        case 'session.observe':
        case 'session.image.preview':
        case 'session.control':
        case 'session.export':
          return await sessionHandlers[message.method](sessionId, message.params);
        case 'paths.list':
        case 'project.files.list':
        case 'project.files.search':
        case 'project.file.read':
        case 'project.file.save':
        case 'project.git.status':
        case 'project.git.diff':
          return await handleProjectRequest(message.method, message.params, sessionId, {
            environmentFor, open, requireFileAccess: requireProjectFileAccess, serializeSessionConfiguration, fileWriteQueue,
          });
        case 'tool.result': {
          // 结果读模型在 tool-result-view.ts：入口只校验调用属于哪个 Run，并传入已可见的事件。
          const state = open(sessionId);
          const runId = requiredString(message.params.runId, 'runId');
          const callId = requiredString(message.params.callId, 'callId');
          const { events } = await requireRunReference(state, runId);
          return readToolResult({
            sessionId, runId, callId, params: message.params, events,
            directory: state.session.directory, activeRunId: state.activeRunId,
            liveness: target => runLivenessOf(state, target),
          });
        }
        case 'browser.stop':
        case 'browser.resume': {
          return await serializeSessionConfiguration(sessionId, async () => {
            const state = open(sessionId);
            if (message.method === 'browser.resume') {
              const denied = permissionDenial(state.permission, 'external');
              if (denied !== undefined) throw new KernelError(denied.code, { detail: denied.reason });
              await state.browser.verify();
              state.browserPaused = false;
            } else {
              state.browserPaused = true;
              await revokeSessionMcp(state, BROWSER_SERVER);
            }
            return { sessionId, browser: browserView(state, permissionControl) };
          });
        }
        case 'approval.details': {
          const state = open(sessionId);
          const requestId = requiredString(message.params.requestId, 'requestId');
          const pending = pendingApprovalDetails.get(requestId);
          if (pending === undefined || pending.sessionId !== state.id) throw new KernelError('control_interaction_stale');
          if (approvalArgsDigest(pending.args) !== pending.argumentSha256) throw new KernelError('policy_approval_arguments_changed');
          return {
            requestId,
            sessionId: state.id,
            argumentSha256: pending.argumentSha256,
            args: structuredClone(pending.args),
          };
        }
        case 'run.start':
        case 'run.submit':
          return await submitRun(message.method, sessionId, message.params, {
            controllerScope,
            canRecordHuman: mayRecordHumanRun(controlTrust, bridge),
            authorize(state) { if (grant !== undefined) assertGrantSessionScope(grant, state); },
            provenance: (origin, scope) => runProvenanceOf(controlTrust, bridge, origin, scope),
            execute: (state, input, origin, delegation, run, onAccepted) =>
              executeRun(state, input, origin, delegation, run, connection, onAccepted),
            waitForPersisted: (runId, origin) => host.handle({ method: 'run.wait', params: { sessionId, runId, origin } }, connection),
          });
        case 'storage.inspect':
        case 'storage.cleanup.preview':
        case 'storage.cleanup.apply': {
          // 存储盘点与媒体清理在 storage-service.ts；入口只解析环境并传递短期扫描/计划状态。
          const env = await environmentFor(requiredString(message.params.projectRoot, 'projectRoot'));
          const state = { scans: storageScans, plans: storagePlans };
          if (message.method === 'storage.inspect') return await inspectStorage(env);
          if (message.method === 'storage.cleanup.preview') {
            return await previewStorageCleanup(env, { limit: message.params.limit, cursor: message.params.cursor }, state);
          }
          return await applyStorageCleanup(env, { confirm: message.params.confirm as boolean | undefined, planId: message.params.planId as string }, state);
        }
        case 'artifact.list':
        case 'artifact.inspect':
        case 'artifact.preview':
        case 'artifact.resolve': {
          // 产物读取的归属、可见性与状态判定在 artifacts.ts；入口只解析环境与打开记录。
          const env = await environmentFor(requiredString(message.params.projectRoot, 'projectRoot'));
          assertSessionId(sessionId);
          const opened = sessions.get(sessionId);
          const scope: ArtifactScope = {
            sessionId, env, recordPath: recordPathOf(sessionId, env),
            openedRoot: opened?.environment.projectRoot,
            log: opened?.session ?? createSessionLog({ directory: env.directory, id: sessionId }),
            runScopes, fillSpills,
          };
          if (message.method === 'artifact.list') {
            return await listArtifacts(scope, { runId: message.params.runId, offset: message.params.offset, limit: message.params.limit });
          }
          const artifactKey = requiredString(message.params.artifactKey, 'artifactKey');
          if (message.method === 'artifact.preview') return await previewArtifact(scope, {}, artifactKey);
          if (message.method === 'artifact.resolve') return await resolveArtifact(scope, {}, artifactKey, controlTrust);
          return await inspectArtifact(scope, {}, artifactKey);
        }
        case 'run.wait':
        case 'run.receipt':
        case 'run.receipts':
        case 'run.result':
        case 'run.cancel':
        case 'run.steer':
          return await handleRunRequest(message.method, message.params, sessionId, {
            open,
            opened: id => sessions.get(id),
            environmentFor,
            recordPathOf,
            requireRunReference,
            stopRun: state => processOwnership.stopRun(state, 'run_cancel'),
            acceptInput(state, runId) {
              advanceRunInputRevision(state, runId);
              return settleRunAsks(state, runId);
            },
            source: runOriginOf(undefined, 'human', mayRecordHumanRun(controlTrust, bridge)),
            scopes: runScopes,
          });
        case 'operation.start': {
          const command = requiredString(message.params.command, 'command');
          const cwd = message.params.cwd === undefined ? undefined : requiredString(message.params.cwd, 'cwd');
          const operationId = randomUUID();
          const operationSessionId = randomUUID();
          const callId = randomUUID();
          const prepared = await serializeSessionConfiguration(sessionId, async () => {
            const source = open(sessionId);
            if (source.permissionChanging) throw new KernelError('permission_change_in_progress');
            const denied = permissionDenial(source.permission, 'exec');
            if (denied !== undefined) throw new KernelError(denied.code, { detail: denied.reason });
            if (!source.kernel.manifest().some((tool) => tool.name === 'exec')) {
              throw new KernelError('exec_tool_unavailable', { detail: 'the current Session mode does not expose exec' });
            }
            const { initial, workspaceOrigin } = await operationSessionSettings(source, operationId);
            await buildSession(operationSessionId, connection, false, undefined, source.environment, workspaceOrigin, initial);
            const operation = open(operationSessionId);
            if (source.mode.file !== undefined) await operation.adopt(source.mode.file);
            operation.chain.restore(source.chain.snapshot());
            await operation.session.append({ kind: 'operationStarted', ignorable: true, source: 'desktop',
              sourceSessionId: source.id, operationId, startedAt: new Date().toISOString() });
            await operation.session.append({ kind: 'label', name: `Command · ${operationId.slice(0, 8)}` });
            const execution = execute(operation, async (signal) => {
              const budget = createTaskBudget(taskLimitsOf(operation.environment.config, operation.loopModelCalls), signal);
              operation.taskBudget = budget;
              const executionContext = { signal: budget.signal, sessionId: operationSessionId,
                runId: operationId, callId, source: 'human' as const, scope: { active: true } };
              try {
                return await budget.runWork(() => withKernelExecutionContext(executionContext, () => operation.kernel.call('exec', {
                  command, ...(cwd === undefined ? {} : { cwd }), waitMs: 0,
                }, { signal: budget.signal, sessionId: operationSessionId, runId: operationId, callId, source: 'human' })));
              } catch (error) {
                if (operation.taskBudget === budget) {
                  operation.lastTask = budget.snapshot();
                  operation.taskBudget = undefined;
                  budget.dispose();
                }
                throw error;
              } finally {
                executionContext.scope.active = false;
              }
            }, connection, 'tool_execution');
            return { operation, execution };
          });
          const operation = prepared.operation;
          let result: unknown;
          try {
            result = await prepared.execution;
          } catch (error) {
            const revoked = operation.operationRevoked === true;
            const code = errorCode(error) ?? (revoked ? 'operation_source_permission_changed' : 'operation_start_failed');
            const terminalState = revoked || code === 'operation_source_permission_changed' ? 'cancelled' : 'failed';
            await recordOperationFinished(operation, { state: terminalState, errorCode: code }).catch((recordError) => {
              logger?.log?.('operation start failure could not be recorded', {
                code: errorCode(recordError) ?? 'operation_record_failed', sessionId: operationSessionId, operationId,
              });
            });
            return { operationSessionId, operationId, runId: operationId, callId, state: terminalState, errorCode: code };
          }
          if (!isRecord(result) || typeof result.executionId !== 'string' || typeof result.state !== 'string') {
            await recordOperationFinished(operation, { state: 'failed', errorCode: 'operation_execution_handle_unavailable' });
            return { operationSessionId, operationId, runId: operationId, callId, state: 'failed',
              errorCode: 'operation_execution_handle_unavailable' };
          }
          return { operationSessionId, operationId, runId: operationId, callId,
            executionId: result.executionId, state: result.state,
            ...(Number.isSafeInteger(result.exitCode) ? { exitCode: result.exitCode } : {}),
            ...(typeof result.errorCode === 'string' ? { errorCode: result.errorCode } : {}) };
        }
        case 'execution.status':
        case 'execution.wait':
        case 'execution.logs':
        case 'execution.cancel': {
          const state = open(sessionId);
          const runId = requiredString(message.params.runId, 'runId');
          const executionId = requiredString(message.params.executionId, 'executionId');
          await requireExecutionReference(state, runId);
          const owner = { projectIdentity: workspaceIdentity(state.environment.projectRoot), sessionId, runId };
          if (message.method === 'execution.status') return finiteCommands.status(owner, executionId);
          if (message.method === 'execution.wait') {
            return await finiteCommands.wait(owner, executionId, message.params.waitMs ?? 30_000);
          }
          if (message.method === 'execution.logs') {
            return finiteCommands.logs(owner, executionId, message.params.cursor, message.params.limitBytes);
          }
          return await finiteCommands.cancel(owner, executionId);
        }
        case 'subrun.start':
        case 'subrun.list':
        case 'preset.list':
        case 'preset.preview':
        case 'subrun.status':
        case 'subrun.message':
        case 'subrun.wait':
        case 'subrun.cancel': {
          const state = open(sessionId);
          return await handleSubrunRequest(message.method, message.params, sessionId, state, {
            requireParent: (parentRunId) => requireRunReference(state, parentRunId),
            assertPresetScope() { if (grant !== undefined) assertGrantSessionScope(grant, state); },
            settleAsks: (runId) => settleRunAsks(state, runId),
            source: runOriginOf(undefined, 'human', mayRecordHumanRun(controlTrust, bridge)),
            logger,
          });
        }
        case 'policy.set': {
          // 只修改会话级策略覆盖，不改写配置中的默认值。
          const mode = requiredString(message.params.mode, 'mode');
          return await serializeSessionConfiguration(sessionId, async () => {
            const state = open(sessionId);
            await configureSession(state, { policy: mode });
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
            bridge,
          ));
        }
        case 'mode.set': {
          const name = requiredString(message.params.name, 'name');
          return await serializeSessionConfiguration(sessionId, async () => {
            const state = open(sessionId);
            await configureSession(state, { mode: name });
            return {
              mode: state.mode.file?.name ?? null,
              layer: state.mode.file?.layer ?? null,
              pending: state.pending?.name ?? null,
              tools: state.kernel.manifest().map((entry) => entry.name),
            };
          });
        }
        case 'usage.get': {
          // 只读聚合：用途分开记账，未知保持未知，缓存不重复计入输入。
          // 记录必须按会话自己的项目环境定位；Host 可以打开其他项目的会话。
          const state = sessions.get(sessionId);
          const owner = state === undefined ? branchOwner(sessionId) : undefined;
          // 调用方给出项目根时以它为准：观察别的项目的会话时记录不在本 Host 的默认目录里。
          const requestedRoot = message.params.projectRoot;
          const env = typeof requestedRoot === 'string' && requestedRoot !== ''
            ? await environmentFor(requestedRoot)
            : state?.environment
              ?? (owner === undefined ? defaultEnvironment : sessions.get(owner)?.environment ?? defaultEnvironment);
          const path = recordPathOf(sessionId, env);
          try {
            await access(path);
          } catch {
            throw new KernelError('session_not_found', { detail: sessionId });
          }
          const record = await readSessionRecord(path);
          return { sessionId, summary: summarizeUsage(record.events) };
        }
        case 'usage.diagnostics': {
          const state = open(sessionId);
          const action = requiredString(message.params.action, 'action');
          if (action === 'enable') return configureRequestDiagnostics(state.requestDiagnostics, true);
          if (action === 'disable') {
            state.compaction?.resetDiagnostics();
            return configureRequestDiagnostics(state.requestDiagnostics, false);
          }
          if (action === 'read') return requestDiagnosticSnapshot(state.requestDiagnostics);
          throw new KernelError('protocol_args_invalid');
        }
        case 'status.get': {
          const state = open(sessionId);
          return await statusView(state, {
            grant: await activeDelegation(),
            controlAllowed: mayChangePermission(bridge),
            permissionControl,
            progress: progressSnapshotOf(state),
          });
        }
        case 'session.configure': {
          return await serializeSessionConfiguration(sessionId, () => configureSession(open(sessionId), message.params, bridge));
        }
        case 'workspaces.list':
        case 'workspace.default.set':
        case 'workspace.remove':
        case 'history.read':
        case 'history.append':
        case 'prefs.read':
        case 'prefs.write':
          return await workspacePrefs[message.method](message.params);
        case 'model.select': {
          const selection = modelSelection({ provider: message.params.provider, model: message.params.model });
          return await serializeSessionConfiguration(sessionId, async () => {
            const state = open(sessionId);
            await configureSession(state, { provider: selection.provider, model: selection.model });
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
            if (!hasModelCredentialBinding(model, message.params.api, message.params.baseURL, message.params.reference)) {
              throw new KernelError('model_discovery_credential_unbound');
            }
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
        case 'agent-control.list': {
          return await listDelegationGrants(delegationPathOf());
        }
        case 'agent-control.create': {
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
            // 旧 UI 的 `none`/旧 `never` 只降级为 `ask`；更新后的客户端要么显式带上语义标记，
            // 要么带着只有新版本才会发送的 `allowedPolicyAlways`，这两种情况按新语义读取。
            defaultPolicy: readPersistedPolicyMode(message.params.defaultPolicy,
              message.params.policySemantics
                ?? (message.params.allowedPolicyAlways === undefined ? undefined : POLICY_SEMANTICS)) ?? 'ask',
            allowedPolicies: [...new Set<DelegationPolicy>([
              ...(message.params.allowedPolicyAsk === true ? ['ask' as const] : []),
              ...(message.params.allowedPolicyAuto === true ? ['auto' as const] : []),
              ...(message.params.allowedPolicyNever === true ? ['never' as const] : []),
              ...(message.params.allowedPolicyAlways === true ? ['always' as const] : []),
              ...(message.params.allowedPolicyNone === true ? ['ask' as const] : []),
            ])],
            allowOperator: message.params.allowOperator as boolean,
            allowScreenCapture: message.params.allowScreenCapture === true,
            confirmScreenCapture: message.params.confirmScreenCapture === true,
            allowedMcpServers: message.params.allowedMcpServers as string[] | undefined,
            allowedMcpTools: message.params.allowedMcpTools as string[] | undefined,
            ...(message.params.allowedModes === undefined ? {} : { allowedModes: message.params.allowedModes as string[] }),
            ...(message.params.allowedModels === undefined ? {} : { allowedModels: message.params.allowedModels as string[] }),
            ...(message.params.maxOutputTokens === undefined ? {} : { maxOutputTokens: message.params.maxOutputTokens as number }),
            confirmFullAccess: message.params.confirmFullAccess as boolean,
            confirmUnrestrictedNetwork: message.params.confirmUnrestrictedNetwork as boolean,
            confirmPartialWorkspaceWrite: message.params.confirmPartialWorkspaceWrite === true,
            expiresAt: message.params.expiresAt === '' ? null : requiredString(message.params.expiresAt, 'expiresAt'),
          };
          return await createDelegationGrant(delegationPathOf(), input, requiredString(message.params.version, 'version'));
        }
        case 'agent-control.revoke': {
          const grantId = requiredString(message.params.grantId, 'grantId');
          const result = await revokeDelegationGrant(
            delegationPathOf(), grantId, requiredString(message.params.version, 'version'),
          );
          await processOwnership.stopAfterGrantRevocation(grantId,
            [...sessions.values()].filter((state) => state.managedGrantId === grantId));
          return result;
        }
        case 'mcp.trust.list':
        case 'mcp.trust.set':
        case 'mcp.trust.tools':
        case 'extensions.set':
          return await mcpExtensions[message.method](message.params);
        case 'settings.catalog': {
          const env = await environmentFor(message.params.projectRoot);
          const session = message.params.sessionId === undefined ? undefined : open(requiredString(message.params.sessionId, 'sessionId'));
          if (session !== undefined && session.environment !== env) throw new KernelError('session_project_forbidden');
          const modeName = typeof message.params.mode === 'string' ? message.params.mode
            : session?.mode.file?.name ?? env.modeName ?? DEFAULT_MODE;
          const modes = env.modePaths === undefined
            ? { modes: [], invalid: [], truncated: false }
            : await listModes(env.modePaths);
          let mode: { name: string; layer: string; digest: string; tools: string[] | '*'; prompt: string[] | '*' } | null = null;
          let modeError: string | null = null;
          if (env.modePaths !== undefined) {
            try {
              const file = await loadMode(modeName, env.modePaths);
              mode = { name: file.name, layer: file.layer, digest: file.digest, tools: file.tools, prompt: file.prompt };
            } catch (error) {
              modeError = errorCode(error) ?? 'mode_unavailable';
            }
          }
          const trusted = await isTrusted(env.projectRoot);
          const directories = skillDirectories(env.projectRoot);
          const skills = env.skillRegistry ?? await discoverSkills(directories);
          const sourceLabels = ['project (.ligule/skills)', 'project (.agents/skills)', 'user (.ligule/skills)', 'user (~/.agents/skills)'];
          const skillSource = (root: string) => sourceLabels[directories.findIndex((directory) => {
            const resolvedDirectory = resolve(directory);
            const resolvedRoot = resolve(root);
            return resolvedRoot !== resolvedDirectory && isWithin(resolvedDirectory, resolvedRoot);
          })] ?? 'unknown';
          const environmentSessions = [...sessions.values()].filter((state) => state.environment === env);
          const extensionStates = environmentSessions.flatMap((state) => state.extensions.loaded);
          const installName = (path: string) => env.extensions.installNames?.[resolve(path)] ?? basename(path, '.js');
          const extensions = env.extensions.paths.map((path) => {
            const installedDirectory = env.extensions.installedDirectory;
            const installed = installedDirectory !== undefined
              && isWithin(resolve(installedDirectory), resolve(path));
            return {
              name: installName(path),
              source: installed ? 'user-installed' : 'user-configured',
              enabled: true,
              loaded: extensionStates.some((extension) => resolve(extension.path) === resolve(path)),
              registeredTools: extensionStates.filter((extension) => resolve(extension.path) === resolve(path)).flatMap((extension) => extension.tools),
            };
          });
          for (const off of env.extensions.disabled ?? []) {
            extensions.push({
              name: off.name,
              source: 'user-installed',
              enabled: false,
              loaded: false,
              registeredTools: [],
            });
          }
          const extensionTools = new Set(session?.extensions.loaded.flatMap((extension) => extension.tools) ?? []);
          const extensionDiagnosticSource = (path: string) => env.extensions.installNames?.[resolve(path)] ?? basename(path);
          const customTools = session === undefined
            ? await discoverCustomTools(join(dataRoot(), 'tools'))
            : { tools: [], diagnostics: session.customToolDiagnostics, sources: {} };
          const registeredTools = session?.kernel.catalog() ?? await settingsToolCatalog(env, skills, customTools);
          const customToolNames = new Set(session?.customToolNames ?? customTools.tools.map((tool) => tool.name).filter((name) =>
            !customTools.diagnostics.some((diagnostic) => diagnostic.code === 'custom_tool_name_conflicts_with_registered_tool' && diagnostic.path === customTools.sources[name])));
          const activeTools = session === undefined ? null : new Set(session.kernel.manifest().map((tool) => tool.name));
          const declaredTools = mode?.tools ?? [];
          const includedTools = declaredTools === '*' ? null : new Set(declaredTools);
          return {
            projectTrusted: trusted,
            policyDefault: env.policy?.mode ?? 'ask',
            hostNodeVersion: process.version,
            sessionActive: session !== undefined,
            modes,
            mode,
            modeError,
            sessionMode: session?.mode.file === undefined ? null : { name: session.mode.file.name, layer: session.mode.file.layer },
            pendingMode: session?.pending?.name ?? null,
            modeTools: declaredTools === '*' ? registeredTools.map((tool) => tool.name) : [...declaredTools],
            tools: registeredTools.map((tool) => ({
              ...tool,
              source: extensionTools.has(tool.name) ? 'extension'
                : customToolNames.has(tool.name) ? 'custom'
                : tool.name.startsWith('mcp.') ? 'mcp'
                  : tool.name.startsWith('skill') ? 'skill' : 'builtin',
              includedInMode: tool.disclosure || includedTools === null || includedTools.has(tool.name),
              currentlyAvailable: activeTools === null ? null : activeTools.has(tool.name),
            })),
            skills: skills.skills.map((skill) => ({ name: skill.name, description: skill.description, requires: skill.requires, source: skillSource(skill.root) })),
            skillDiagnostics: skills.diagnostics.map((diagnostic) => ({ code: diagnostic.code })),
            extensions,
            extensionDiagnostics: [
              ...env.extensions.ignored,
              ...(session === undefined ? [] : session.extensions.diagnostics),
            ].map((diagnostic) => ({ code: diagnostic.code, source: extensionDiagnosticSource(diagnostic.path) })),
            customToolDiagnostics: customTools.diagnostics.map((diagnostic) => ({ code: diagnostic.code, source: basename(diagnostic.path) })),
          };
        }
        case 'config.get':
          return await readConfig(await environmentFor(message.params.projectRoot));
        case 'config.set':
          return await writeConfig(message.params, {
            defaultStore: defaultEnvironment.store,
            environmentFor,
            environments: () => environments.values(),
            *sessionsIn(environment) {
              for (const state of sessions.values()) {
                if (state.environment === environment) yield state.pendingGeneration ?? state.generation;
              }
            },
            deriveProvider,
            adoptWritten,
          });
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
        const retired = await Promise.allSettled(opened.map((state) => retire(state, true)));
        for (const result of retired) {
          if (result.status !== 'rejected') continue;
          const failure = result.reason;
          if (failure instanceof AggregateError && failure.message === 'host_session_retire_failed') {
            failures.push(...failure.errors);
          } else failures.push(failure);
        }
        try { await finiteCommands.close(); }
        catch (error) { failures.push(error); }
        finiteCheckContexts.clear();
        sessions.clear();
        pendingApprovalDetails.clear();
        await telemetry.shutdown().catch(() => {});
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
