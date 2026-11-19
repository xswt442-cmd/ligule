// `subagent` 将任务交给独立的派生执行；一个父轮次最多并行运行三个子任务。
//
// 派生执行在同一进程中运行独立循环，使用新的 Kernel 和会话记录，并继承父会话的提供方与配置。
// 它沿用父会话的权限判定、不能递归启动其他子 Agent，且拥有独立记录以便恢复。
//
// 该工具通过插件注册，不属于 Kernel 内置能力。每个父会话最多同时运行三个派生任务。
import { randomUUID } from 'node:crypto';
import { resolveSubagentSpec, type AgentPresetPreview, type PreparedSubagentRun, type SubagentCallContext, type SubagentProvider, type SubagentRunArguments } from './subagent-spec.js';
import { opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { createKernel, type Kernel } from '../kernel/kernel.js';
import type { ExecController } from '../capability/exec.js';
import type { FiniteCommandRegistry } from '../capability/finite-command.js';
import { createManagedProcessRegistry, managedProcessPlugin } from '../capability/managed-process.js';
import type { FileWriteQueue } from '../kernel/file-write-queue.js';
import { createLoop, type LoopLimits, type LoopProgressEvent } from '../kernel/loop.js';
import { createPromptAssembly } from '../kernel/prompt.js';
import type { SessionLog } from '../session/session.js';
import { publishRunResult } from '../session/run.js';
import { laterScopeChangesTouch, runEvidenceReferences } from '../session/run-evidence.js';
import { checkedCheckDeclaration, checkedCheckEvent } from '../session/checks.js';
import type { SessionEvent } from '../session/format.js';
import { beginChildRun, childRunDelegation } from './subagent-run.js';
import { readPersistedSubrun, referenceOf as subrunReferenceOf, SubrunRegistry, viewOf as viewSubrun, type SubrunRecord } from './subrun-store.js';
import type { RunSteeringInbox } from '../kernel/run-steering.js';
import { currentKernelExecutionContext } from '../kernel/execution-context.js';
import type { RequestDiagnostic } from '../kernel/request-diagnostics.js';
import { isTrusted } from '../kernel/workspace-trust.js';
import { workspaceIdentity } from '../kernel/workspace.js';
import { completeExtensionRun, prepareExtensionRequest, type ExtensionHookRegistry } from '../kernel/extensions.js';
import {
  assertDelegationCompletion, completedRunResult, DELEGATION_RESULT_TOOL, failedRunResult,
  MAX_DELEGATION_SCHEMA_BYTES, structuredOutputDigest,
  MODE_SELECTION_SCHEMA, outputSchemaInstructions, registerDelegationResultTool,
} from '../delegation.js';
import {
  applyModeToPrompt,
  type ModeDirectories, type ModeFile, type ModePromptFragment,
} from '../kernel/modes.js';
import { createConfig } from '../kernel/config.js';
import { createDecisionChain } from '../kernel/policy.js';
import { createLogger } from '../kernel/log.js';
import { loadAssembly, type Plugin } from '../kernel/assembly.js';
import { KernelError, KernelRuntimeError } from '../kernel/error.js';
import { runSummary } from '../kernel/run-summary.js';
import type { TaskBudget } from '../kernel/task-budget.js';
import { createTodoWritePlugin } from './todo-write.js';
import { createReadImagePlugin } from './read-image.js';
import { createReadDocumentPlugin } from './read-document.js';
import { createPresentPlugin } from './present.js';
import { createScreenshotPlugin } from './screenshot.js';
import { createMediaStore, type MediaStore } from '../capability/media.js';
import { boundaryOf } from '../capability/limits.js';
import type { Telemetry } from '../kernel/telemetry.js';
import type { RunResult } from '../delegation.js';
import {
  listAgentPresets,
  type AgentPresetDirectories, type AgentPresetPage,
} from '../kernel/agent-presets.js';

const DEFAULT_CONCURRENT_SUBAGENTS = 3;
const MAX_CONCURRENT_SUBAGENTS = 8;

function stableErrorCode(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  return typeof code === 'string' && /^[a-z][a-z0-9_]{0,79}$/u.test(code) ? code : 'subagent_failed';
}

export interface SubagentDeps {
  readonly fileWriteQueue?: FileWriteQueue;
  readonly taskBudget?: () => TaskBudget | undefined;
  readonly finiteCommands?: FiniteCommandRegistry;
  readonly createExecController?: (sessionId: string, session: SessionLog) => ExecController;
  readonly createMcp?: (id: string, media: MediaStore) => Promise<{ plugin: Parameters<typeof loadAssembly>[1][number]; close(): Promise<void> }>;
  readonly authorizeScreenCapture?: () => Promise<AbortSignal>;
  config: ReturnType<typeof createConfig>;
  provider: SubagentProvider;
  chain: ReturnType<typeof createDecisionChain>;
  prompt: { staticPrefix: string };
  directory: string;
  sessionId: string;
  logger?: Parameters<typeof createLogger>[0];
  plugins: Parameters<typeof loadAssembly>[1];
  /** Custom user tools inherit into the child after its built-ins have registered. */
  customToolPlugin?: Plugin<Kernel>;
  modePaths?: ModeDirectories;
  presetDirectories?: AgentPresetDirectories;
  modeFile?: () => ModeFile | undefined;
  promptFragments?: () => readonly ModePromptFragment[];
  promptFragmentBytes?: number;
  loopLimits?: LoopLimits;
  telemetry?: Telemetry;
  requestDiagnosticsEnabled?: () => boolean;
  onRequestDiagnostic?: (diagnostic: RequestDiagnostic) => void;
  onSubrunMessageAccepted?: (runId: string) => void;
  parentSession?: SessionLog;
  extensionHooks?: () => ExtensionHookRegistry | undefined;
}

export interface SubrunReference {
  readonly subrunId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly parentRunId?: string;
  readonly parentCallId?: string;
}

export interface SubrunStatus extends SubrunReference {
  readonly state: 'starting' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';
  readonly phase: string | null;
  readonly task: ReturnType<TaskBudget['snapshot']> | null;
  readonly pendingInteractions: { readonly approvals: number; readonly questions: number };
  readonly errorCode?: string;
  readonly result?: { readonly state: string; readonly textCharacters: number; readonly validation?: unknown };
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly completedAt?: number;
}

export interface SubagentRuntime {
  readonly name: string;
  setup(kernel: { register(tool: unknown): () => void; manifest(): readonly { readonly name: string }[] }): () => void;
  start(args: SubagentRunArguments, context: SubagentCallContext, source?: 'human' | 'controller'): Promise<SubrunReference>;
  listPresets(options?: { readonly cursor?: string; readonly limit?: number }): Promise<AgentPresetPage>;
  previewPreset(presetId: string, overrides: Omit<SubagentRunArguments, 'task' | 'presetId'>, context: SubagentCallContext): Promise<AgentPresetPreview>;
  list(parentRunId: string, options?: { readonly cursor?: string; readonly limit?: number }): Promise<{
    readonly subruns: readonly SubrunStatus[];
    readonly nextCursor?: string;
    readonly truncated: boolean;
  }>;
  status(subrunId: string, parentRunId: string): Promise<SubrunStatus>;
  message(args: { readonly subrunId: string; readonly runId: string; readonly parentRunId: string; readonly input: string }, source: 'human' | 'controller', onAccepted?: () => void): Promise<{
    readonly inputId: string;
    readonly runId: string;
    readonly state: 'accepted';
    readonly source: 'human' | 'controller';
    readonly pendingCount: number;
    readonly subrunId: string;
  }>;
  wait(subrunIds: readonly string[], parentRunId: string, timeoutMs: number): Promise<{
    readonly subruns: readonly SubrunStatus[];
    readonly timedOut: boolean;
  }>;
  waitForResult(subrunId: string, parentRunId?: string): Promise<unknown>;
  cancel(args: { readonly subrunId: string; readonly runId: string; readonly parentRunId: string }): Promise<{
    readonly subrunId: string;
    readonly runId: string;
    readonly cancelRequested: boolean;
    readonly state: SubrunStatus['state'];
  }>;
  settleParent(parentRunId: string, status: 'completed' | 'failed' | 'cancelled'): Promise<void>;
  beginCompletionCandidate(parentRunId: string): void;
  resumeParent(parentRunId: string): void;
  finishParent(parentRunId: string): Promise<void>;
  close(): Promise<void>;
  interaction(runId: string, type: 'approval' | 'question', waiting: boolean): void;
}

interface ChildRunStarted extends SubrunReference {
  readonly path: string;
  readonly inbox: RunSteeringInbox;
  readonly session: SessionLog;
}

interface ChildRunLifecycle {
  readonly subrunId: string;
  readonly sessionId: string;
  readonly source: 'human' | 'controller';
  readonly prepared?: PreparedSubagentRun;
  readonly onStarted: (child: ChildRunStarted) => void;
  readonly onContextPersisted?: () => void;
  readonly onProgress: (event: LoopProgressEvent) => void;
}

function deferred<TResult>() {
  let resolve!: (value: TResult) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<TResult>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function requiredCheckFailures(events: readonly SessionEvent[], runId: string, required: readonly string[]): { name: string; reason: string }[] {
  const latestByName = new Map<string, { readonly callId: string; readonly seq: number }>();
  const checkByCall = new Map<string, { readonly event: SessionEvent; readonly check: NonNullable<ReturnType<typeof checkedCheckEvent>> }>();
  for (const event of events) {
    if (event.kind === 'tool' && event.runId === runId && event.tool === 'exec'
      && typeof event.callId === 'string' && typeof event.args === 'object' && event.args !== null && !Array.isArray(event.args)) {
      const declaration = checkedCheckDeclaration((event.args as Record<string, unknown>).check);
      if (declaration !== undefined && typeof event.seq === 'number') latestByName.set(declaration.name, { callId: event.callId, seq: event.seq });
    }
    if (event.kind === 'check' && event.runId === runId && typeof event.callId === 'string') {
      const check = checkedCheckEvent(event);
      if (check !== undefined) checkByCall.set(check.callId, { event, check });
    }
  }
  const failures: { name: string; reason: string }[] = [];
  for (const name of required) {
    const latest = latestByName.get(name);
    const recorded = latest === undefined ? undefined : checkByCall.get(latest.callId);
    const check = recorded?.check;
    const checkSeq = recorded?.event.seq;
    const knownChangeAfter = check !== undefined && checkSeq !== undefined
      && laterScopeChangesTouch(events, runId, check, checkSeq);
    const complete = check !== undefined
      && check.commandStatus === 'met'
      && check.reportStatus === 'reported_pass'
      && check.report !== undefined && check.report.passed > 0 && check.report.failed === 0
      && check.logStatus === 'complete'
      && check.scopeStatus === 'sampled'
      && !knownChangeAfter;
    if (!complete) {
      const reason = latest === undefined ? 'not_run' : check === undefined ? 'result_unavailable'
        : knownChangeAfter || check.scopeStatus === 'stale' ? 'scope_stale'
          : check.reportStatus === 'zero_tests' || check.report?.passed === 0 ? 'no_tests_passed'
            : check.reportStatus !== 'reported_pass' || (check.report?.failed ?? 0) > 0 ? 'report_not_passing'
              : check.commandStatus !== 'met' ? 'command_not_met'
                : check.logStatus !== 'complete' ? 'log_incomplete'
                  : check.scopeStatus !== 'sampled' ? 'scope_unverified' : 'result_unavailable';
      failures.push({ name, reason });
    }
  }
  return failures;
}

export function createSubagentPlugin(deps: SubagentDeps): SubagentRuntime {
  const loopConfig = typeof deps.config.loop === 'object' && deps.config.loop !== null && !Array.isArray(deps.config.loop)
    ? deps.config.loop as Record<string, unknown> : {};
  const concurrency = loopConfig.maxConcurrentSubagents ?? DEFAULT_CONCURRENT_SUBAGENTS;
  if (typeof concurrency !== 'number' || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENT_SUBAGENTS) {
    throw new KernelError('subagent_concurrency_invalid', { detail: `loop.maxConcurrentSubagents must be an integer between 1 and ${MAX_CONCURRENT_SUBAGENTS}` });
  }
  const maxConcurrentSubagents = concurrency as number;
  let closed = false;
  let active = 0;
  const registry = new SubrunRegistry(deps.directory, deps.sessionId);
  const configRoot = typeof deps.config.workspaceRoot === 'string' ? deps.config.workspaceRoot
    : typeof deps.config.boundary === 'string' ? deps.config.boundary : process.cwd();
  const viewOf = (record: SubrunRecord): SubrunStatus =>
    viewSubrun(record, deps.taskBudget?.()?.snapshot() ?? null);
  const persistedChild = async (subrunId: string, parentRunId: string) => await readPersistedSubrun({
    directory: deps.directory,
    parentSessionId: deps.sessionId,
    parentSession: deps.parentSession,
    configRoot,
    subrunId,
    parentRunId,
  });
  const persistedStatus = async (subrunId: string, parentRunId: string) =>
    (await persistedChild(subrunId, parentRunId)).status;
  const closedParents = new Set<string>();
  let parentKernel: { manifest(): readonly { readonly name: string }[]; selectable(): readonly string[] } | undefined;
  let executeSubagent: ((args: SubagentRunArguments, context: SubagentCallContext, lifecycle?: ChildRunLifecycle) => Promise<Record<string, unknown>>) | undefined;

  async function prepareRun(args: SubagentRunArguments, context: SubagentCallContext, requireTask: boolean): Promise<PreparedSubagentRun> {
    return await resolveSubagentSpec({
      deps: {
        ...(deps.loopLimits === undefined ? {} : { loopLimits: deps.loopLimits }),
        ...(deps.modePaths === undefined ? {} : { modePaths: deps.modePaths }),
        ...(deps.presetDirectories === undefined ? {} : { presetDirectories: deps.presetDirectories }),
        ...(deps.modeFile === undefined ? {} : { modeFile: deps.modeFile }),
        ...(deps.promptFragments === undefined ? {} : { promptFragments: deps.promptFragments }),
        provider: deps.provider,
      },
      parentKernel: () => parentKernel,
      parentClosed: (runId) => closedParents.has(runId),
    }, args, context, requireTask);
  }

  async function listPresets(options: { readonly cursor?: string; readonly limit?: number } = {}): Promise<AgentPresetPage> {
    if (deps.presetDirectories === undefined) throw new KernelError('agent_preset_unavailable');
    return await listAgentPresets(deps.presetDirectories, options);
  }

  async function previewPreset(
    presetId: string,
    overrides: Omit<SubagentRunArguments, 'task' | 'presetId'>,
    context: SubagentCallContext,
  ): Promise<AgentPresetPreview> {
    const prepared = await prepareRun({ ...overrides, presetId }, context, false);
    if (prepared.preview === undefined) throw new KernelError('agent_preset_preview_unavailable');
    return prepared.preview;
  }

  async function start(args: SubagentRunArguments, context: SubagentCallContext, source: 'human' | 'controller' = 'controller'):
    Promise<SubrunReference> {
    if (closed) throw new KernelError('subagent_host_closed');
    if (typeof args.task !== 'string' || args.task.trim() === '') throw new KernelError('subagent_task_required');
    if (context.runId !== undefined && closedParents.has(context.runId)) throw new KernelError('subagent_parent_not_active');
    const execute = executeSubagent;
    if (execute === undefined) throw new KernelError('subagent_runtime_unavailable');
    if (active >= maxConcurrentSubagents) throw new KernelError('subagent_concurrency_limit');
    const prepared = await prepareRun(args, context, true);
    if (closed || (context.runId !== undefined && closedParents.has(context.runId))) {
      throw new KernelError(closed ? 'subagent_host_closed' : 'subagent_parent_not_active');
    }
    const sessionId = await registry.nextSessionId();
    if (closed) throw new KernelError('subagent_host_closed');
    if (context.runId !== undefined && closedParents.has(context.runId)) throw new KernelError('subagent_parent_not_active');
    registry.prune();
    const controller = new AbortController();
    const parentSignal = context.signal;
    const abortParent = () => controller.abort(parentSignal?.reason);
    if (parentSignal?.aborted) abortParent();
    else parentSignal?.addEventListener('abort', abortParent, { once: true });
    const ready = deferred<SubrunReference>();
    // The stable control ID is also the durable child Session ID, so a new Host can
    // resolve it without an in-memory index or a second Session store.
    const subrunId = sessionId;
    const record: SubrunRecord = {
      subrunId,
      ...(context.runId === undefined ? {} : { parentRunId: context.runId }),
      ...(context.callId === undefined ? {} : { parentCallId: context.callId }),
      controller,
      state: 'starting',
      phase: 'preparing',
      pendingApprovals: 0,
      pendingQuestions: 0,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };
    registry.add(record);
    let started = false;
    let referenceReady = false;
    const work = Promise.resolve().then(() => execute(prepared.args, { ...context, permission: prepared.permission, signal: controller.signal }, {
      subrunId,
      sessionId,
      source,
      prepared,
      onStarted: (child) => {
        record.sessionId = child.sessionId;
        record.runId = child.runId;
        record.path = child.path;
        record.inbox = child.inbox;
        record.state = 'running';
        record.phase = 'preparing';
        record.updatedAt = Date.now();
        started = true;
        if (prepared.preset === undefined) {
          referenceReady = true;
          ready.resolve(subrunReferenceOf(record));
        }
      },
      ...(prepared.preset === undefined ? {} : {
        onContextPersisted: () => {
          referenceReady = true;
          ready.resolve(subrunReferenceOf(record));
        },
      }),
      onProgress: (event) => {
        record.phase = event.kind === 'phase' ? event.phase : event.phase;
        record.updatedAt = Date.now();
      },
    }));
    record.work = work.then((result) => {
      record.result = result;
      const nested = typeof result.result === 'object' && result.result !== null ? result.result as Record<string, unknown> : undefined;
      const resultState = nested?.state;
      record.state = resultState === 'completed' ? 'completed' : resultState === 'cancelled' ? 'cancelled' : 'failed';
      const diagnostic = typeof nested?.diagnostic === 'object' && nested.diagnostic !== null
        ? nested.diagnostic as Record<string, unknown> : undefined;
      if (typeof diagnostic?.code === 'string') record.errorCode = diagnostic.code;
      else if (record.state === 'failed' && typeof nested?.code === 'string') record.errorCode = nested.code;
      record.updatedAt = Date.now();
      record.completedAt = record.updatedAt;
      if (!referenceReady) ready.reject(new KernelError(record.errorCode ?? (started ? 'agent_preset_snapshot_unavailable' : 'subagent_failed')));
      return result;
    }, (error: unknown) => {
      record.state = controller.signal.aborted ? 'cancelled' : 'failed';
      record.errorCode = stableErrorCode(error);
      record.updatedAt = Date.now();
      record.completedAt = record.updatedAt;
      if (!referenceReady) ready.reject(error);
      throw error;
    }).finally(() => parentSignal?.removeEventListener('abort', abortParent));
    void record.work.catch(() => undefined);
    try { return await ready.promise; }
    catch (error) {
      registry.delete(subrunId);
      throw error;
    }
  }

  async function list(parentRunId: string, options: { readonly cursor?: string; readonly limit?: number } = {}) {
    const limit = options.limit ?? 32;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32) throw new KernelError('subagent_list_limit_invalid');
    let after: string | undefined;
    if (options.cursor !== undefined) {
      if (options.cursor.length > 256 || !/^[A-Za-z0-9_-]+$/u.test(options.cursor)) throw new KernelError('subagent_list_cursor_invalid');
      const decoded = Buffer.from(options.cursor, 'base64url').toString('utf8');
      if (!/^v1:[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u.test(decoded)) throw new KernelError('subagent_list_cursor_invalid');
      after = decoded.slice(3);
    }
    const prefix = `${deps.sessionId}.sub-`;
    if (after !== undefined && (!after.startsWith(prefix) || !/^\d+$/u.test(after.slice(prefix.length)))) {
      throw new KernelError('subagent_list_cursor_invalid');
    }
    const persistedNames: string[] = [];
    let directoryEntries = 0;
    let directoryTruncated = false;
    let directory;
    try { directory = await opendir(deps.directory); }
    catch (cause) { throw new KernelError('subagent_session_directory_read_failed', { cause }); }
    try {
      for await (const entry of directory) {
        directoryEntries += 1;
        if (directoryEntries > 4_096) { directoryTruncated = true; break; }
        if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith('.jsonl')) continue;
        const id = entry.name.slice(0, -'.jsonl'.length);
        if (/^\d+$/u.test(id.slice(prefix.length))) persistedNames.push(id);
      }
    } finally { await directory.close().catch(() => undefined); }
    const persisted = persistedNames.sort((left, right) => Number(left.slice(prefix.length)) - Number(right.slice(prefix.length)));
    const scanLimit = 256;
    const scanned = persisted.slice(0, scanLimit);
    const truncated = directoryTruncated || persisted.length > scanned.length;
    const ids = new Set(scanned);
    for (const record of registry.values()) {
      if (record.parentRunId === parentRunId && record.runId !== undefined) ids.add(record.subrunId);
    }
    const afterNumber = after === undefined ? undefined : Number(after.slice(prefix.length));
    const ordered = [...ids].filter(id => afterNumber === undefined || Number(id.slice(prefix.length)) > afterNumber)
      .sort((left, right) => Number(left.slice(prefix.length)) - Number(right.slice(prefix.length)));
    const pageIds = ordered.slice(0, limit);
    const items = await Promise.all(pageIds.map(async id => {
      try { return await status(id, parentRunId); }
      catch (error) {
        if (error instanceof KernelError && error.code === 'subagent_not_found') return undefined;
        throw error;
      }
    }));
    const visible = items.filter((item): item is SubrunStatus => item !== undefined);
    const last = pageIds.at(-1);
    const hasMore = ordered.length > pageIds.length;
    return {
      subruns: visible,
      ...(hasMore && last !== undefined ? { nextCursor: Buffer.from(`v1:${last}`).toString('base64url') } : {}),
      truncated: truncated || hasMore,
    };
  }

  async function status(subrunId: string, parentRunId: string): Promise<SubrunStatus> {
    const record = registry.get(subrunId);
    if (record === undefined) return await persistedStatus(subrunId, parentRunId);
    if (record.parentRunId !== parentRunId) throw new KernelError('subagent_not_found');
    return viewOf(record);
  }

  async function message({ subrunId, runId, parentRunId, input }: {
    subrunId: string; runId: string; parentRunId: string; input: string;
  }, source: 'human' | 'controller', onAccepted?: () => void) {
    const record = registry.find(subrunId, parentRunId);
    if (record.state !== 'running' || record.runId !== runId || record.inbox === undefined) {
      throw new KernelError('subagent_not_running');
    }
    return { subrunId, ...await record.inbox.accept(source, input, onAccepted) };
  }

  async function wait(subrunIds: readonly string[], parentRunId: string, timeoutMs: number) {
    if (subrunIds.length < 1 || subrunIds.length > 8 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 30_000) {
      throw new KernelError('subagent_wait_invalid');
    }
    const records = subrunIds.map(id => registry.get(id)).filter((record): record is SubrunRecord => record !== undefined);
    for (const record of records) if (record.parentRunId !== parentRunId) throw new KernelError('subagent_not_found');
    const missing = subrunIds.filter(id => !registry.has(id));
    for (const id of missing) await persistedStatus(id, parentRunId);
    let timedOut = false;
    if (timeoutMs === 0) timedOut = records.some(record => record.state === 'starting' || record.state === 'running');
    else {
      const pending = Promise.allSettled(records.map(record => record.work ?? Promise.resolve(record.result ?? {})));
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          pending,
          new Promise<void>((resolve) => { timer = setTimeout(() => { timedOut = true; resolve(); }, timeoutMs); }),
        ]);
      } finally { if (timer !== undefined) clearTimeout(timer); }
    }
    return { subruns: await Promise.all(subrunIds.map(id => status(id, parentRunId))), timedOut };
  }

  async function waitForResult(subrunId: string, parentRunId?: string): Promise<unknown> {
    const record = registry.get(subrunId);
    if (record === undefined) {
      if (parentRunId === undefined) throw new KernelError('subagent_not_found');
      const persisted = await persistedChild(subrunId, parentRunId);
      if (persisted.status.state !== 'completed' || persisted.result === undefined
        || typeof persisted.result.output.text !== 'string'
        || !Number.isSafeInteger(persisted.result.usage.iterations)
        || !Number.isSafeInteger(persisted.result.usage.modelCalls)) {
        throw new KernelError(persisted.status.errorCode ?? 'run_result_unavailable');
      }
      const context = typeof persisted.turnContext === 'object' && persisted.turnContext !== null
        ? persisted.turnContext as Record<string, unknown> : {};
      const generation = typeof context.childGeneration === 'object' && context.childGeneration !== null
        ? context.childGeneration as Record<string, unknown> : undefined;
      const limits = typeof context.childLimits === 'object' && context.childLimits !== null
        ? context.childLimits as Record<string, unknown> : undefined;
      const mode = typeof context.mode === 'object' && context.mode !== null ? context.mode as Record<string, unknown> : undefined;
      return {
        text: persisted.result.output.text,
        sessionId: subrunId,
        path: join(deps.directory, `${subrunId}.jsonl`),
        iterations: persisted.result.usage.iterations,
        modelCalls: persisted.result.usage.modelCalls,
        ...(generation === undefined ? {} : { generation }),
        ...(limits === undefined ? {} : { limits }),
        ...(mode === undefined ? {} : { mode: mode.name ?? null, modeDigest: mode.digest ?? null }),
        result: persisted.result,
      };
    }
    if (record.parentRunId !== parentRunId) throw new KernelError('subagent_not_found');
    const resumeParent = deps.taskBudget?.()?.suspendCurrentWork();
    try { return await record.work ?? record.result ?? viewOf(record); }
    finally { resumeParent?.(); }
  }

  async function cancel({ subrunId, runId, parentRunId }: { subrunId: string; runId: string; parentRunId: string }) {
    const record = registry.find(subrunId, parentRunId);
    if (record.state !== 'running' || record.runId !== runId) {
      return { subrunId, runId, cancelRequested: false, state: record.state };
    }
    record.controller.abort(new KernelError('subagent_cancelled'));
    record.updatedAt = Date.now();
    return { subrunId, runId, cancelRequested: true, state: record.state };
  }

  async function settleParent(parentRunId: string, state: 'completed' | 'failed' | 'cancelled'): Promise<void> {
    if (state !== 'completed') closedParents.add(parentRunId);
    const records = [...registry.values()].filter(record => record.parentRunId === parentRunId
      && (record.state === 'starting' || record.state === 'running'));
    if (state !== 'completed') {
      for (const record of records) record.controller.abort(new KernelError('subagent_parent_cancelled'));
    }
    await Promise.all(records.map(record => record.work ?? Promise.resolve()));
  }

  function beginCompletionCandidate(parentRunId: string): void {
    if (closed) throw new KernelError('subagent_host_closed');
    closedParents.add(parentRunId);
  }

  function resumeParent(parentRunId: string): void {
    if (!closed) closedParents.delete(parentRunId);
  }

  async function finishParent(parentRunId: string): Promise<void> {
    closedParents.add(parentRunId);
    const records = [...registry.values()].filter(record => record.parentRunId === parentRunId
      && (record.state === 'starting' || record.state === 'running'));
    await Promise.all(records.map(record => record.work ?? Promise.resolve()));
  }

  async function close(): Promise<void> {
    closed = true;
    for (const record of registry.values()) {
      if (record.parentRunId !== undefined) closedParents.add(record.parentRunId);
      if (record.state === 'starting' || record.state === 'running') record.controller.abort(new KernelError('subagent_host_closed'));
    }
    await Promise.all([...registry.values()].flatMap(record => record.work === undefined ? [] : [record.work.catch(() => undefined)]));
  }

  function interaction(runId: string, type: 'approval' | 'question', waiting: boolean): void {
    const record = [...registry.values()].find(item => item.runId === runId);
    if (record === undefined) return;
    const field = type === 'approval' ? 'pendingApprovals' : 'pendingQuestions';
    record[field] = Math.max(0, record[field] + (waiting ? 1 : -1));
    record.updatedAt = Date.now();
  }

  return {
    name: 'ligule-subagent',
    setup(kernel: {
      register(tool: unknown): () => void;
      manifest(): readonly { readonly name: string }[];
      selectable(): string[];
    }) {
      parentKernel = kernel;
      const subagentTool = {
        name: 'subagent',
        access: 'inherit',
        execution: 'parallel',
        description: `Delegate independent work to child runs with the parent policy and separate session records. Optional presetId names a bounded task preset the user or controller already selected; explicit settings cannot widen its limits. Up to ${maxConcurrentSubagents} children can run at once; children cannot create more children. Check result.state because a failed or cancelled child still returns its saved Session reference. When outputSchema is provided, the child must submit its final value with ligule_delegation_result.`,
        parameters: {
          type: 'object',
          properties: {
            task: { type: 'string', description: 'What the derived agent should do, as one instruction.' },
            presetId: { type: 'string', minLength: 1, maxLength: 64, description: 'optional named Host-resolved child task preset' },
            mode: MODE_SELECTION_SCHEMA,
            outputTokens: { type: 'integer', minimum: 1, description: 'optional child output-token limit; it cannot exceed the parent session limit' },
            thinkingEffort: { type: 'string', enum: ['none', 'low', 'high', 'max'], description: 'optional child thinking effort; it cannot exceed the parent session setting' },
            loopIterations: { type: 'integer', minimum: 1, description: 'optional child iteration limit; it cannot exceed the parent session limit' },
            modelCalls: { type: 'integer', minimum: 1, description: 'optional child model-call limit; it cannot exceed the parent session limit' },
            outputSchema: { type: 'object', description: 'Optional supported JSON Schema for the child result. A valid value must be submitted with the child-only ligule_delegation_result tool.' },
          },
          additionalProperties: false,
          required: ['task'],
        },
        async run(args: SubagentRunArguments, { signal, permission, runId, executionId, callId }: SubagentCallContext,
          lifecycle?: ChildRunLifecycle): Promise<Record<string, unknown>> {
          if (typeof args.task !== 'string' || args.task.trim() === '') {
            throw new KernelError('subagent_task_required', { detail: 'the derived agent needs a task to work on' });
          }
          const prepared = lifecycle?.prepared ?? await prepareRun(args, { signal, permission, runId, executionId, callId }, true);
          args = prepared.args;
          const childTask = args.task;
          if (typeof childTask !== 'string' || childTask.trim() === '') throw new KernelError('subagent_task_required');
          const outputContract = prepared.outputContract;
          const limits = prepared.limits;
          const provider = prepared.provider;
          const childPermission = prepared.permission;
          if (active >= maxConcurrentSubagents) {
            throw new KernelError('subagent_concurrency_limit', { detail: `at most ${maxConcurrentSubagents} derived runs can be active for this parent` });
          }
          const parentTools = new Set(kernel.manifest().map(({ name }) => name));
          active += 1;
          try {
            const id = lifecycle?.sessionId ?? await registry.nextSessionId();
            const subrunId = lifecycle?.subrunId ?? id;
            // 首行在首次写入时生成；模式选择确定后再补入模式身份。
            let modeIdentity: {
              name: string;
              layer: string;
              source?: 'named' | 'inline';
              digest?: string;
              fileDigest?: string;
              tools?: string[];
              prompt?: string[];
            } | undefined;
            const source = lifecycle?.source ?? 'controller';
const { session, acceptance, steering } = beginChildRun({
  directory: deps.directory,
  sessionId: id,
  task: childTask,
  source,
  delegation: childRunDelegation(args, prepared, runId, callId),
  parentage: runId === undefined ? undefined : {
    sessionId: deps.sessionId, runId, subrunId,
    ...(callId === undefined ? {} : { callId }),
  },
  meta: () => ({
    projectRoot: typeof deps.config.workspaceRoot === 'string'
      ? deps.config.workspaceRoot
      : typeof deps.config.boundary === 'string' ? deps.config.boundary : undefined,
    mode: modeIdentity,
  }),
});
          let childRunResult: RunResult | undefined;
            let disposeAssembly: (() => void) | undefined;
            let closeMcp: (() => Promise<void>) | undefined;
            let closeManagedProcesses: (() => Promise<void>) | undefined;
            let disposeResultTool: (() => void) | undefined;
            let undoMode = () => {};
            let undoParentRestrictions = () => {};
            let undoOutputContract = () => {};
            let undoPresetInstruction = () => {};
            try {
              const child = createKernel({
                config: deps.config,
                fileWriteQueue: deps.fileWriteQueue,
                // 派生执行复用父会话的权限判定实例，包括拒绝次数与强制审批状态。
                policy: deps.chain,
                session,
                logger: deps.logger,
                permission: childPermission,
                extensionHooks: deps.extensionHooks,
                taskBudget: deps.taskBudget,
                ...(deps.createExecController === undefined ? {} : {
                  execController: () => deps.createExecController!(id, session),
                }),
              });
              // 派生执行继承父会话的插件工具，但不注册 `subagent`，从而禁止递归派生。
              const media = createMediaStore({ boundary: boundaryOf(deps.config),
                ...(typeof deps.config.workspaceRoot === 'string' ? { workspaceRoot: deps.config.workspaceRoot } : {}),
                ...(typeof deps.config.userHome === 'string' ? { userHome: deps.config.userHome } : {}),
              }, id);
              let recordedScreenConsent = false;
              const authorizeScreenCapture = deps.authorizeScreenCapture === undefined ? undefined : async () => {
                const signal = await deps.authorizeScreenCapture!();
                if (!recordedScreenConsent) {
                  await session.append({ kind: 'screenCapture', ignorable: true, enabled: true, source: 'parent', at: new Date().toISOString() });
                  recordedScreenConsent = true;
                }
                return signal;
              };
              const mcp = deps.createMcp === undefined ? undefined : await deps.createMcp(id, media);
              closeMcp = mcp === undefined ? undefined : () => mcp.close();
              const childRoot = typeof deps.config.workspaceRoot === 'string'
                ? deps.config.workspaceRoot : boundaryOf(deps.config);
              const managedProcesses = parentTools.has('managed_process')
                ? createManagedProcessRegistry({
                  validateWorkspaceTrust: async () => {
                    if (childPermission.workspaceTrusted && !(await isTrusted(childRoot))) {
                      throw new KernelError('exec_workspace_untrusted', { detail: 'workspace trust was revoked while a child process was running' });
                    }
                  },
                })
                : undefined;
              closeManagedProcesses = managedProcesses === undefined ? undefined : () => managedProcesses.close();
              const assembly = loadAssembly(child, [
                ...deps.plugins,
                ...(mcp === undefined ? [] : [mcp.plugin]),
                ...(managedProcesses === undefined ? [] : [managedProcessPlugin(managedProcesses)]),
                ...(parentTools.has('todo_write') ? [createTodoWritePlugin({ session })] : []),
                ...(parentTools.has('read_image') ? [createReadImagePlugin({ media, supportsImages: () => provider.imageInput === true })] : []),
                ...(parentTools.has('read_document') ? [createReadDocumentPlugin({ media, supportsImages: () => provider.imageInput === true })] : []),
                ...(parentTools.has('present') || parentTools.has('open_resource') ? [createPresentPlugin({ sessionId: id,
                  workspaceRoot: typeof deps.config.workspaceRoot === 'string' ? deps.config.workspaceRoot : boundaryOf(deps.config), session })] : []),
                ...(parentTools.has('screenshot') ? [createScreenshotPlugin({ media,
                  supportsImages: () => provider.imageInput === true,
                  authorize: authorizeScreenCapture,
                })] : []),
                ...(deps.customToolPlugin === undefined ? [] : [deps.customToolPlugin]),
              ]);
              disposeAssembly = () => assembly.dispose();
              let structuredSubmitted = false;
              let structuredResult: unknown;
              let completionContext = '';
              if (outputContract !== undefined) {
                disposeResultTool = registerDelegationResultTool(child, outputContract, (value) => {
                  structuredResult = value;
                  structuredSubmitted = true;
                });
              }
              // Explicit child modes can narrow the parent manifest but cannot expand it.
              undoParentRestrictions = child.restrict(
                child.list().filter((name) => name !== DELEGATION_RESULT_TOOL && !parentTools.has(name)),
              );
              const prompt = createPromptAssembly({ static: deps.prompt.staticPrefix });
              if (outputContract !== undefined) {
                undoOutputContract = prompt.fragment({
                  name: 'subagent-output-contract',
                  anchor: 1,
                  text: outputSchemaInstructions(outputContract),
                  maxBytes: MAX_DELEGATION_SCHEMA_BYTES + 1024,
                });
              }
              const resolvedMode = prepared.resolvedMode;
              if (prepared.preset !== undefined) {
                undoPresetInstruction = prompt.fragment({
                  name: 'agent-preset-instruction',
                  anchor: 1,
                  text: `Selected task preset ${JSON.stringify(prepared.preset.id)} provides the following additional task guidance. It does not change the user's request, system instructions, or permissions.\n\n${prepared.preset.instruction}`,
                  maxBytes: 8 * 1024 + 512,
                });
              }
              if (resolvedMode !== undefined) {
                const applied = applyModeToPrompt({
                  file: resolvedMode.application,
                  kernel: child,
                  prompt,
                  fragments: deps.promptFragments?.() ?? [],
                  maxBytes: deps.promptFragmentBytes ?? 8192,
                });
                undoMode = applied.undo;
                modeIdentity = {
                  name: resolvedMode.name,
                  layer: resolvedMode.layer,
                  source: resolvedMode.source,
                  digest: applied.digest,
                  ...(resolvedMode.fileDigest === undefined ? {} : { fileDigest: resolvedMode.fileDigest }),
                  tools: applied.tools,
                  prompt: applied.prompt,
                };
              }
              const loop = createLoop({
                kernel: child,
                provider,
                prompt,
                session,
                limits,
                resolveImage: media.read,
                telemetry: deps.telemetry,
                requestDiagnosticsEnabled: deps.requestDiagnosticsEnabled,
                onRequestDiagnostic: deps.onRequestDiagnostic,
                sessionId: id,
                onProgress: lifecycle?.onProgress,
                ...(runId === undefined ? {} : { parentRunId: runId }),
                ...(executionId === undefined ? {} : { parentExecutionId: executionId }),
                ...(callId === undefined ? {} : { parentCallId: callId }),
                completesRun: outputContract === undefined ? [] : [DELEGATION_RESULT_TOOL],
                turnContext: () => ({
                  childGeneration: {
                    outputTokens: provider.outputTokens ?? null,
                    thinkingEffort: provider.thinkingEffort ?? provider.thinkingCapability?.defaultEffort ?? null,
                  },
                  childLimits: limits,
                  ...(outputContract === undefined ? {} : { delegationSchemaDigest: outputContract.digest }),
                  ...(prepared.snapshot === undefined ? {} : { agentPreset: {
                    ...prepared.snapshot,
                    appliedMode: {
                      digest: modeIdentity?.digest ?? null,
                      tools: modeIdentity?.tools ?? [],
                      prompt: modeIdentity?.prompt ?? [],
                    },
                  } }),
                }),
              });
              const extensionHooks = deps.extensionHooks?.();
              let result: Awaited<ReturnType<typeof loop.run>>;
              try {
                result = await loop.run(childTask, {
                  signal,
                  task: deps.taskBudget?.(),
                  runId: acceptance.runId,
                  source,
                  prepareRequest: async (context) => {
                    return extensionHooks === undefined ? undefined : await prepareExtensionRequest(extensionHooks, context,
                      deps.promptFragmentBytes ?? 8192, deps.taskBudget?.());
                  },
                  completeRun: async (candidate) => {
                    const requiredChecks = prepared.preset?.requiredChecks ?? [];
                    if (requiredChecks.length > 0) {
                      const failures = requiredCheckFailures(await session.read(), acceptance.runId, requiredChecks);
                      if (failures.length > 0) {
                        const context = `Required checks remain incomplete: ${failures.map(item => `${item.name} (${item.reason})`).join(', ')}. Run each named check through the existing finite check tool and wait for a passing report with complete logs and a sampled unchanged scope.`;
                        completionContext = context;
                        return { decision: 'continue' as const, context };
                      }
                    }
                    if (extensionHooks === undefined || extensionHooks.forPhase('completeRun').length === 0) return;
                    const candidateContext = candidate;
                    if (candidateContext.userSeq === undefined) throw new KernelError('extension_hook_run_context_unavailable');
                    const completion = await completeExtensionRun(extensionHooks, {
                        sessionId: id,
                        runId: acceptance.runId,
                        source,
                        signal: candidateContext.signal,
                        callId: candidateContext.callId,
                        ...(candidateContext.parentCallId === undefined ? {} : { parentCallId: candidateContext.parentCallId }),
                        ...(candidateContext.parentRunId === undefined ? {} : { parentRunId: candidateContext.parentRunId }),
                        ...(candidateContext.executionId === undefined ? {} : { executionId: candidateContext.executionId }),
                        ...(candidateContext.parentExecutionId === undefined ? {} : { parentExecutionId: candidateContext.parentExecutionId }),
                        userSeq: candidateContext.userSeq,
                        candidate: candidateContext.candidate,
                        ...(structuredSubmitted ? { structuredDigest: structuredOutputDigest(structuredResult) } : {}),
                        ...(candidateContext.completedBy === undefined ? {} : { completedBy: candidateContext.completedBy }),
                        summary: candidateContext.summary,
                        request: async (name, requestArgs) => {
                          if (!child.readOnly().includes(name)) throw new KernelError('extension_request_read_only_required');
                          const requestSignal = currentKernelExecutionContext()?.signal ?? candidateContext.signal;
                          return await child.call(name, requestArgs, {
                            signal: requestSignal,
                            sessionId: id,
                            runId: acceptance.runId,
                            source,
                            callId: randomUUID(),
                            parentCallId: candidateContext.callId,
                            ...(candidateContext.executionId === undefined ? {} : { executionId: candidateContext.executionId }),
                            ...(candidateContext.userSeq === undefined ? {} : { userSeq: candidateContext.userSeq }),
                            ...(candidateContext.parentRunId === undefined ? {} : { parentRunId: candidateContext.parentRunId }),
                            ...(candidateContext.parentExecutionId === undefined ? {} : { parentExecutionId: candidateContext.parentExecutionId }),
                          });
                        },
                      }, deps.promptFragmentBytes ?? 8192, deps.taskBudget?.(), completionContext);
                    if (completion.decision === 'continue') completionContext = completion.context;
                    return completion;
                  },
                  onCompletionInvalidated: () => {
                    structuredSubmitted = false;
                    structuredResult = undefined;
                  },
                  ...(deps.finiteCommands === undefined ? {} : {
                    beginCompletionCandidate: () => deps.finiteCommands!.beginCompletionCandidate(id, acceptance.runId),
                    settleSubruns: async (status: 'completed' | 'cancelled' | 'failed') =>
                      await deps.finiteCommands!.settleRun(id, acceptance.runId, status),
                    resumeSubruns: () => deps.finiteCommands!.resumeRun(id, acceptance.runId),
                    finishSubruns: async () => await deps.finiteCommands!.finishRun(id, acceptance.runId),
                  }),
                  user: { origin: source, run: acceptance },
                  steering,
                  onAccepted: () => {
                    steering.activate();
                    lifecycle?.onStarted({
                      subrunId: lifecycle.subrunId,
                      sessionId: id,
                      runId: acceptance.runId,
                      ...(runId === undefined ? {} : { parentRunId: runId }),
                      ...(callId === undefined ? {} : { parentCallId: callId }),
                      path: session.path,
                      inbox: steering,
                      session,
                    });
                  },
                  ...(prepared.preset === undefined ? {} : {
                    onContextPersisted: () => lifecycle?.onContextPersisted?.(),
                  }),
                  persistTerminal: async (status, summary, fields) => {
                    const validation = status === 'completed'
                      ? outputContract === undefined ? { status: 'not_requested' as const }
                        : { status: 'valid' as const, schemaDigest: outputContract.digest }
                      : outputContract === undefined ? { status: 'not_requested' as const }
                        : { status: 'invalid' as const, schemaDigest: outputContract.digest,
                            errors: ['The child run ended before a valid structured result was submitted.'] };
                    const evidence = runEvidenceReferences(await session.read(), acceptance.runId);
                    const evidenceOptions = {
                      ...(evidence.fileChanges.length === 0 ? {} : { fileChanges: evidence.fileChanges }),
                      ...(evidence.fileChangesTruncated === undefined ? {} : { fileChangesTruncated: true as const }),
                      ...(evidence.checks.length === 0 ? {} : { checks: evidence.checks }),
                      ...(evidence.checksTruncated === undefined ? {} : { checksTruncated: true as const }),
                    };
                    childRunResult = status === 'completed'
                      ? completedRunResult(acceptance.runId, id, {
                        ...summary,
                        ...(typeof fields.completedBy === 'string' ? { completedBy: fields.completedBy } : {}),
                      }, {
                        ...(structuredSubmitted ? { structured: structuredResult } : {}),
                        validation,
                        ...evidenceOptions,
                      })
                      : failedRunResult(acceptance.runId, id,
                        typeof fields.code === 'string' ? fields.code : 'subagent_failed',
                        fields.diagnostics as KernelError['diagnostics'], validation, summary, evidenceOptions);
                    const projectRoot = typeof deps.config.workspaceRoot === 'string' ? deps.config.workspaceRoot : boundaryOf(deps.config);
                    return await publishRunResult(session.directory, workspaceIdentity(projectRoot), id,
                      acceptance.runId, childRunResult);
                  },
                  validateCompletion: () => assertDelegationCompletion(outputContract, structuredSubmitted) });
              } catch (error) {
                // Record-lock and Session I/O failures mean the child record may be unreliable; do not turn them into a normal child result.
                if (error instanceof KernelRuntimeError) throw error;
                const code = stableErrorCode(error);
                const summary = runSummary(error);
                const validation = outputContract === undefined ? undefined : {
                  status: 'invalid' as const,
                  schemaDigest: outputContract.digest,
                  errors: [`Run ended with ${code} before a valid structured result was submitted.`],
                };
                return {
                  text: summary?.text || null,
                  summary: `Child run ${code}; its saved Session is available for inspection.`,
                  sessionId: id,
                  path: session.path,
                  iterations: summary?.iterations ?? null,
                  modelCalls: summary?.modelCalls ?? null,
                  generation: {
                    outputTokens: provider.outputTokens ?? null,
                    thinkingEffort: provider.thinkingEffort ?? provider.thinkingCapability?.defaultEffort ?? null,
                  },
                  limits,
                  mode: resolvedMode?.name ?? null,
                  modeDigest: modeIdentity?.digest ?? null,
                  result: failedRunResult(
                    acceptance.runId,
                    id,
                    code,
                    error instanceof KernelError ? error.diagnostics : undefined,
                    validation,
                    summary,
                  ),
                };
              }
              const validation = outputContract === undefined
                ? { status: 'not_requested' as const }
                : { status: 'valid' as const, schemaDigest: outputContract.digest };
              return {
                text: result.text,
                sessionId: id,
                path: session.path,
                iterations: result.iterations,
                modelCalls: result.modelCalls,
                generation: {
                  outputTokens: provider.outputTokens ?? null,
                  thinkingEffort: provider.thinkingEffort ?? provider.thinkingCapability?.defaultEffort ?? null,
                },
                limits,
                mode: resolvedMode?.name ?? null,
                modeDigest: modeIdentity?.digest ?? null,
                result: childRunResult ?? completedRunResult(acceptance.runId, id, result, {
                  ...(structuredSubmitted ? { structured: structuredResult } : {}),
                  validation,
                }),
              };
            } finally {
              try { undoMode(); }
              finally {
                try { undoParentRestrictions(); }
                finally {
                  try { undoOutputContract(); }
                  finally {
                    try { undoPresetInstruction(); }
                    finally {
                      try { disposeResultTool?.(); }
                      finally {
                        try { disposeAssembly?.(); }
                        finally {
                          try { await closeManagedProcesses?.(); }
                          finally {
                            try { await deps.finiteCommands?.finishRun(id, acceptance.runId); }
                            finally { try { await closeMcp?.(); } finally { await session.close(); } }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          } finally {
            active -= 1;
          }
        },
      };
      executeSubagent = subagentTool.run;
      // 预设发现属于客户端与控制器（`preset.list` / `preset.preview` RPC），不注册成模型工具：
      // 模型只拿到用户或控制器已经选定的 presetId。
      const unregister = [
        kernel.register({
          ...subagentTool,
          run: async (args: SubagentRunArguments, context: SubagentCallContext) => {
            const child = await start(args, context, 'controller');
            return await waitForResult(child.subrunId, child.parentRunId);
          },
        }),
        kernel.register({
          name: 'subagent_start',
          access: 'inherit',
          execution: 'parallel',
          description: 'Start one independent child Run and return its stable subrun, Session, and Run IDs. Use subagent_status, subagent_message, subagent_wait, or subagent_cancel to control it. The parent waits for active children before its own completion.',
          parameters: subagentTool.parameters,
          run: async (args: SubagentRunArguments, context: SubagentCallContext) => await start(args, context, 'controller'),
        }),
        kernel.register({
          name: 'subagent_status',
          access: 'read',
          execution: 'parallel',
          description: 'Read the live status of a child Run started by this parent Run.',
          parameters: { type: 'object', properties: { subrunId: { type: 'string', minLength: 1, maxLength: 160 } }, required: ['subrunId'] },
          run: async (args: { subrunId: string }, context: SubagentCallContext) => {
            if (context.runId === undefined) throw new KernelError('subagent_parent_run_unavailable');
            return await status(args.subrunId, context.runId);
          },
        }),
        kernel.register({
          name: 'subagent_message',
          access: 'inherit',
          execution: 'parallel',
          description: 'Send bounded steering to one active child Run using its expected Run ID.',
          parameters: { type: 'object', properties: {
            subrunId: { type: 'string', minLength: 1, maxLength: 160 },
            runId: { type: 'string', minLength: 1, maxLength: 160 },
            input: { type: 'string', minLength: 1, maxLength: 65_536 },
          }, required: ['subrunId', 'runId', 'input'] },
          run: async (args: { subrunId: string; runId: string; input: string }, context: SubagentCallContext) => {
            if (context.runId === undefined) throw new KernelError('subagent_parent_run_unavailable');
            return await message({ ...args, parentRunId: context.runId }, 'controller', () => deps.onSubrunMessageAccepted?.(args.runId));
          },
        }),
        kernel.register({
          name: 'subagent_wait',
          access: 'read',
          execution: 'parallel',
          description: 'Wait for one or more child Runs. A timeout returns their current status and does not cancel them.',
          parameters: { type: 'object', properties: {
            subrunIds: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 160 } },
            timeoutMs: { type: 'integer', minimum: 1, maximum: 30_000 },
          }, required: ['subrunIds'] },
          run: async (args: { subrunIds: string[]; timeoutMs?: number }, context: SubagentCallContext) => {
            if (context.runId === undefined) throw new KernelError('subagent_parent_run_unavailable');
            const waited = await wait(args.subrunIds, context.runId, args.timeoutMs ?? 30_000);
            if (waited.timedOut) return waited;
            const results = await Promise.all(args.subrunIds.map(async (id, index) => {
              const state = waited.subruns[index]?.state;
              if (state === 'failed' || state === 'unknown') return undefined;
              try { return await waitForResult(id, context.runId!); }
              catch (error) {
                if (state === 'cancelled') return undefined;
                throw error;
              }
            }));
            return { timedOut: false, subruns: waited.subruns.map((item, index) => ({
              ...item, ...(results[index] === undefined ? {} : { result: results[index] }),
            })) };
          },
        }),
        kernel.register({
          name: 'subagent_cancel',
          access: 'inherit',
          execution: 'parallel',
          description: 'Request cancellation for one child Run. Other child Runs continue independently.',
          parameters: { type: 'object', properties: {
            subrunId: { type: 'string', minLength: 1, maxLength: 160 },
            runId: { type: 'string', minLength: 1, maxLength: 160 },
          }, required: ['subrunId', 'runId'] },
          run: async (args: { subrunId: string; runId: string }, context: SubagentCallContext) => {
            if (context.runId === undefined) throw new KernelError('subagent_parent_run_unavailable');
            return await cancel({ ...args, parentRunId: context.runId });
          },
        }),
      ];
      return () => { for (const dispose of unregister.reverse()) dispose(); };
    },
    start,
    listPresets,
    previewPreset,
    list,
    status,
    message,
    wait,
    waitForResult,
    cancel,
    settleParent,
    beginCompletionCandidate,
    resumeParent,
    finishParent,
    close,
    interaction,
  };
}

export type {
  AgentPresetPreview,
  PreparedSubagentRun,
  SubagentCallContext,
  SubagentProvider,
  SubagentRunArguments,
} from './subagent-spec.js';
export type { ThinkingEffort } from './subagent-spec.js';
