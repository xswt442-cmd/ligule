import type { BrowserSupport } from '../capability/browser.js';
import type { ManagedProcessRegistry } from '../capability/managed-process.js';
import type { mcpServerConfigs, McpRegistry } from '../capability/mcp.js';
import type { DelegationSpec, RunValidation } from '../delegation.js';
import type { Assembly, Plugin } from '../kernel/assembly.js';
import type { PolicyRule } from '../kernel/config-edit.js';
import type { createConfigStore, LoadedLayers } from '../kernel/config-store.js';
import type { ConfigSnapshot } from '../kernel/config.js';
import type { ExtensionDiagnostic, loadExtensions } from '../kernel/extensions.js';
import type { Kernel } from '../kernel/kernel.js';
import type { LoggerBackend } from '../kernel/log.js';
import type { createLoop, LoopProgressEvent, LoopProgressPhase, LoopResult, LoopSteeringInbox } from '../kernel/loop.js';
import type { ModeDirectories, ModeFile } from '../kernel/modes.js';
import type { PermissionContext } from '../kernel/permission.js';
import type { DecisionChain, PolicyMode, PolicyThresholds } from '../kernel/policy.js';
import type { RequestDiagnosticStore } from '../kernel/request-diagnostics.js';
import type { ReviewEvidence } from '../kernel/reviewer.js';
import type { RunSteeringInbox } from '../kernel/run-steering.js';
import type { SkillRegistry } from '../kernel/skills.js';
import type { TaskBudget } from '../kernel/task-budget.js';
import type { TelemetryOptions } from '../kernel/telemetry.js';
import type { TemplateRegistry } from '../kernel/templates.js';
import type { createCompaction } from '../session/compaction.js';
import type { FileChangeStore } from '../session/file-changes.js';
import type { SessionEvent } from '../session/format.js';
import type { RunAcceptance } from '../session/run.js';
import type { SessionLog } from '../session/session.js';
import type { CustomToolDiagnostic } from '../tools/custom.js';
import type { SubagentRuntime } from '../tools/subagent.js';
import type { TRUSTED_AGENT_CONTROL_ORIGIN } from './agent-control-runtime.js';
import type { DelegationGrant } from './agent-control.js';
import type { Connection, HostRequest } from './connection.js';
import type { HostGenerationOptions, HostProvider } from './provider.js';
import type { SessionReviewer } from './reviewer.js';
import type { SearchStatus } from './search.js';
import type { SessionModeState } from './session-mode.js';

export interface HostConfigSnapshot extends ConfigSnapshot {
  readonly boundary?: string;
  readonly workspaceRoot?: string;
  readonly exec?: { readonly shell?: unknown };
  readonly model?: Record<string, unknown>;
  readonly loop?: Record<string, unknown>;
  readonly limits?: Record<string, unknown>;
  readonly policy?: Record<string, unknown>;
  readonly telemetry?: Record<string, unknown>;
  readonly prompt?: { readonly static?: string };
  readonly instructions?: Record<string, unknown> & { readonly maxBytes?: number; readonly current?: string };
}

export interface PolicyConfig {
  readonly mode?: PolicyMode;
  readonly rules?: PolicyRule[];
  readonly thresholds?: PolicyThresholds;
}

interface HostExtensions {
  readonly paths: string[];
  readonly ignored: ExtensionDiagnostic[];
  readonly installedDirectory?: string;
  // 安装路径（归一后）到安装名的映射；目录包用目录名，单文件用文件主名。
  readonly installNames?: Record<string, string>;
  // 安装目录中已被启停登记停用的扩展；配置层显式声明的路径不在此列。
  readonly disabled?: { name: string; path: string }[];
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

export interface ProjectEnvironment extends Omit<EnvironmentSeed, 'layers' | 'store' | 'extensions' | 'config' | 'provider' | 'policy'> {
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
  browserSupport?: Promise<BrowserSupport>;
}

export interface HostOptions {
  readonly config: HostConfigSnapshot;
  readonly provider: HostProvider;
  readonly plugins?: readonly Plugin<Kernel>[];
  readonly policy?: PolicyConfig;
  readonly logger?: LoggerBackend;
  readonly telemetry?: TelemetryOptions;
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
  readonly screenCaptureConsent?: boolean;
  readonly agentControl?: {
    readonly grantId: string;
    readonly storePath: string;
    readonly operator: boolean;
    validate(): Promise<DelegationGrant>;
  };
}

export interface RuntimeConfig extends HostConfigSnapshot {
  readonly boundary: string;
  readonly workspaceRoot: string;
}

export interface SessionGeneration {
  readonly provider: HostProvider;
  readonly model: Record<string, unknown>;
  readonly explicit?: boolean;
  readonly options: HostGenerationOptions;
}

export interface InitialSessionSettings {
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

export interface AdoptionResult {
  readonly applies: { sessionId: string; when: 'now' | 'round' }[];
  readonly failure?: { code: string; detail?: string };
}

export interface HostSessionBase {
  taskBudget?: TaskBudget;
  lastTask?: ReturnType<TaskBudget['snapshot']>;
  /** 复审装配用的可信证据快照（带事件 seq），不参与主 Agent 投影；读取失败时清空并转人工。 */
  reviewEvidence?: ReviewEvidence;
  reviewer?: SessionReviewer;
  activeRunId?: string;
  runSteering?: RunSteeringInbox;
  runInputRevisions?: Map<string, number>;
  subagents?: SubagentRuntime;
  readonly id: string;
  readonly search: SearchStatus;
  readonly browser: BrowserSupport;
  browserPaused: boolean;
  readonly childMcp: Map<McpRegistry, string>;
  readonly session: SessionLog;
  readonly listeners: ((event: SessionEvent) => void)[];
  readonly asks: Set<PendingRunAsk>;
  readonly asksByRun: Map<string, Set<PendingRunAsk>>;
  readonly requestDiagnostics: RequestDiagnosticStore;
  readonly mcpTrust: Map<string, { readonly source: 'trusted-ui'; readonly trusted: boolean; readonly updatedAt: string }>;
  sessionPolicyRules: PolicyRule[];
  operationOnly?: boolean;
  operationId?: string;
  operationSourceSessionId?: string;
  operationRevoked?: boolean;
  operationFinished?: boolean;
  readonly environment: ProjectEnvironment;
  readonly managedProcesses: ManagedProcessRegistry;
  readonly fileChanges: FileChangeStore;
  readonly managedGrantId?: string;
  permission: PermissionContext;
  readonly screenCapture: { enabled: boolean; source: 'none' | 'startup' | 'trusted-ui' | 'grant'; controller: AbortController };
  policyOverride: PolicyMode | null;
  readonly mode: SessionModeState;
  loopIterations: number;
  readonly loopModelCalls: number;
  readonly loopMaxParallelTools: number;
  pendingLoopIterations?: number;
  generation: SessionGeneration;
  modelCredentialBindings?: Record<string, unknown>;
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

export interface PendingRunAsk {
  readonly requestId: string;
  readonly settle: () => void;
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

export type HostProgressSnapshot = HostRunProgress & { readonly task?: ReturnType<TaskBudget['snapshot']> };

export interface HostSessionState extends HostSessionBase {
  readonly chain: DecisionChain;
  readonly kernel: Kernel;
  readonly assembly: Assembly;
  readonly mcp: McpRegistry;
  readonly extensions: Awaited<ReturnType<typeof loadExtensions>>;
  readonly customToolDiagnostics: CustomToolDiagnostic[];
  readonly customToolNames: string[];
  readonly templates: TemplateRegistry;
  readonly loop: ReturnType<typeof createLoop>;
  readonly subagents: SubagentRuntime;
  readonly runDelegated: (input: string, options: DelegatedRunOptions) => Promise<DelegatedRunResult>;
  compaction: ReturnType<typeof createCompaction> | null;
  readonly rebuildCompaction: (model: Record<string, unknown>) => ReturnType<typeof createCompaction> | null;
}

interface DelegatedRunOptions {
  readonly signal?: AbortSignal;
  readonly source?: 'human' | 'controller';
  readonly user?: Record<string, unknown>;
  readonly onProgress?: (event: LoopProgressEvent) => void;
  readonly delegation?: DelegationSpec;
  readonly acceptance?: RunAcceptance;
  readonly onAccepted?: (userSeq: number) => void;
  readonly steering?: LoopSteeringInbox;
}

export interface DelegatedRunResult extends LoopResult {
  readonly runId?: string;
  readonly structured?: unknown;
  readonly validation?: RunValidation;
}

export interface Host {
  handle(message: Pick<HostRequest, 'method' | 'params'>, connection: HostClientConnection): Promise<unknown>;
  release(): Promise<void>;
}

export type HostClientConnection = Pick<Connection, 'notify' | 'request'> & {
  readonly [TRUSTED_AGENT_CONTROL_ORIGIN]?: true;
};
