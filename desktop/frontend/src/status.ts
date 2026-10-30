// `status.get` 返回的数据结构。协议方法和参数模式由 `core/src/host/protocol.ts` 定义。
// 此处只声明界面使用的字段；缺少字段时不参与渲染。
export type Usage = {
  window: number;
  threshold: number;
  retained: number;
  estimated: number;
  // Host 根据服务端用量计算的 Token 估算校准系数；无校准数据时为 1。
  factor: number;
  // 本地 Token 估算方法的标识。
  measurement: string;
  reported: { seq: number; input: number; output: number | null } | null;
};

export type Status = {
  sessionId: string;
  running: boolean;
  permission?: SessionPermission;
  screenCapture?: { enabled: boolean; source: 'none' | 'startup' | 'trusted-ui' | 'grant'; changeAllowed?: boolean };
  browser?: BrowserStatus;
  tools: string[];
  // 当前模式名称与权限策略是不同字段，分别维护。
  mode: string | null;
  modeLayer: string | null;
  pendingMode: string | null;
  model: string | null;
  selectedModel: string | null;
  outputTokens: number | null;
  pendingModel: string | null;
  serviceId: string;
  pendingServiceId: string | null;
  policy: string;
  // 当前策略来源：配置默认值或会话运行期覆盖。
  policySource: 'config' | 'session';
  policyDefault?: string;
  delegation?: {
    grantId: string;
    name: string;
    source: 'trusted-ui' | 'legacy';
    defaultPermissionProfile: PermissionProfile;
    maxPermissionProfile: PermissionProfile;
    defaultNetwork: PermissionNetwork;
    maxNetwork: PermissionNetwork;
    defaultPolicy: string;
    allowedPolicies: readonly string[];
    allowOperator: boolean;
    allowedMcpServers: readonly string[];
    allowedMcpTools: readonly string[];
  } | null;
  denials: { consecutive: number; total: number };
  eventCount: number;
  // 已加载的提示模板列表，供命令面板显示。
  templates: { command: string; description: string; hint: string | null }[];
  // 上下文窗口未知时 Host 返回 null；此时不启用压缩或显示压力条。
  usage: Usage | null;
  progress: RunProgress | null;
  taskLimits?: TaskLimits;
  task: TaskBudgetSnapshot | null;
};

export type TaskLimits = {
  maxModelCalls: number;
  timeoutMs: number;
  requestTimeoutMs: number;
  interactionWaitTimeoutMs: number;
};

export type TaskBudgetSnapshot = {
  modelCalls: number;
  maxModelCalls: number;
  timeoutMs: number;
  requestTimeoutMs: number;
  interactionWaitTimeoutMs: number;
  interactionWaitMs: number;
  executionElapsedMs: number;
  executionPaused: boolean;
  startedAt: string;
  deadlineAt: string;
};

export type TaskSummary = {
  modelCalls: number;
  maxModelCalls: number;
  executionRemainingMs: number;
  interactionWaitMs: number;
  interactionWaitTimeoutMs: number;
  executionPaused: boolean;
};

function durationLabel(milliseconds: number, language: 'zh' | 'en'): string {
  let remaining = Math.max(0, Math.ceil(milliseconds / 1000));
  const units: readonly [number, string][] = language === 'en'
    ? [[86_400, 'd'], [3_600, 'h'], [60, 'm'], [1, 's']]
    : [[86_400, '天'], [3_600, '小时'], [60, '分'], [1, '秒']];
  const parts: string[] = [];
  for (const [seconds, suffix] of units) {
    const count = Math.floor(remaining / seconds);
    if (count === 0 && parts.length === 0 && seconds !== 1) continue;
    if (count > 0) {
      parts.push(`${count}${suffix}`);
      remaining -= count * seconds;
      if (parts.length === 2) break;
    }
  }
  if (parts.length === 0) return language === 'en' ? '0s' : '0秒';
  return parts.join(language === 'en' ? ' ' : '');
}

export function taskSummaryLabelOf(summary: TaskSummary, language: 'zh' | 'en'): string {
  const modelCalls = language === 'zh' ? '次模型调用' : 'model calls';
  const executionLeft = language === 'zh' ? '执行剩余' : 'execution left';
  const interactionWait = language === 'zh' ? '累计交互等待' : 'interaction wait';
  const interactionLimit = summary.interactionWaitTimeoutMs;
  const paused = summary.executionPaused ? (language === 'zh' ? ' · 执行期限已暂停' : ' · deadline paused') : '';
  return `${summary.modelCalls}/${summary.maxModelCalls} ${modelCalls} · ${executionLeft} ${durationLabel(summary.executionRemainingMs, language)} · ${interactionWait} ${durationLabel(summary.interactionWaitMs, language)}/${durationLabel(interactionLimit, language)}${paused}`;
}

/** Project a Host task snapshot forward without letting wall time consume a paused execution budget. */
export function taskSummaryOf(
  task: TaskBudgetSnapshot | null | undefined,
  limits: TaskLimits | undefined,
  progress: RunProgress | null | undefined,
  snapshotAt: number,
  now: number,
): TaskSummary | null {
  const snapshot = progress === null || progress === undefined ? task : progress.task;
  if (snapshot === null || snapshot === undefined) return null;
  const maxModelCalls = snapshot.maxModelCalls ?? limits?.maxModelCalls;
  const timeoutMs = snapshot.timeoutMs ?? limits?.timeoutMs;
  const interactionWaitTimeoutMs = snapshot.interactionWaitTimeoutMs ?? limits?.interactionWaitTimeoutMs;
  if (maxModelCalls === undefined || timeoutMs === undefined || interactionWaitTimeoutMs === undefined) return null;
  const waiting = progress?.phase === 'awaiting_approval' || progress?.phase === 'awaiting_input';
  // Only the budget snapshot can say whether all concurrent work is paused; phase alone is insufficient.
  const executionPaused = snapshot.executionPaused;
  const executionElapsedMs = snapshot.executionElapsedMs + (executionPaused ? 0 : Math.max(0, now - snapshotAt));
  const interactionStartAt = waiting ? Math.max(snapshotAt, progress!.phaseStartedAt) : snapshotAt;
  const interactionWaitMs = snapshot.interactionWaitMs + (waiting ? Math.max(0, now - interactionStartAt) : 0);
  return {
    modelCalls: Math.max(snapshot.modelCalls, progress?.modelCalls ?? 0),
    maxModelCalls,
    executionRemainingMs: Math.max(0, timeoutMs - executionElapsedMs),
    interactionWaitMs,
    interactionWaitTimeoutMs,
    executionPaused,
  };
}

export type BrowserStatus = {
  configured: boolean;
  available: boolean;
  permitted: boolean;
  code?: string;
  paused: boolean;
  connected: boolean;
  changeAllowed: boolean;
};

export type PermissionProfile = 'read-only' | 'workspace-write' | 'full-access';
export type PermissionNetwork = 'policy' | 'unrestricted' | 'disabled';
export type PermissionEnforcement = 'full' | 'partial' | 'unavailable';

export type SessionPermission = {
  profile: PermissionProfile;
  network: PermissionNetwork;
  capabilities: {
    filesystemRead: PermissionEnforcement;
    filesystemWrite: PermissionEnforcement;
    network: PermissionEnforcement;
    process: PermissionEnforcement;
  };
  profiles: {
    readOnly: PermissionEnforcement;
    workspaceWrite: PermissionEnforcement;
  };
  limitations: readonly string[];
  partialWorkspaceWriteConfirmationRequired: boolean;
  partialWorkspaceWriteConfirmed: boolean;
  workspaceTrusted: boolean;
  execution: { available: boolean; code: string | null; reason: string | null };
  changeAllowed: boolean;
  changeReason?: string;
};

export type ProviderDiagnosticCategory = 'authentication' | 'rate_limit' | 'client' | 'server' | 'http' | 'transport' | 'stream' | 'invalid_response' | 'cancelled';

export type ProviderDiagnostic = {
  category: ProviderDiagnosticCategory;
  status?: number;
  attempts: number;
  responseReceived: boolean;
  streamReceived: boolean;
  recoverable: boolean;
};

export type RunProgress = {
  phase: 'preparing' | 'model_request' | 'tool_execution' | 'compaction' | 'awaiting_approval' | 'awaiting_input' | 'settling';
  startedAt: number;
  phaseStartedAt: number;
  lastProgressAt: number;
  modelCalls: number;
  toolCalls: number;
  outputTokens: number | null;
  task?: TaskBudgetSnapshot;
};
