import type { DelegationSpec } from '../delegation.js';
import type { CredentialStatus } from '../kernel/credentials.js';
import type { LoopResult } from '../kernel/loop.js';
import type { ModelSelection, ModelService } from '../kernel/model-services.js';
import type { AgentPresetPage } from '../kernel/agent-presets.js';
import type { BranchResult } from '../session/branch.js';
import type { SessionEvent, SessionHeader } from '../session/format.js';
import type { SessionSummary } from '../session/list.js';
import type { SearchHit } from '../session/search.js';
import type { UsageSummary } from '../session/usage-summary.js';
import type { AskAnswer, AskQuestion } from '../tools/ask-user.js';
import type { AgentPresetPreview, SubrunReference, SubrunStatus } from '../tools/subagent.js';
import type { SessionControlSnapshot, SessionReadPage } from '../wire.js';
import type { Exported } from './export.js';
import type { McpTrustScope } from './mcp-trust.js';
import type { PathListing } from './paths.js';

export type HostPolicyValue = 'always' | 'ask' | 'auto' | 'never';

export interface HostTaskBudget {
  readonly modelCalls: number;
  readonly maxModelCalls: number;
  readonly timeoutMs: number;
  readonly interactionWaitTimeoutMs: number;
  readonly interactionWaitMs: number;
  readonly executionElapsedMs: number;
  readonly executionPaused: boolean;
}

export interface HostProgress {
  readonly phase: 'preparing' | 'model_request' | 'tool_execution' | 'compaction' | 'awaiting_approval' | 'awaiting_input' | 'settling';
  readonly startedAt: number;
  readonly phaseStartedAt: number;
  readonly lastProgressAt: number;
  readonly modelCalls: number;
  readonly toolCalls: number;
  readonly outputTokens: number | null;
  readonly task?: HostTaskBudget;
}

export interface HostBrowserStatus {
  readonly configured: boolean;
  readonly available: boolean;
  readonly permitted: boolean;
  readonly code?: string;
  readonly paused: boolean;
  readonly connected: boolean;
  readonly changeAllowed: boolean;
}

export interface HostPermissionStatus {
  readonly profile: 'read-only' | 'workspace-write' | 'full-access';
  readonly network: 'policy' | 'unrestricted' | 'disabled';
  readonly capabilities: {
    readonly filesystemRead: 'full' | 'partial' | 'unavailable';
    readonly filesystemWrite: 'full' | 'partial' | 'unavailable';
    readonly network: 'full' | 'partial' | 'unavailable';
    readonly process: 'full' | 'partial' | 'unavailable';
  };
  readonly profiles: {
    readonly readOnly: 'full' | 'partial' | 'unavailable';
    readonly workspaceWrite: 'full' | 'partial' | 'unavailable';
  };
  readonly limitations: readonly string[];
  readonly partialWorkspaceWriteConfirmationRequired: boolean;
  readonly partialWorkspaceWriteConfirmed: boolean;
  readonly workspaceTrusted: boolean;
  readonly execution: { readonly available: boolean; readonly code: string | null; readonly reason: string | null };
  readonly changeAllowed: boolean;
  readonly changeReason?: string;
}

export interface HostStatus<Template = Record<string, unknown>> {
  readonly sessionId?: string;
  readonly running?: boolean;
  readonly activeRunId?: string | null;
  readonly screenCapture?: { readonly enabled: boolean; readonly source: string; readonly changeAllowed?: boolean };
  readonly browser?: HostBrowserStatus;
  readonly model?: string | null;
  readonly selectedModel?: string | null;
  readonly pendingModel?: string | null;
  readonly serviceId?: string | null;
  readonly pendingServiceId?: string | null;
  readonly outputTokens?: number | null;
  readonly thinking?: {
    readonly available: readonly string[];
    readonly defaultEffort: string | null;
    readonly effective: string;
    readonly pending: string | null;
  } | null;
  readonly mode?: string | null;
  readonly modeLayer?: string | null;
  readonly pendingMode?: string | null;
  readonly policy: string;
  readonly policySource?: string;
  readonly permission?: HostPermissionStatus;
  readonly tools: string[];
  readonly eventCount: number;
  readonly denials: { readonly consecutive: number; readonly total: number };
  readonly usage?: { readonly estimated: number; readonly window: number; readonly threshold: number } | null;
  readonly progress?: HostProgress | null;
  readonly taskLimits?: { readonly maxModelCalls: number; readonly timeoutMs: number; readonly requestTimeoutMs: number; readonly interactionWaitTimeoutMs: number };
  readonly task?: HostTaskBudget | null;
  readonly templates?: Template[];
  readonly [key: string]: unknown;
}

export interface HostAgentGrant {
  readonly id: string;
  readonly name: string;
  readonly projectRoot: string;
  readonly source: 'trusted-ui' | 'legacy';
  readonly defaultPermissionProfile: 'read-only' | 'workspace-write' | 'full-access';
  readonly maxPermissionProfile: 'read-only' | 'workspace-write' | 'full-access';
  readonly defaultNetwork: 'disabled' | 'policy' | 'unrestricted';
  readonly maxNetwork: 'disabled' | 'policy' | 'unrestricted';
  readonly defaultPolicy: HostPolicyValue;
  readonly allowedPolicies: readonly HostPolicyValue[];
  readonly allowOperator: boolean;
  readonly allowedMcpServers: readonly string[];
  readonly allowedMcpTools: readonly string[];
  readonly confirmedPartialWorkspaceWrite: boolean;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
}

export interface HostAgentControlSnapshot {
  readonly version: string;
  readonly grants: readonly HostAgentGrant[];
}

export interface HostMcpServerSummary {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environmentNames: readonly string[];
  readonly identityDigest: string;
  readonly trust: { readonly scope: McpTrustScope; readonly source: 'trusted-ui'; readonly trusted: boolean } | null;
  readonly trustScopes: Readonly<Record<McpTrustScope, { readonly source: 'trusted-ui'; readonly trusted: boolean } | null>>;
}

export interface HostMcpTrustSnapshot {
  readonly version: string;
  readonly servers: readonly HostMcpServerSummary[];
}

export interface HostMcpToolsSnapshot {
  readonly server: string;
  readonly identityDigest: string;
  readonly tools: readonly { readonly name: string; readonly description: string; readonly digest: string }[];
}

export interface HostConfigResult extends Record<string, unknown> {
  readonly services: ModelService[];
  readonly selection: ModelSelection | null;
  readonly model?: { readonly model?: string; readonly apiKeyEnv?: string };
  readonly layers?: readonly { readonly layer: string; readonly version: string }[];
}

export type HostSubrunReference = SubrunReference & { readonly parentRunId: string };
export type HostSubrunStatus = HostSubrunReference & Pick<SubrunStatus, 'state' | 'phase' | 'errorCode'>;

export interface HostPresetPreview extends Pick<AgentPresetPreview, 'presetId' | 'layer' | 'description'> {
  readonly instruction: string;
  readonly executable: boolean;
  readonly mode: { readonly name: string; readonly tools: readonly string[] | '*'; readonly prompt: readonly string[] | '*' };
  readonly permission: { readonly profile: string; readonly network: string };
  readonly generation: { readonly outputTokens: number | null; readonly thinkingEffort: string | null };
  readonly limits: { readonly loopIterations: number; readonly modelCalls: number };
  readonly requiredChecks: readonly string[];
  readonly narrowedFields: readonly string[];
}

export interface HostExecutionReference {
  readonly executionId: string;
  readonly runId: string;
}

export interface HostExecutionStatus {
  readonly executionId: string;
  readonly state: string;
  readonly exitCode?: number;
  readonly errorCode?: string;
  readonly cancelRequested: boolean;
  readonly deadlineExceeded: boolean;
  readonly terminationPending: boolean;
  readonly cleanupPending: boolean;
  readonly logAvailable: boolean;
  readonly logUnavailableReason?: string;
}

export interface HostExecutionWait extends HostExecutionStatus {
  readonly waitTimedOut: boolean;
}

export interface HostExecutionLogPage {
  readonly executionId: string;
  readonly cursor: string;
  readonly nextCursor: string;
  readonly hasMore: boolean;
  readonly gap: boolean;
  readonly truncated: boolean;
  readonly available: boolean;
  readonly unavailableReason?: string;
  readonly events: readonly { readonly stream: 'stdout' | 'stderr'; readonly text: string; readonly decodeLossPossible: boolean }[];
}

export interface HostToolResult {
  readonly sessionId: string;
  readonly runId: string;
  readonly callId: string;
  readonly tool?: string;
  readonly state: string;
  readonly code?: string;
  readonly eventSeq?: number;
  readonly output?: {
    readonly returnedValueBytes: number | null;
    readonly modelVisibleBytes: number | null;
    readonly storageStatus: string;
    readonly storedBytes: number | null;
    readonly storedComplete: boolean | null;
    readonly page: { readonly bytes: number; readonly dataBase64: string; readonly done: boolean; readonly nextCursor: string | null } | null;
  };
  readonly fileChanges?: readonly {
    readonly path: string;
    readonly operation: string;
    readonly outcome: string;
    readonly baselineStatus: string;
    readonly observedStatus: string;
    readonly beforeVersion: string | null;
    readonly expectedAfterVersion: string | null;
    readonly observedAfterVersion: string | null;
    readonly changedFromBaseline: boolean | null;
  }[];
  readonly check?: {
    readonly status: string;
    readonly declaration: { readonly name: string };
    readonly commandStatus?: string;
    readonly errorCode?: string;
    readonly reportStatus?: string;
    readonly logStatus?: string;
    readonly scopeStatus?: string;
    readonly startedAt?: string;
    readonly endedAt?: string;
    readonly logsRef?: { readonly name: string; readonly bytes: number; readonly sha256: string };
    readonly report?: { readonly passed: number; readonly failed: number; readonly skipped: number; readonly todo: number };
  };
}

export type HostExternalControlSnapshot = Pick<SessionControlSnapshot,
  'sessionId' | 'state' | 'pendingInteractions' | 'events' | 'nextCursor' | 'eventGap' | 'firstAvailableCursor' | 'queue'> & {
  readonly operationId?: string;
  readonly phase?: string | null;
  readonly progress?: HostProgress | null;
};

export interface HostSettingsCatalog {
  readonly tools: readonly { readonly name: string; readonly description: string; readonly source: string }[];
  readonly extensions: readonly { readonly name: string; readonly source: string; readonly enabled: boolean; readonly loaded: boolean; readonly registeredTools: readonly string[] }[];
  readonly extensionDiagnostics: readonly { readonly code: string; readonly source: string }[];
  readonly customToolDiagnostics: readonly { readonly code: string; readonly source: string }[];
  readonly [key: string]: unknown;
}

export interface HostScriptBinding {
  readonly path?: string;
  readonly sha256?: string;
  readonly interpreter?: string;
  readonly workspaceRoot?: string;
  readonly permission?: {
    readonly profile?: string;
    readonly network?: string;
    readonly capabilities?: Record<string, string>;
  };
}

export interface ApprovalRequestParams {
  readonly sessionId?: string;
  readonly sourceSessionId?: string;
  readonly projectRoot?: string;
  readonly tool?: string;
  readonly command?: string;
  readonly args?: Record<string, unknown>;
  readonly reason?: string;
  readonly shell?: string;
  readonly executable?: string;
  readonly policy?: string;
  readonly policySource?: string;
  readonly policyForced?: boolean;
  readonly detailsRef?: string;
  readonly argumentBytes?: number;
  readonly argumentSha256?: string;
  readonly identityDigest?: string;
  readonly contentBytes?: number;
  readonly contentSha256?: string;
  readonly rememberable?: boolean;
  readonly rememberScopes?: readonly ('session' | 'project' | 'user')[];
  readonly rememberHintKey?: 'file' | 'tool' | 'command' | 'mcp';
  readonly rememberTargetOptions?: readonly ('file' | 'workspace' | 'tool' | 'command')[];
  readonly scriptBinding?: HostScriptBinding;
}

export interface ApprovalRequestResult {
  readonly decision: 'allow' | 'deny';
  readonly remember?: boolean;
  readonly rememberScope?: McpTrustScope;
  readonly rememberTarget?: 'file' | 'workspace' | 'tool' | 'command';
}

export interface QuestionRequestParams {
  readonly sessionId: string;
  readonly sourceSessionId?: string;
  readonly questions: readonly AskQuestion[];
}

export interface QuestionRequestResult {
  readonly answers: readonly AskAnswer[];
}

export interface ViewRequestParams {
  readonly sessionId: string;
  readonly requestId: string;
  readonly kind: string;
  readonly [key: string]: unknown;
}

export interface ViewRequestResult {
  readonly opened: boolean;
  readonly [key: string]: unknown;
}

export interface HostRequestMap {
  readonly 'approval.request': { readonly params: ApprovalRequestParams; readonly result: ApprovalRequestResult };
  readonly 'question.request': { readonly params: QuestionRequestParams; readonly result: QuestionRequestResult };
  readonly 'view.request': { readonly params: ViewRequestParams; readonly result: ViewRequestResult };
}

export type HostRequestName = keyof HostRequestMap;

export interface HostNotificationMap {
  readonly delta: { readonly sessionId: string; readonly event: Record<string, unknown>; readonly [key: string]: unknown };
  readonly event: { readonly sessionId: string; readonly event: SessionEvent | Record<string, unknown>; readonly [key: string]: unknown };
  readonly fault: { readonly sessionId?: string; readonly code?: string; readonly detail?: string; readonly [key: string]: unknown };
  readonly progress: { readonly sessionId: string; readonly progress: HostProgress | null; readonly [key: string]: unknown };
  readonly 'view.ready': { readonly sessionId: string; readonly [key: string]: unknown };
}

export type HostNotificationName = keyof HostNotificationMap;

export type HostSessionPage = Pick<SessionReadPage, 'sessionId' | 'events' | 'header' | 'label' | 'endSeq' | 'hasMore' | 'writerActive'>;

export interface HostMethodMap {
  readonly 'workspace.trust': {
    readonly params: { readonly projectRoot: string; readonly trusted: boolean };
    readonly result: { readonly projectRoot: string; readonly trusted: boolean };
  };
  readonly 'session.create': {
    readonly params: {
      readonly projectRoot?: string;
      readonly initialMode?: string;
      readonly initialPolicy?: string;
      readonly initialPermissionProfile?: string;
      readonly initialPermissionNetwork?: string;
      readonly confirmInitialFullAccess?: boolean;
      readonly confirmInitialNetwork?: boolean;
      readonly confirmInitialPartialWorkspaceWrite?: boolean;
      readonly confirmInitialWorkspaceTrust?: boolean;
      readonly initialProvider?: string;
      readonly initialModel?: string;
      readonly initialThinkingEffort?: string;
      readonly initialOutputTokens?: number;
      readonly initialLoopIterations?: number;
    };
    readonly result: { readonly sessionId: string };
  };
  readonly 'session.side.create': {
    readonly params: {
      readonly sessionId: string;
      readonly sourceKind: 'event' | 'file' | 'diff';
      readonly sourceEventSeq?: number;
      readonly sourcePath?: string;
      readonly sourceVersion?: string;
      readonly selection?: string;
    };
    readonly result: { readonly sessionId: string; readonly [key: string]: unknown };
  };
  readonly 'view.request.ack': {
    readonly params: { readonly sessionId: string; readonly runId: string; readonly requestId: string; readonly action: 'opened' | 'dismissed' };
    readonly result: { readonly ok?: boolean; readonly [key: string]: unknown };
  };
  readonly 'session.open': {
    readonly params: { readonly sessionId: string; readonly mode?: string; readonly projectRoot?: string };
    readonly result: { readonly sessionId: string };
  };
  readonly 'session.close': {
    readonly params: { readonly sessionId: string };
    readonly result: { readonly sessionId: string };
  };
  readonly 'session.label': {
    readonly params: { readonly sessionId: string; readonly name?: string; readonly archived?: boolean };
    readonly result: { readonly sessionId: string; readonly name: string; readonly archived: boolean };
  };
  readonly 'session.branch': {
    readonly params: { readonly sessionId: string; readonly at?: number; readonly name?: string };
    readonly result: BranchResult;
  };
  readonly 'sessions.list': {
    readonly params: { readonly projectRoot?: string };
    readonly result: { readonly sessions: SessionSummary[] };
  };
  readonly 'sessions.search': {
    readonly params: { readonly query: string; readonly projectRoot?: string; readonly limit?: number };
    readonly result: { readonly hits: SearchHit[] };
  };
  readonly 'paths.list': {
    readonly params: { readonly sessionId?: string; readonly projectRoot?: string; readonly query?: string; readonly limit?: number };
    readonly result: PathListing;
  };
  readonly 'project.files.list': {
    readonly params: { readonly sessionId: string; readonly path?: string; readonly offset?: number; readonly limit?: number };
    readonly result: Record<string, unknown>;
  };
  readonly 'project.files.search': {
    readonly params: { readonly sessionId: string; readonly query: string; readonly path?: string; readonly offset?: number; readonly limit?: number };
    readonly result: Record<string, unknown>;
  };
  readonly 'project.file.read': {
    readonly params: { readonly sessionId: string; readonly path: string; readonly offsetBytes?: number; readonly limitBytes?: number };
    readonly result: Record<string, unknown>;
  };
  readonly 'project.file.save': {
    readonly params: { readonly sessionId: string; readonly path: string; readonly expectedVersion: string; readonly text: string };
    readonly result: Record<string, unknown>;
  };
  readonly 'project.git.status': {
    readonly params: { readonly sessionId: string };
    readonly result: Record<string, unknown>;
  };
  readonly 'project.git.diff': {
    readonly params: { readonly sessionId: string; readonly path: string };
    readonly result: Record<string, unknown>;
  };
  readonly 'session.read': {
    readonly params: { readonly sessionId: string; readonly fullResults?: boolean; readonly before?: number; readonly limit?: number; readonly at?: number };
    readonly result: SessionReadPage;
  };
  readonly 'tool.result': {
    readonly params: { readonly sessionId: string; readonly runId: string; readonly callId: string; readonly cursor?: string; readonly limitBytes?: number };
    readonly result: HostToolResult;
  };
  readonly 'session.observe': {
    readonly params: { readonly projectRoot?: string; readonly sessionId: string; readonly fullResults?: boolean; readonly before?: number; readonly limit?: number; readonly at?: number };
    readonly result: HostSessionPage & { readonly writerActive: boolean };
  };
  readonly 'session.image.preview': {
    readonly params: { readonly projectRoot?: string; readonly sessionId: string; readonly imageId: string };
    readonly result: { readonly path?: string; readonly mimeType?: string; readonly base64?: string; readonly dataBase64?: string; readonly bytes?: number; readonly [key: string]: unknown };
  };
  readonly 'browser.stop': {
    readonly params: { readonly sessionId: string };
    readonly result: { readonly sessionId: string; readonly browser: HostBrowserStatus };
  };
  readonly 'browser.resume': {
    readonly params: { readonly sessionId: string };
    readonly result: { readonly sessionId: string; readonly browser: HostBrowserStatus };
  };
  readonly 'session.control': {
    readonly params: { readonly projectRoot?: string; readonly sessionId: string; readonly request: unknown };
    readonly result: HostExternalControlSnapshot & Partial<HostStatus> & { readonly pendingCount?: number; readonly cancelledInteractions?: number } & Record<string, unknown>;
  };
  readonly 'approval.details': {
    readonly params: { readonly sessionId: string; readonly requestId: string };
    readonly result: { readonly requestId: string; readonly sessionId: string; readonly argumentSha256: string; readonly args: Record<string, unknown> };
  };
  readonly 'session.export': {
    readonly params: { readonly sessionId: string; readonly path?: string };
    readonly result: Exported;
  };
  readonly 'run.start': {
    readonly params: { readonly sessionId: string; readonly input?: string; readonly origin?: 'human' | 'controller'; readonly delegation?: DelegationSpec; readonly requestKey?: string };
    readonly result: LoopResult;
  };
  readonly 'storage.inspect': {
    readonly params: { readonly projectRoot: string };
    readonly result: Record<string, unknown>;
  };
  readonly 'storage.cleanup.preview': {
    readonly params: { readonly projectRoot: string; readonly limit?: number; readonly cursor?: string };
    readonly result: Record<string, unknown>;
  };
  readonly 'storage.cleanup.apply': {
    readonly params: { readonly projectRoot: string; readonly confirm?: boolean; readonly planId: string };
    readonly result: Record<string, unknown>;
  };
  readonly 'artifact.list': {
    readonly params: { readonly projectRoot: string; readonly sessionId: string; readonly runId?: string; readonly limit?: number; readonly offset?: number };
    readonly result: Record<string, unknown>;
  };
  readonly 'artifact.resolve': {
    readonly params: { readonly projectRoot?: string; readonly sessionId?: string; readonly artifactKey: string };
    readonly result: Record<string, unknown>;
  };
  readonly 'artifact.inspect': {
    readonly params: { readonly projectRoot?: string; readonly sessionId?: string; readonly artifactKey: string };
    readonly result: Record<string, unknown>;
  };
  readonly 'artifact.preview': {
    readonly params: { readonly projectRoot?: string; readonly sessionId?: string; readonly artifactKey: string; readonly offsetBytes?: number; readonly limitBytes?: number };
    readonly result: Record<string, unknown>;
  };
  readonly 'run.submit': {
    readonly params: { readonly sessionId: string; readonly input?: string; readonly origin?: 'human' | 'controller'; readonly delegation?: DelegationSpec; readonly requestKey?: string };
    readonly result: Record<string, unknown>;
  };
  readonly 'run.wait': {
    readonly params: { readonly sessionId: string; readonly runId?: string; readonly timeoutMs?: number };
    readonly result: Record<string, unknown>;
  };
  readonly 'run.receipt': {
    readonly params: { readonly sessionId: string; readonly runId: string };
    readonly result: Record<string, unknown>;
  };
  readonly 'run.receipts': {
    readonly params: { readonly sessionId: string; readonly projectRoot?: string; readonly limit?: number; readonly before?: number; readonly cursor?: string };
    readonly result: Record<string, unknown>;
  };
  readonly 'run.result': {
    readonly params: { readonly projectRoot: string; readonly sessionId: string; readonly runId: string; readonly offset?: number };
    readonly result: Record<string, unknown>;
  };
  readonly 'run.cancel': {
    readonly params: { readonly sessionId: string };
    readonly result: { readonly cancelled: boolean };
  };
  readonly 'execution.status': {
    readonly params: { readonly sessionId: string; readonly runId?: string; readonly executionId: string };
    readonly result: HostExecutionStatus;
  };
  readonly 'execution.wait': {
    readonly params: { readonly sessionId: string; readonly runId?: string; readonly executionId: string; readonly waitMs?: number };
    readonly result: HostExecutionWait;
  };
  readonly 'execution.logs': {
    readonly params: { readonly sessionId: string; readonly runId?: string; readonly executionId: string; readonly cursor?: string; readonly limitBytes?: number };
    readonly result: HostExecutionLogPage;
  };
  readonly 'execution.cancel': {
    readonly params: { readonly sessionId: string; readonly runId?: string; readonly executionId: string };
    readonly result: HostExecutionStatus;
  };
  readonly 'operation.start': {
    readonly params: { readonly sessionId?: string; readonly command: string; readonly cwd?: string };
    readonly result: Record<string, unknown>;
  };
  readonly 'run.steer': {
    readonly params: { readonly sessionId: string; readonly runId: string; readonly input: string; readonly origin?: 'human' | 'controller'; readonly requestKey?: string };
    readonly result: {
      readonly inputId: string;
      readonly runId: string;
      readonly state: 'accepted';
      readonly source: 'human' | 'controller';
      readonly pendingCount: number;
      readonly cancelledInteractions: number;
    };
  };
  readonly 'subrun.start': {
    readonly params: { readonly sessionId: string; readonly parentRunId: string; readonly task: string; readonly presetId?: string; readonly outputSchema?: Record<string, unknown> };
    readonly result: HostSubrunReference;
  };
  readonly 'subrun.list': {
    readonly params: { readonly sessionId: string; readonly parentRunId?: string; readonly cursor?: string; readonly limit?: number };
    readonly result: { readonly subruns: readonly HostSubrunStatus[]; readonly nextCursor?: string; readonly truncated: boolean };
  };
  readonly 'preset.list': {
    readonly params: { readonly projectRoot?: string; readonly sessionId?: string; readonly cursor?: string; readonly limit?: number };
    readonly result: AgentPresetPage;
  };
  readonly 'preset.preview': {
    readonly params: { readonly projectRoot?: string; readonly sessionId?: string; readonly presetId: string };
    readonly result: HostPresetPreview;
  };
  readonly 'subrun.status': {
    readonly params: { readonly sessionId: string; readonly parentRunId?: string; readonly subrunId: string };
    readonly result: HostSubrunStatus;
  };
  readonly 'subrun.message': {
    readonly params: { readonly sessionId: string; readonly parentRunId?: string; readonly subrunId: string; readonly runId?: string; readonly input: string; readonly requestKey?: string };
    readonly result: { readonly subrunId: string; readonly runId: string; readonly state: 'accepted'; readonly pendingCount: number };
  };
  readonly 'subrun.wait': {
    readonly params: { readonly sessionId: string; readonly parentRunId?: string; readonly subrunIds: readonly string[]; readonly timeoutMs?: number };
    readonly result: { readonly timedOut: boolean; readonly subruns: readonly HostSubrunStatus[] };
  };
  readonly 'subrun.cancel': {
    readonly params: { readonly sessionId: string; readonly parentRunId?: string; readonly subrunId: string; readonly runId?: string };
    readonly result: { readonly subrunId: string; readonly runId: string; readonly cancelRequested: boolean; readonly state: string };
  };
  readonly 'status.get': {
    readonly params: { readonly sessionId: string };
    readonly result: HostStatus;
  };
  readonly 'usage.get': {
    readonly params: { readonly sessionId: string; readonly projectRoot?: string };
    readonly result: { readonly sessionId: string; readonly summary: UsageSummary };
  };
  readonly 'usage.diagnostics': {
    readonly params: { readonly sessionId: string; readonly action?: 'enable' | 'disable' | 'read' };
    readonly result: { readonly enabled: boolean; readonly entries: readonly Record<string, unknown>[] };
  };
  readonly 'session.configure': {
    readonly params: {
      readonly sessionId: string;
      readonly provider?: string;
      readonly model?: string;
      readonly thinkingEffort?: string;
      readonly outputTokens?: number;
      readonly loopIterations?: number;
      readonly modelCalls?: number;
      readonly resetModel?: boolean;
      readonly resetThinking?: boolean;
      readonly resetOutputTokens?: boolean;
    };
    readonly result: { readonly applies: 'now' | 'next_round' | 'unchanged'; readonly [key: string]: unknown };
  };
  readonly 'workspaces.list': {
    readonly params: Record<string, never> | Record<string, unknown>;
    readonly result: { readonly workspaces: { readonly identity: string; readonly directory: string; readonly name: string; readonly firstSeen: string; readonly lastSeen: string }[]; readonly default: string | null };
  };
  readonly 'workspace.default.set': {
    readonly params: { readonly directory: string | null; readonly name?: string };
    readonly result: Record<string, unknown>;
  };
  readonly 'workspace.remove': {
    readonly params: { readonly directory: string };
    readonly result: Record<string, unknown>;
  };
  readonly 'history.read': {
    readonly params: Record<string, never> | Record<string, unknown>;
    readonly result: { readonly entries: readonly string[] };
  };
  readonly 'history.append': {
    readonly params: { readonly text: string };
    readonly result: { readonly entries: readonly string[] };
  };
  readonly 'credentials.status': {
    readonly params: { readonly reference: string };
    readonly result: CredentialStatus;
  };
  readonly 'model.select': {
    readonly params: { readonly sessionId: string; readonly provider: string; readonly model: string };
    readonly result: { readonly model: string | null; readonly serviceId: string; readonly when: 'now' | 'round' };
  };
  readonly 'models.discover': {
    readonly params: { readonly api: string; readonly baseURL: string; readonly reference: string; readonly temporaryKey?: string; readonly projectRoot?: string };
    readonly result: { readonly models: readonly string[]; readonly [key: string]: unknown };
  };
  readonly 'credentials.set': {
    readonly params: { readonly reference: string; readonly value: string };
    readonly result: Record<string, unknown>;
  };
  readonly 'credentials.delete': {
    readonly params: { readonly reference: string };
    readonly result: Record<string, unknown>;
  };
  readonly 'prefs.read': {
    readonly params: Record<string, never> | Record<string, unknown>;
    readonly result: { readonly settings: Record<string, unknown>; readonly version: string };
  };
  readonly 'prefs.write': {
    readonly params: { readonly json: string; readonly version: string };
    readonly result: { readonly settings: Record<string, unknown>; readonly version: string };
  };
  readonly 'agent-control.list': {
    readonly params: Record<string, never> | Record<string, unknown>;
    readonly result: HostAgentControlSnapshot;
  };
  readonly 'agent-control.create': {
    readonly params: {
      readonly projectRoot: string;
      readonly grantName: string;
      readonly defaultPermissionProfile: string;
      readonly maxPermissionProfile: string;
      readonly defaultNetwork: string;
      readonly maxNetwork: string;
      readonly defaultPolicy: string;
      readonly policySemantics?: number;
      readonly allowedPolicyAlways?: boolean;
      readonly allowedPolicyAsk?: boolean;
      readonly allowedPolicyAuto?: boolean;
      readonly allowedPolicyNone?: boolean;
      readonly allowedPolicyNever?: boolean;
      readonly allowOperator?: boolean;
      readonly allowedMcpServers?: readonly string[];
      readonly allowedMcpTools?: readonly string[];
      readonly confirmPartialWorkspaceWrite?: boolean;
      readonly confirmWorkspaceTrust?: boolean;
      readonly confirmFullAccess?: boolean;
      readonly confirmUnrestrictedNetwork?: boolean;
      readonly expiresAt?: string | null;
      readonly version: string;
    };
    readonly result: HostAgentControlSnapshot;
  };
  readonly 'screen-capture.set': {
    readonly params: { readonly sessionId: string; readonly enabled: boolean; readonly confirmScreenCapture?: boolean };
    readonly result: { readonly sessionId: string; readonly enabled: boolean; readonly source: string };
  };
  readonly 'agent-control.revoke': {
    readonly params: { readonly grantId: string; readonly version: string };
    readonly result: HostAgentControlSnapshot;
  };
  readonly 'mcp.trust.list': {
    readonly params: { readonly projectRoot?: string; readonly sessionId?: string };
    readonly result: HostMcpTrustSnapshot;
  };
  readonly 'settings.catalog': {
    readonly params: { readonly projectRoot?: string; readonly sessionId?: string; readonly mode?: string };
    readonly result: HostSettingsCatalog;
  };
  readonly 'mcp.trust.set': {
    readonly params: {
      readonly projectRoot?: string;
      readonly sessionId?: string;
      readonly server: string;
      readonly identityDigest: string;
      readonly scope: 'session' | 'project' | 'user';
      readonly trusted: boolean;
      readonly confirmTrust?: boolean;
      readonly confirmExternalAccess?: boolean;
      readonly version?: string;
    };
    readonly result: { readonly server: string; readonly scope: 'session' | 'project' | 'user'; readonly trusted: boolean; readonly version?: string };
  };
  readonly 'mcp.trust.tools': {
    readonly params: { readonly projectRoot?: string; readonly sessionId?: string; readonly server: string };
    readonly result: HostMcpToolsSnapshot;
  };
  readonly 'extensions.set': {
    readonly params: { readonly projectRoot?: string; readonly name: string; readonly enabled: boolean };
    readonly result: { readonly name: string; readonly enabled: boolean; readonly applies: string };
  };
  readonly 'config.get': {
    readonly params: { readonly projectRoot?: string };
    readonly result: HostConfigResult;
  };
  readonly 'config.set': {
    readonly params: {
      readonly field: string;
      readonly value?: unknown;
      readonly layer: string;
      readonly version: string;
      readonly projectRoot?: string;
      readonly op?: string;
      readonly index?: number;
      readonly ruleTool?: string;
      readonly ruleDecision?: string;
      readonly ruleMatch?: string;
      readonly ruleReason?: string;
      readonly ruleTarget?: string;
      readonly rulePath?: string;
      readonly ruleArgsHash?: string;
      readonly serverName?: string;
      readonly serverCommand?: string;
      readonly serverArgs?: readonly string[];
      readonly serverEnv?: Readonly<Record<string, string>>;
      readonly serverCwd?: string;
    };
    readonly result: { readonly version: string; readonly created: boolean; readonly [key: string]: unknown };
  };
  readonly 'policy.set': {
    readonly params: { readonly sessionId: string; readonly mode: string };
    readonly result: { readonly policy: string; readonly policySource: string; readonly policyDefault: string };
  };
  readonly 'permission.set': {
    readonly params: {
      readonly sessionId: string;
      readonly permissionProfile: string;
      readonly permissionNetwork?: string;
      readonly confirmFullAccess?: boolean;
      readonly confirmNetwork?: boolean;
      readonly confirmPartialWorkspaceWrite?: boolean;
      readonly confirmWorkspaceTrust?: boolean;
    };
    readonly result: { readonly sessionId: string; readonly permission: HostPermissionStatus; readonly applies: 'now' | 'unchanged' };
  };
  readonly 'mode.set': {
    readonly params: { readonly sessionId: string; readonly name: string };
    readonly result: { readonly mode: string | null; readonly layer: string | null; readonly pending: string | null; readonly tools: string[] };
  };
  readonly 'session.compact': {
    readonly params: { readonly sessionId: string };
    readonly result: {
      readonly sessionId: string;
      readonly fromSeq?: number;
      readonly toSeq?: number;
      readonly tokensBefore?: number;
      readonly tokensAfter?: number;
      readonly [key: string]: unknown;
    };
  };
}

export type HostMethodName = keyof HostMethodMap;
export type HostMethodParamsOf<M extends HostMethodName> = HostMethodMap[M]['params'];
export type HostMethodResultOf<M extends HostMethodName> = HostMethodMap[M]['result'];

export type { SessionEvent, SessionHeader };
