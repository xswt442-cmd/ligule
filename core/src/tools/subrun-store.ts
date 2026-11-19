// 子 Run 的登记表与历史投影：这里回答“有哪些子 Run、它们各自处于什么状态”。
//
// 运行（启动、等待、取消、投递消息）留在 `subagent.ts`；本模块只持有内存登记、会话 ID 分配，
// 以及从磁盘会话读回已完成子 Run 的只读投影，避免两处各算一份状态。
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { KernelError } from '../kernel/error.js';
import type { SessionLog } from '../session/session.js';
import type { RunSteeringInbox } from '../kernel/run-steering.js';
import { isRunAcceptance, readRunResult, runReceipts } from '../session/run.js';
import { readSessionRecord } from '../session/record.js';
import { workspaceIdentity } from '../kernel/workspace.js';
import type { RunResult } from '../delegation.js';
import type { SubrunReference, SubrunStatus } from './subagent.js';

export const MAX_RETAINED_SUBRUNS = 64;
const SESSION_ID_MAX_LENGTH = 160;

export type SubrunRecord = {
  readonly subrunId: string;
  readonly parentRunId?: string;
  readonly parentCallId?: string;
  readonly controller: AbortController;
  state: SubrunStatus['state'];
  sessionId?: string;
  runId?: string;
  path?: string;
  inbox?: RunSteeringInbox;
  phase: string | null;
  pendingApprovals: number;
  pendingQuestions: number;
  errorCode?: string;
  result?: Record<string, unknown>;
  work?: Promise<Record<string, unknown>>;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
};

export function referenceOf(record: SubrunRecord): SubrunReference {
  if (record.sessionId === undefined || record.runId === undefined) throw new KernelError('subagent_not_started');
  return {
    subrunId: record.subrunId, sessionId: record.sessionId, runId: record.runId,
    ...(record.parentRunId === undefined ? {} : { parentRunId: record.parentRunId }),
    ...(record.parentCallId === undefined ? {} : { parentCallId: record.parentCallId }),
  };
}

/** 内存记录投影为对外状态；任务预算由调用方取当前快照传入，模块不持有预算。 */
export function viewOf(record: SubrunRecord, task: SubrunStatus['task']): SubrunStatus {
  if (record.sessionId === undefined || record.runId === undefined) throw new KernelError('subagent_not_started');
  const nested = typeof record.result?.result === 'object' && record.result.result !== null
    ? record.result.result as Record<string, unknown> : undefined;
  const result = record.result === undefined ? undefined : {
    state: typeof nested?.state === 'string' ? nested.state : record.state,
    textCharacters: typeof record.result.text === 'string' ? record.result.text.length : 0,
    ...(nested?.validation === undefined ? {} : { validation: nested.validation }),
  };
  return {
    ...referenceOf(record),
    state: record.state,
    phase: record.phase,
    task,
    pendingInteractions: { approvals: record.pendingApprovals, questions: record.pendingQuestions },
    ...(record.errorCode === undefined ? {} : { errorCode: record.errorCode }),
    ...(result === undefined ? {} : { result }),
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    ...(record.completedAt === undefined ? {} : { completedAt: record.completedAt }),
  };
}

/** 子 Run 的唯一登记表：分配会话 ID、登记记录、按需淘汰。 */
export class SubrunRegistry {
  private readonly subruns = new Map<string, SubrunRecord>();
  private counter = 0;
  private counterInitialization: Promise<void> | undefined;

  private readonly directory: string;
  private readonly parentSessionId: string;

  constructor(directory: string, parentSessionId: string) {
    this.directory = directory;
    this.parentSessionId = parentSessionId;
  }

  get size(): number { return this.subruns.size; }

  add(record: SubrunRecord): void { this.subruns.set(record.subrunId, record); }

  get(subrunId: string): SubrunRecord | undefined { return this.subruns.get(subrunId); }

  has(subrunId: string): boolean { return this.subruns.has(subrunId); }

  delete(subrunId: string): void { this.subruns.delete(subrunId); }

  values(): IterableIterator<SubrunRecord> { return this.subruns.values(); }

  find(subrunId: string, parentRunId?: string): SubrunRecord {
    const record = this.subruns.get(subrunId);
    if (record === undefined || record.parentRunId !== parentRunId) throw new KernelError('subagent_not_found');
    return record;
  }

  /** 登记表满时淘汰最早结束的一条；全都在跑则拒绝新子 Run。 */
  prune(limit: number = MAX_RETAINED_SUBRUNS): void {
    if (this.subruns.size < limit) return;
    const oldestFinished = [...this.subruns.values()].find(record =>
      record.state === 'completed' || record.state === 'failed' || record.state === 'cancelled');
    if (oldestFinished === undefined) throw new KernelError('subagent_operation_limit');
    this.subruns.delete(oldestFinished.subrunId);
  }

  /** 会话 ID 也必须唯一：初次调用时从目录里已存在的子会话恢复计数。 */
  async nextSessionId(): Promise<string> {
    if (this.counterInitialization === undefined) {
      this.counterInitialization = (async () => {
        let entries;
        try { entries = await readdir(this.directory, { withFileTypes: true }); }
        catch (cause) { throw new KernelError('subagent_session_directory_read_failed', { cause }); }
        const prefix = `${this.parentSessionId}.sub-`;
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith('.jsonl')) continue;
          const suffix = entry.name.slice(prefix.length, -'.jsonl'.length);
          if (!/^\d+$/u.test(suffix)) continue;
          const number = Number(suffix);
          if (Number.isSafeInteger(number)) this.counter = Math.max(this.counter, number);
        }
      })();
    }
    const initialize = this.counterInitialization;
    try { await initialize; }
    catch (cause) {
      if (this.counterInitialization === initialize) this.counterInitialization = undefined;
      throw cause;
    }
    this.counter += 1;
    return `${this.parentSessionId}.sub-${this.counter}`;
  }
}

export interface PersistedSubrunInput {
  readonly directory: string;
  readonly parentSessionId: string;
  readonly subrunId: string;
  readonly parentRunId: string;
  readonly configRoot: string;
  readonly parentSession?: SessionLog | undefined;
}

/** 从磁盘会话重建一个已完成子 Run 的状态；只读，不改变任何运行状态。 */
export async function readPersistedSubrun(input: PersistedSubrunInput): Promise<{
  status: SubrunStatus;
  result: RunResult | undefined;
  turnContext: unknown;
}> {
  const { directory, parentSessionId, subrunId, parentRunId } = input;
  if (input.parentSession === undefined || !subrunId.startsWith(`${parentSessionId}.sub-`)
    || subrunId.length > SESSION_ID_MAX_LENGTH || /[\\/\u0000-\u001f\u007f]/u.test(subrunId)) {
    throw new KernelError('subagent_not_found');
  }
  const child = await readSessionRecord(join(directory, `${subrunId}.jsonl`));
  if (child.header?.sessionId !== subrunId) throw new KernelError('subagent_not_found');
  const acceptance = child.events.find(event => event.kind === 'user' && isRunAcceptance(event.run)
    && event.run.parentage?.sessionId === parentSessionId
    && event.run.parentage.runId === parentRunId && event.run.parentage.subrunId === subrunId)?.run;
  if (!isRunAcceptance(acceptance) || acceptance.parentage === undefined) throw new KernelError('subagent_not_found');
  const receipt = runReceipts(child.events, subrunId).find(item => item.runId === acceptance.runId);
  if (receipt === undefined) throw new KernelError('subagent_not_found');
  const startedAt = Date.parse(acceptance.acceptedAt);
  let result: RunResult | undefined;
  let errorCode: string | undefined;
  if (receipt.resultRef !== undefined) {
    try { result = await readRunResult(directory, workspaceIdentity(input.configRoot), subrunId, receipt); }
    catch (error) {
      errorCode = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
        ? error.code : undefined;
    }
  }
  const terminal = child.events.find(event => event.kind === 'turn' && event.userSeq === receipt.userSeq
    && ['completed', 'failed', 'cancelled', 'interrupted'].includes(String(event.status)));
  const state: SubrunStatus['state'] = receipt.state === 'completed' || receipt.state === 'failed' || receipt.state === 'cancelled'
    ? receipt.state : 'unknown';
  errorCode ??= result?.diagnostic?.code
    ?? (typeof terminal?.code === 'string' ? terminal.code : undefined);
  const status: SubrunStatus = {
    subrunId,
    sessionId: subrunId,
    runId: acceptance.runId,
    parentRunId,
    ...(acceptance.parentage.callId === undefined ? {} : { parentCallId: acceptance.parentage.callId }),
    state,
    phase: null,
    task: null,
    pendingInteractions: { approvals: 0, questions: 0 },
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(result === undefined ? {} : { result: {
      state: result.state,
      textCharacters: result.output.text?.length ?? 0,
      validation: result.validation,
    } }),
    startedAt: Number.isFinite(startedAt) ? startedAt : 0,
    updatedAt: Number.isFinite(startedAt) ? startedAt : 0,
    ...(state === 'completed' || state === 'failed' || state === 'cancelled'
      ? { completedAt: Number.isFinite(startedAt) ? startedAt : 0 } : {}),
  };
  const turnContext = child.events.filter(event => event.kind === 'turnContext' && event.userSeq === receipt.userSeq).at(-1);
  return { status, result, turnContext };
}
