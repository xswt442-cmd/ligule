import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { KernelError } from '../kernel/error.js';
import type { ProviderDiagnostic } from '../kernel/error.js';
import { completedRunResult, failedRunResult, type RunResult } from '../delegation.js';
import { checkedAnswers, type AskQuestion } from '../tools/ask-user.js';
import { APPROVAL_METHOD, QUESTION_METHOD } from './protocol.js';
import type { Host } from './host.js';
import type { LoopResult } from '../kernel/loop.js';

export type OperationState = 'running' | 'done' | 'failed' | 'cancelled';
export type InteractionType = 'approval' | 'question';

interface ControlEvent extends Record<string, unknown> {
  readonly cursor: number;
  readonly kind: string;
  readonly at: number;
  readonly sessionId: string;
  readonly operationId: string;
}

interface Operation {
  readonly operationId: string;
  readonly sessionId: string;
  state: OperationState;
  code?: string;
  diagnostics?: ProviderDiagnostic;
  summary?: string;
  phase?: string;
  progress?: Record<string, unknown> | null;
  result?: RunResult;
  updatedAt: number;
  nextCursor: number;
  readonly events: ControlEvent[];
  settled: Promise<void>;
}

interface PendingInteraction {
  readonly requestId: string;
  readonly sessionId: string;
  readonly operationId: string;
  readonly type: InteractionType;
  readonly createdAt: number;
  readonly details: Record<string, unknown>;
  readonly questions?: readonly AskQuestion[];
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface QueueItem {
  readonly queueItemId: string;
  readonly input: string;
  readonly acceptedAt: number;
  readonly sourceOperationId: string;
}

interface SessionQueue {
  readonly items: QueueItem[];
  paused: boolean;
}

interface ControlOptions {
  readonly operator?: boolean;
  readonly onEvent?: (event: ControlEvent) => void;
}

export interface McpInitialSettings {
  readonly mode?: string;
  readonly policy?: 'ask' | 'auto' | 'never';
  readonly model?: { readonly provider: string; readonly model: string };
  readonly thinking?: { readonly effort: 'none' | 'low' | 'high' | 'max' | 'default' } | null;
  readonly outputTokens?: number | null;
  readonly loopIterations?: number;
  readonly permission?: { readonly profile: 'read-only' | 'workspace-write' | 'full-access'; readonly network: 'policy' | 'unrestricted' | 'disabled' };
}

export interface McpSessionChanges {
  readonly mode?: string;
  readonly policy?: 'ask' | 'auto' | 'never' | 'default';
  readonly model?: { readonly provider: string; readonly model: string } | null;
  readonly thinking?: { readonly effort: 'none' | 'low' | 'high' | 'max' | 'default' } | null;
  readonly outputTokens?: number | null;
  readonly loopIterations?: number;
  readonly permission?: {
    readonly profile?: 'read-only' | 'workspace-write' | 'full-access';
    readonly network?: 'policy' | 'unrestricted' | 'disabled';
  };
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new KernelError('host_response_invalid');
  return value as Record<string, unknown>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function containsSensitiveMaterial(value: unknown): boolean {
  if (typeof value === 'string') {
    return /\bBearer\s+\S+/iu.test(value)
      || /\b(?:Authorization|Proxy-Authorization)\s*:\s*(?:Basic|Digest|Token)\s+\S+/iu.test(value)
      || /(?:^|[^A-Za-z0-9_-])(?:x[-_]api[-_]key|api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|password|passwd|secret)\s*[:=]\s*["']?[^\s"'\x00-\x1f]+/iu.test(value)
      || /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/u.test(value)
      || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(value)
      || /https?:\/\/[^\s/@:]+:[^\s/@]+@/iu.test(value);
  }
  if (Array.isArray(value)) return value.some(containsSensitiveMaterial);
  if (!isPlainRecord(value)) return false;
  for (const [key, nested] of Object.entries(value)) {
    if (/(?:^|[-_])(?:api[-_]?key|authorization|proxy[-_]?authorization|cookie|set-cookie|password|passwd|secret|credential|credentials|access[-_]?token|refresh[-_]?token|bearer)(?:$|[-_])/iu.test(key)
      && nested !== undefined && nested !== null && nested !== '') return true;
    if (containsSensitiveMaterial(nested)) return true;
  }
  return false;
}

/** 对外错误不包含 Host 内部信息、路径、凭据或原始错误原因。 */
export function controlErrorCode(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  return typeof code === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(code) ? code : 'control_failed';
}

/** 每个本地控制器独立拥有一个 Host；操作 ID 仅在该控制器存续期间有效。 */
export function createControl(host: Host, projectRoot: string, options: ControlOptions = {}) {
  const sessions = new Set<string>();
  const operations = new Map<string, Operation>();
  const active = new Map<string, Operation>();
  const interactions = new Map<string, PendingInteraction>();
  const queues = new Map<string, SessionQueue>();
  const operator = options.operator === true;
  let closing: Promise<void> | undefined;
  let closingCode = 'control_closed';
  let opening = 0;
  const pending = new Set<Promise<unknown>>();

  function publish(found: Operation, kind: string, fields: Record<string, unknown> = {}): ControlEvent {
    const event: ControlEvent = {
      cursor: found.nextCursor++, kind, at: Date.now(), sessionId: found.sessionId, operationId: found.operationId, ...fields,
    };
    found.updatedAt = event.at;
    found.events.push(event);
    if (found.events.length > 128) found.events.shift();
    try { options.onEvent?.(event); } catch { /* Notification failure does not alter the Host operation. */ }
    return event;
  }

  function currentQueue(sessionId: string): SessionQueue {
    let found = queues.get(sessionId);
    if (found === undefined) {
      found = { items: [], paused: false };
      queues.set(sessionId, found);
    }
    return found;
  }

  function pendingFor(found: Operation): PendingInteraction[] {
    return [...interactions.values()].filter((one) => one.operationId === found.operationId);
  }

  function interactionRequest(method: string, params: unknown): Promise<unknown> {
    const input = record(params);
    if (method !== APPROVAL_METHOD && method !== QUESTION_METHOD) {
      return Promise.reject(new KernelError('control_interaction_unknown'));
    }
    if (method === APPROVAL_METHOD && !operator) return Promise.resolve({ decision: 'deny' });
    if (method === QUESTION_METHOD && !operator) return Promise.reject(new KernelError('control_operator_required'));
    const sessionId = typeof input.sessionId === 'string' ? input.sessionId : '';
    const found = active.get(sessionId);
    if (found === undefined || found.state !== 'running' || closing !== undefined) {
      return method === APPROVAL_METHOD
        ? Promise.resolve({ decision: 'deny' })
        : Promise.reject(new KernelError('control_interaction_stale'));
    }
    if (pendingFor(found).length >= 8) {
      publish(found, 'interaction.rejected', { interactionType: method === APPROVAL_METHOD ? 'approval' : 'question', code: 'control_interaction_limit' });
      return method === APPROVAL_METHOD
        ? Promise.resolve({ decision: 'deny' })
        : Promise.reject(new KernelError('control_interaction_limit'));
    }

    const requestId = randomUUID();
    const type: InteractionType = method === APPROVAL_METHOD ? 'approval' : 'question';
    const details = type === 'approval'
      ? {
          tool: input.tool,
          args: input.args,
          ...(input.command === undefined ? {} : { command: input.command }),
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          ...(input.policy === undefined ? {} : { policy: input.policy }),
          ...(input.policySource === undefined ? {} : { policySource: input.policySource }),
          ...(input.policyForced === undefined ? {} : { policyForced: input.policyForced }),
          ...(input.shell === undefined ? {} : { shell: input.shell }),
          ...(input.executable === undefined ? {} : { executable: input.executable }),
        }
      : { questions: input.questions };
    let serialized: string;
    try { serialized = JSON.stringify(details); }
    catch { serialized = ''; }
    if (serialized === '' || serialized.length > 16_384) {
      publish(found, 'interaction.rejected', { requestId, interactionType: type, code: 'control_interaction_unreviewable' });
      return method === APPROVAL_METHOD
        ? Promise.resolve({ decision: 'deny' })
        : Promise.reject(new KernelError('control_interaction_unreviewable'));
    }
    if (containsSensitiveMaterial(details)) {
      publish(found, 'interaction.rejected', { requestId, interactionType: type, code: 'control_interaction_sensitive' });
      return method === APPROVAL_METHOD
        ? Promise.resolve({ decision: 'deny' })
        : Promise.reject(new KernelError('control_interaction_sensitive'));
    }

    let resolve!: (value: unknown) => void;
    let reject!: (error: Error) => void;
    const response = new Promise<unknown>((accept, decline) => { resolve = accept; reject = decline; });
    const questionList = type === 'question' && Array.isArray(input.questions)
      ? input.questions as AskQuestion[]
      : undefined;
    if (type === 'question' && questionList === undefined) return Promise.reject(new KernelError('control_question_invalid'));
    interactions.set(requestId, {
      requestId, sessionId, operationId: found.operationId, type, createdAt: Date.now(), details,
      ...(questionList === undefined ? {} : { questions: questionList }), resolve, reject,
    });
    publish(found, 'interaction.required', { requestId, interactionType: type });
    return response;
  }

  const connection = {
    notify(message: Record<string, unknown>) {
      const sessionId = typeof message.sessionId === 'string' ? message.sessionId : undefined;
      if (sessionId === undefined) return;
      const found = active.get(sessionId);
      if (found === undefined || found.state !== 'running') return;
      if (message.notify === 'progress' && isPlainRecord(message.progress)) {
        found.progress = message.progress;
        found.phase = typeof message.progress.phase === 'string' ? message.progress.phase : undefined;
        publish(found, 'run.progress', { phase: found.phase ?? null, progress: message.progress });
      } else if (message.notify === 'event' && isPlainRecord(message.event)) {
        publish(found, 'session.event', {
          eventSeq: typeof message.event.seq === 'number' ? message.event.seq : null,
          eventKind: typeof message.event.kind === 'string' ? message.event.kind : 'unknown',
        });
      } else if (message.notify === 'fault') {
        publish(found, 'run.fault', { code: typeof message.code === 'string' ? message.code : 'host_fault' });
      }
    },
    request(method: string, params?: unknown) { return interactionRequest(method, params); },
  };

  async function tracked<T>(work: Promise<T>): Promise<T> {
    pending.add(work);
    try { return await work; }
    finally { pending.delete(work); }
  }

  function ready(): void {
    if (closing !== undefined) throw new KernelError(closingCode);
  }

  function owned(sessionId: string): void {
    ready();
    if (!sessions.has(sessionId)) throw new KernelError('session_not_open');
  }

  async function authorized(root: string): Promise<void> {
    if (!isAbsolute(root)) throw new KernelError('control_project_forbidden');
    let actual: string;
    try { actual = await realpath(resolve(root)); }
    catch { throw new KernelError('control_project_forbidden'); }
    if (actual !== projectRoot) throw new KernelError('control_project_forbidden');
  }

  async function session(method: 'session.create' | 'session.open', root: string, sessionId?: string, initial?: McpInitialSettings) {
    ready();
    if (initial !== undefined && Object.keys(initial).length > 0 && !operator) throw new KernelError('control_operator_required');
    if ((sessionId === undefined || !sessions.has(sessionId)) && sessions.size + opening >= 64) throw new KernelError('control_session_limit');
    opening += 1;
    const work = (async () => {
      await authorized(root);
      ready();
      const initialModel = initial?.model;
      const initialThinking = initial?.thinking;
      const initialPermission = initial?.permission;
      const result = record(await host.handle({ method, params: {
        projectRoot,
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(method !== 'session.create' || initial === undefined ? {} : {
          ...(initial.mode === undefined ? {} : { initialMode: initial.mode }),
          ...(initial.policy === undefined ? {} : { initialPolicy: initial.policy }),
          ...(initialModel === undefined ? {} : { initialProvider: initialModel.provider, initialModel: initialModel.model }),
          ...(initialThinking === undefined || initialThinking === null || initialThinking.effort === 'default'
            ? {} : { initialThinkingEffort: initialThinking.effort }),
          ...(initial.outputTokens === undefined || initial.outputTokens === null ? {} : { initialOutputTokens: initial.outputTokens }),
          ...(initial.loopIterations === undefined ? {} : { initialLoopIterations: initial.loopIterations }),
          ...(initialPermission === undefined ? {} : {
            initialPermissionProfile: initialPermission.profile,
            initialPermissionNetwork: initialPermission.network,
          }),
        }),
      } }, connection));
      if (typeof result.sessionId !== 'string') throw new KernelError('host_response_invalid');
      sessions.add(result.sessionId);
      return { sessionId: result.sessionId, ...(result.settingsApplied === true ? { settingsApplied: true } : {}) };
    })();
    pending.add(work);
    try { return await work; }
    finally { opening -= 1; pending.delete(work); }
  }

  function operation(operationId: string): Operation {
    ready();
    const found = operations.get(operationId);
    if (found === undefined) throw new KernelError('operation_not_found');
    return found;
  }

  function queueSummary(sessionId: string) {
    const queue = currentQueue(sessionId);
    return {
      queue: queue.items.map(({ queueItemId, acceptedAt, input }) => ({ queueItemId, acceptedAt, inputCharacters: input.length })),
      queuePaused: queue.paused,
      currentOperationId: active.get(sessionId)?.operationId ?? null,
    };
  }

  function status(found: Operation, after = 0, limit = 20) {
    const firstAvailableCursor = found.events[0]?.cursor ?? found.nextCursor;
    const eventGap = after < firstAvailableCursor - 1;
    const availableEvents = found.events.filter((event) => event.cursor > after);
    const events = availableEvents.slice(0, limit);
    return {
      operationId: found.operationId, sessionId: found.sessionId, state: found.state,
      ...(found.code === undefined ? {} : { code: found.code }),
      ...(found.diagnostics === undefined ? {} : { diagnostics: found.diagnostics }),
      ...(found.summary === undefined ? {} : { summary: found.summary }),
      result: found.result ?? null,
      phase: found.phase ?? null,
      waitingFor: found.phase === 'awaiting_approval' ? 'approval' : found.phase === 'awaiting_input' ? 'input' : null,
      progress: found.progress ?? null,
      updatedAt: found.updatedAt,
      pendingInteractions: pendingFor(found).map((interaction) => ({
        requestId: interaction.requestId,
        sessionId: interaction.sessionId,
        operationId: interaction.operationId,
        type: interaction.type,
        createdAt: interaction.createdAt,
        details: interaction.details,
      })),
      events,
      nextCursor: events.at(-1)?.cursor ?? after,
      hasMoreEvents: availableEvents.length > events.length,
      eventGap,
      firstAvailableCursor,
      ...queueSummary(found.sessionId),
    };
  }

  function settleInteractions(found: Operation, errorCode = 'control_interaction_stale'): void {
    for (const interaction of pendingFor(found)) {
      interactions.delete(interaction.requestId);
      if (interaction.type === 'approval') interaction.resolve({ decision: 'deny' });
      else interaction.reject(new KernelError(errorCode));
    }
  }

  function publishFinished(found: Operation): void {
    const kind = found.state === 'done' ? 'run.completed' : found.state === 'cancelled' ? 'run.cancelled' : 'run.failed';
    publish(found, kind, {
      ...(found.code === undefined ? {} : { code: found.code }),
      ...(found.diagnostics === undefined ? {} : { diagnostics: found.diagnostics }),
    });
  }

  function startOne(sessionId: string, input: string, queueItemId?: string) {
    owned(sessionId);
    if (active.has(sessionId)) throw new KernelError('run_already_running');
    if (operations.size >= 256) {
      const oldest = [...operations.values()].find((entry) => entry.state !== 'running');
      if (oldest === undefined) throw new KernelError('control_operation_limit');
      operations.delete(oldest.operationId);
    }
    const found: Operation = {
      operationId: randomUUID(), sessionId, state: 'running', updatedAt: Date.now(), nextCursor: 1, events: [], settled: Promise.resolve(),
    };
    operations.set(found.operationId, found);
    active.set(sessionId, found);
    publish(found, 'run.started', { ...(queueItemId === undefined ? {} : { queueItemId }) });
    const work = Promise.resolve().then(() => host.handle({ method: 'run.start', params: { sessionId, input } }, connection));
    found.settled = work.then(
      (result) => {
        const completed = record(result);
        if (typeof completed.text !== 'string' || !Number.isSafeInteger(completed.iterations)
          || !Number.isSafeInteger(completed.modelCalls)
          || (completed.completedBy !== undefined && typeof completed.completedBy !== 'string')) {
          throw new KernelError('host_response_invalid');
        }
        found.result = completedRunResult(found.operationId, sessionId, {
          text: completed.text,
          iterations: completed.iterations as number,
          modelCalls: completed.modelCalls as number,
          ...(typeof completed.completedBy === 'string' ? { completedBy: completed.completedBy } : {}),
        } satisfies LoopResult);
        found.state = 'done';
        found.summary = 'Run completed.';
      },
    ).catch((error: unknown) => {
      found.code = controlErrorCode(error);
      if (error instanceof KernelError && error.diagnostics !== undefined) found.diagnostics = error.diagnostics;
      found.state = ['provider_cancelled', 'loop_cancelled', 'ask_user_cancelled'].includes(found.code) ? 'cancelled' : 'failed';
      found.result = failedRunResult(found.operationId, sessionId, found.code, found.diagnostics);
    }).then(() => {
      settleInteractions(found);
      if (active.get(sessionId) === found) active.delete(sessionId);
      publishFinished(found);
      const queue = currentQueue(sessionId);
      if (found.state === 'done' && !queue.paused) drainQueue(sessionId);
      else if (found.state !== 'done' && queue.items.length > 0) queue.paused = true;
    });
    return found;
  }

  function drainQueue(sessionId: string): void {
    const queue = queues.get(sessionId);
    if (queue === undefined || queue.paused || queue.items.length === 0 || active.has(sessionId) || closing !== undefined) return;
    const item = queue.items.shift()!;
    try {
      const next = startOne(sessionId, item.input, item.queueItemId);
      const source = operations.get(item.sourceOperationId);
      if (source !== undefined) publish(source, 'queue.started', { queueItemId: item.queueItemId, newOperationId: next.operationId });
    }
    catch (error) {
      queue.items.unshift(item);
      queue.paused = true;
      const latest = [...operations.values()].reverse().find((operation) => operation.sessionId === sessionId);
      if (latest !== undefined) publish(latest, 'queue.paused', { queueItemId: item.queueItemId, code: controlErrorCode(error) });
    }
  }

  function replyInteraction({ sessionId, requestId, type, decision, answers }: {
    sessionId: string; requestId: string; type: InteractionType; decision?: 'allow' | 'deny'; answers?: unknown;
  }) {
    ready();
    if (!operator) throw new KernelError('control_operator_required');
    owned(sessionId);
    const interaction = interactions.get(requestId);
    if (interaction === undefined) throw new KernelError('control_interaction_stale');
    if (interaction.sessionId !== sessionId) throw new KernelError('control_interaction_session_mismatch');
    if (interaction.type !== type) throw new KernelError('control_interaction_type_mismatch');
    const found = operations.get(interaction.operationId);
    if (found === undefined || found.state !== 'running' || active.get(sessionId) !== found) {
      throw new KernelError('control_interaction_stale');
    }
    if (type === 'approval') {
      if (decision !== 'allow' && decision !== 'deny') throw new KernelError('control_interaction_decision_invalid');
      interactions.delete(requestId);
      publish(found, 'interaction.resolved', { requestId, interactionType: type, decision });
      interaction.resolve({ decision });
      return { requestId, sessionId, operationId: found.operationId, type, decision, resolved: true };
    }
    const questions = interaction.questions;
    if (questions === undefined) throw new KernelError('control_question_invalid');
    const checked = checkedAnswers(questions, { answers });
    interactions.delete(requestId);
    publish(found, 'interaction.resolved', { requestId, interactionType: type, answered: checked.length });
    interaction.resolve({ answers: checked });
    return { requestId, sessionId, operationId: found.operationId, type, answered: checked.length, resolved: true };
  }

  async function configure(sessionId: string, changes?: McpSessionChanges) {
    ready();
    owned(sessionId);
    const hasChanges = changes !== undefined && Object.keys(changes).length > 0;
    if (hasChanges && !operator) throw new KernelError('control_operator_required');
    const params: Record<string, unknown> = { sessionId };
    if (changes?.mode !== undefined) params.mode = changes.mode;
    if (changes?.policy !== undefined) params.policy = changes.policy;
    if (changes?.model === null) params.resetModel = true;
    else if (changes?.model !== undefined) { params.provider = changes.model.provider; params.model = changes.model.model; }
    if (changes?.thinking === null) params.resetThinking = true;
    else if (changes?.thinking !== undefined) params.thinkingEffort = changes.thinking.effort;
    if (changes?.outputTokens === null) params.resetOutputTokens = true;
    else if (changes?.outputTokens !== undefined) params.outputTokens = changes.outputTokens;
    if (changes?.loopIterations !== undefined) params.loopIterations = changes.loopIterations;
    if (changes?.permission?.profile !== undefined) params.permissionProfile = changes.permission.profile;
    if (changes?.permission?.network !== undefined) params.permissionNetwork = changes.permission.network;
    const result = record(await tracked(host.handle({ method: 'session.configure', params }, connection)));
    if (changes?.permission === undefined) return { ...result, requested: changes ?? null };
    const effective = record(await tracked(host.handle({ method: 'session.configure', params: { sessionId } }, connection)));
    return { ...effective, requested: changes };
  }

  function send(sessionId: string, action: 'send' | 'continue' | 'cancel_queued' | 'clear_queue', input?: string, queueItemId?: string) {
    owned(sessionId);
    const queue = currentQueue(sessionId);
    if (action === 'continue') {
      if (input !== undefined || queueItemId !== undefined) throw new KernelError('session_send_arguments_invalid');
      if (queue.items.length === 0) throw new KernelError('session_queue_empty');
      queue.paused = false;
      drainQueue(sessionId);
      return { sessionId, action, ...queueSummary(sessionId) };
    }
    if (action === 'cancel_queued') {
      if (input !== undefined) throw new KernelError('session_send_arguments_invalid');
      if (typeof queueItemId !== 'string' || queueItemId === '') throw new KernelError('session_queue_item_required');
      const index = queue.items.findIndex((item) => item.queueItemId === queueItemId);
      if (index < 0) throw new KernelError('session_queue_item_not_found');
      queue.items.splice(index, 1);
      if (queue.items.length === 0) queue.paused = false;
      const latest = active.get(sessionId) ?? [...operations.values()].reverse().find((operation) => operation.sessionId === sessionId);
      if (latest !== undefined) publish(latest, 'queue.item_cancelled', { queueItemId });
      return { sessionId, action, queueItemId, ...queueSummary(sessionId) };
    }
    if (action === 'clear_queue') {
      if (input !== undefined || queueItemId !== undefined) throw new KernelError('session_send_arguments_invalid');
      const cleared = queue.items.length;
      queue.items.length = 0;
      queue.paused = false;
      const latest = active.get(sessionId) ?? [...operations.values()].reverse().find((operation) => operation.sessionId === sessionId);
      if (latest !== undefined && cleared > 0) publish(latest, 'queue.cleared', { cleared });
      return { sessionId, action, cleared, ...queueSummary(sessionId) };
    }
    if (queueItemId !== undefined) throw new KernelError('session_send_arguments_invalid');
    if (typeof input !== 'string' || input.trim() === '' || input.length > 65_536) throw new KernelError('session_input_invalid');
    if (!active.has(sessionId) && queue.items.length === 0 && !queue.paused) {
      const found = startOne(sessionId, input);
      return {
        sessionId, accepted: true, queued: false, operationId: found.operationId, state: found.state,
        ...queueSummary(sessionId),
      };
    }
    if (queue.items.length >= 16) throw new KernelError('session_queue_full');
    const sourceOperation = active.get(sessionId) ?? [...operations.values()].reverse().find((operation) => operation.sessionId === sessionId);
    if (sourceOperation === undefined) throw new KernelError('session_queue_source_missing');
    const item: QueueItem = { queueItemId: randomUUID(), input, acceptedAt: Date.now(), sourceOperationId: sourceOperation.operationId };
    queue.items.push(item);
    const activeOperation = active.get(sessionId) ?? [...operations.values()].reverse().find((operation) => operation.sessionId === sessionId);
    if (activeOperation !== undefined) publish(activeOperation, 'message.queued', { queueItemId: item.queueItemId, inputCharacters: input.length });
    return { sessionId, accepted: true, queued: true, queueItemId: item.queueItemId, ...queueSummary(sessionId) };
  }

  return {
    create: (root: string, initial?: McpInitialSettings) => session('session.create', root, undefined, initial),
    open: (root: string, sessionId: string) => session('session.open', root, sessionId),
    configure,
    replyInteraction,
    send,
    async list(root: string, limit: number) {
      ready();
      await authorized(root);
      ready();
      const result = record(await tracked(host.handle({ method: 'sessions.list', params: { projectRoot, limit } }, connection)));
      if (!Array.isArray(result.sessions)) throw new KernelError('host_response_invalid');
      return { sessions: result.sessions.map((item: unknown) => {
        const entry = record(item);
        if (typeof entry.name !== 'string' || (entry.createdAt !== null && typeof entry.createdAt !== 'string')) {
          throw new KernelError('host_response_invalid');
        }
        return { sessionId: entry.id, name: entry.name.slice(0, 120), archived: entry.archived,
          createdAt: entry.createdAt === null ? null : entry.createdAt.slice(0, 128) };
      }) };
    },
    start(sessionId: string, input: string) {
      owned(sessionId);
      const queue = currentQueue(sessionId);
      if (queue.items.length > 0) throw new KernelError('session_queue_pending');
      queue.paused = false;
      return status(startOne(sessionId, input));
    },
    status(operationId: string, after = 0, limit = 20) {
      if (!Number.isSafeInteger(after) || after < 0) throw new KernelError('control_cursor_invalid');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new KernelError('control_event_limit_invalid');
      return status(operation(operationId), after, limit);
    },
    async await(operationId: string, timeoutMs = 60_000) {
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 300_000) {
        throw new KernelError('control_wait_timeout_invalid');
      }
      const found = operation(operationId);
      if (found.state === 'running' && timeoutMs > 0) {
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            found.settled,
            new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
          ]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      }
      return { ...status(found), timedOut: found.state === 'running' };
    },
    async cancel(operationId: string) {
      const found = operation(operationId);
      if (found.state === 'running') {
        try { await host.handle({ method: 'run.cancel', params: { sessionId: found.sessionId } }, connection); }
        catch (error) { if (controlErrorCode(error) !== 'run_not_running') throw error; }
        await found.settled;
      }
      return { ...status(found), terminated: found.state !== 'running' };
    },
    invalidate(code: string): Promise<void> {
      if (closing !== undefined) return closing;
      if (!/^[a-z][a-z0-9_]{0,79}$/.test(code)) throw new KernelError('control_error_code_invalid');
      closingCode = code;
      return this.release();
    },
    async read(sessionId: string, before: number | undefined, limit: number, at?: number, offset = 0) {
      owned(sessionId);
      if (offset > 0 && at === undefined) throw new KernelError('session_cursor_invalid');
      const result = record(await tracked(host.handle({ method: 'session.read', params: {
        sessionId, limit, fullResults: true,
        ...(before === undefined ? {} : { before }), ...(at === undefined ? {} : { at }),
      } }, connection)));
      if (!Array.isArray(result.events)) throw new KernelError('host_response_invalid');
      const entries: { seq: number; kind: unknown; json: string; offset: number; nextOffset: number | null; totalCharacters: number }[] = [];
      let characters = 0;
      for (const value of result.events.toReversed()) {
        const event = record(value);
        if (typeof event.seq !== 'number') throw new KernelError('host_response_invalid');
        const serialized = JSON.stringify(event);
        if (offset > serialized.length) throw new KernelError('session_cursor_invalid');
        const chunk = serialized.slice(offset, offset + 8192);
        if (entries.length > 0 && (characters + chunk.length > 16384 || chunk.length < serialized.length)) break;
        entries.unshift({ seq: event.seq, kind: event.kind, json: chunk, offset,
          nextOffset: offset + chunk.length < serialized.length ? offset + chunk.length : null,
          totalCharacters: serialized.length });
        characters += chunk.length;
        if (chunk.length < serialized.length) break;
      }
      return {
        sessionId, records: entries, nextBefore: entries[0]?.seq ?? null,
        hasMore: result.hasMore === true || entries.length < result.events.length,
      };
    },
    release(): Promise<void> {
      if (closing !== undefined) return closing;
      closing = (async () => {
        const failures: unknown[] = [];
        for (const operation of operations.values()) settleInteractions(operation, 'control_closed');
        for (const queue of queues.values()) queue.items.length = 0;
        // 在 Host 取消活动任务前先处理已完成任务的错误。
        const settled = Promise.allSettled([...operations.values()].map((found) => found.settled));
        try { await host.release(); }
        catch (error) { failures.push(error); }
        try {
          await Promise.allSettled([...pending]);
          const results = await settled;
          for (const result of results) if (result.status === 'rejected') failures.push(result.reason);
        } catch (error) {
          failures.push(error);
        } finally {
          sessions.clear();
        }
        if (failures.length > 0) throw failures[0];
      })();
      return closing;
    },
  };
}
