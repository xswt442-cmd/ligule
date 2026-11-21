// 会话状态与权限视图：把运行时状态投影成客户端可读的结构。
// 这里只做投影：权限、截图、浏览器与委托授权的判定语义仍由调用方传入的结果决定。
import { permissionDenial, type PermissionContext } from '../kernel/permission.js';
import { resolveModel, type ModelSelection } from '../kernel/model-services.js';
import { BROWSER_SERVER } from '../capability/browser-policy.js';
import { taskLimitsOf } from './runtime-limits.js';
import type { DelegationGrant } from './agent-control.js';
import type { HostProgressSnapshot, HostSessionState } from './host.js';

export function permissionView(permission: PermissionContext, changeAllowed: boolean, changeReason?: string): Record<string, unknown> {
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

export function sessionPermissionView(state: HostSessionState, controlAllowed: boolean): Record<string, unknown> {
  const changeReason = !controlAllowed ? 'permission_control_unavailable'
    : state.running !== undefined ? 'permission_session_running'
      : state.permissionChanging === true ? 'permission_change_in_progress'
        : state.extensions.loaded.length > 0 ? 'permission_extension_restart_required'
          : undefined;
  return permissionView(state.permission, changeReason === undefined, changeReason);
}

export function browserView(state: HostSessionState, permissionControl: boolean) {
  const denied = permissionDenial(state.permission, 'external');
  return { ...state.browser.status, permitted: state.browser.status.available && denied === undefined,
    ...(state.browser.status.code === undefined && denied !== undefined ? { code: denied.code } : {}),
    paused: state.browserPaused, connected: [state.mcp, ...state.childMcp.keys()].some(registry => registry.activeServers().includes(BROWSER_SERVER)),
    changeAllowed: permissionControl };
}

export type StatusViewDeps = {
  readonly modelSelectionOf: (model: Record<string, unknown>) => ModelSelection | undefined;
};

export type StatusViewInput = {
  readonly grant: DelegationGrant | undefined;
  readonly controlAllowed: boolean;
  readonly permissionControl: boolean;
  readonly progress: HostProgressSnapshot | null;
};

export function createStatusView(deps: StatusViewDeps) {
  return async function statusView(state: HostSessionState, input: StatusViewInput) {
    const { grant: currentGrant, controlAllowed, permissionControl, progress } = input;
    return {
      sessionId: state.id,
      running: state.running !== undefined,
      activeRunId: state.activeRunId ?? null,
      operation: state.operationOnly === true ? {
        operationId: state.operationId,
        sourceSessionId: state.operationSourceSessionId,
        finished: state.operationFinished === true,
      } : null,
      progress,
      // 只返回当前模式可用的工具，不返回全部已登记工具。
      tools: state.kernel.manifest().map((entry) => entry.name),
      mode: state.mode.file?.name ?? null,
      modeLayer: state.mode.file?.layer ?? null,
      pendingMode: state.pending?.name ?? null,
      // 返回会话当前使用的模型，以及等待下一轮边界生效的设置。
      model: state.generation.provider.model ?? null,
      outputTokens: state.generation.provider.outputTokens ?? null,
      selectedModel: deps.modelSelectionOf(state.generation.model)?.model ?? state.generation.provider.model ?? null,
      serviceId: deps.modelSelectionOf(state.generation.model)?.provider ?? resolveModel(state.generation.model).serviceId ?? 'legacy',
      pendingServiceId: state.pendingGeneration === undefined ? null : deps.modelSelectionOf(state.pendingGeneration.model)?.provider ?? null,
      pendingModel: state.pendingGeneration?.provider.model ?? null,
      contextTokens: state.generation.provider.contextTokens ?? null,
      thinking: {
        available: state.generation.provider.thinkingCapability?.efforts ?? [],
        defaultEffort: state.generation.provider.thinkingCapability?.defaultEffort ?? null,
        effective: state.generation.options.thinkingEffort ?? 'default',
        pending: state.pendingGeneration?.options.thinkingEffort ?? null,
      },
      // 分别返回当前模式和策略，并说明策略来自默认值还是会话覆盖。
      policy: state.chain.mode,
      policySource: state.chain.modeSource,
      policyDefault: state.chain.configuredMode(),
      permission: sessionPermissionView(state, controlAllowed),
      screenCapture: { enabled: state.screenCapture.enabled, source: state.screenCapture.source, changeAllowed: permissionControl },
      search: state.search,
      browser: browserView(state, permissionControl),
      taskLimits: taskLimitsOf(state.environment.config, state.loopModelCalls),
      task: state.taskBudget?.snapshot() ?? state.lastTask ?? null,
      denials: state.chain.denials(),
      delegation: currentGrant === undefined ? null : {
        grantId: currentGrant.id,
        name: currentGrant.name,
        source: currentGrant.source,
        defaultPermissionProfile: currentGrant.defaultPermissionProfile,
        maxPermissionProfile: currentGrant.maxPermissionProfile,
        defaultNetwork: currentGrant.defaultNetwork,
        maxNetwork: currentGrant.maxNetwork,
        defaultPolicy: currentGrant.defaultPolicy,
        allowedPolicies: currentGrant.allowedPolicies,
        allowOperator: currentGrant.allowOperator,
        allowScreenCapture: currentGrant.allowScreenCapture,
        allowedMcpServers: currentGrant.allowedMcpServers,
        allowedMcpTools: currentGrant.allowedMcpTools,
      },
      // 这里只返回条数；记录内容由 `session.read` 提供。
      eventCount: (await state.session.read()).length,
      // 返回工具名称、说明和参数模式，供客户端选择工具。
      templates: state.templates.templates.map(({ command, description, hint }) => ({ command, description, hint })),
      // 返回上下文窗口、压力阈值、投影 Token 数和提供方最近报告的用量。
      // 模型窗口未知时返回 null，因为此时无法估算上下文压力。
      usage: state.compaction === null ? null : await state.compaction.context(),
    };
  };
}
