// 会话读模型：把已持久化记录投影成客户端可见的页，并保留分页、完整结果与范围状态的事实版本。
// 打开中的会话与已保存记录使用同一响应结构；这里不写入记录，也不推断未记录的状态。
import { access } from 'node:fs/promises';
import { KernelError } from '../kernel/error.js';
import type { SessionEvent, SessionHeader } from '../session/format.js';
import { foldLabel } from '../session/format.js';
import { createSessionLog, type SessionLog } from '../session/session.js';
import { effectiveCheckScopeStatus } from '../session/run-evidence.js';

export type SessionReadParams = { readonly fullResults?: boolean; readonly limit?: number; readonly before?: number; readonly at?: number };

export type SessionPage = {
  readonly sessionId: string;
  readonly events: readonly SessionEvent[];
  readonly header: SessionHeader | null;
  readonly provisionalOutput: Awaited<ReturnType<SessionLog['readProvisionalOutput']>> | null;
  readonly provisionalOutputError: string | null;
  readonly label: ReturnType<typeof foldLabel>;
  readonly endSeq: number | null;
  readonly hasMore: boolean;
};

type FillSpills = (events: SessionEvent[], env: { readonly directory: string }) => Promise<SessionEvent[]>;

export async function readForClient(
  session: SessionLog,
  sessionId: string,
  { fullResults, limit, before, at }: SessionReadParams,
  deps: { readonly env: { readonly directory: string }; readonly fillSpills: FillSpills },
): Promise<SessionPage> {
  const events = await session.read();
  const header = await session.header();
  let provisionalOutput: SessionPage['provisionalOutput'] = null;
  let provisionalOutputError: string | null = null;
  try { provisionalOutput = await session.readProvisionalOutput(events); }
  catch (error) {
    if (!(error instanceof KernelError) || error.code !== 'session_stream_invalid') throw error;
    provisionalOutputError = error.code;
  }
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
  // 检查记录里的范围状态是写入当时的快照；客户端要看到的是此刻的事实。
  // 结论基于完整事件流而不是当前页，因此分页不会让一条已过期检查重新显示为有效。
  const projected = new Map<number, SessionEvent>();
  for (const event of events) {
    projected.set(event.seq, event.kind === 'check' && typeof event.runId === 'string'
      ? { ...event, scopeStatus: effectiveCheckScopeStatus(events, event.runId, event) }
      : event);
  }
  const visible = page.map((event) => projected.get(event.seq) ?? event);
  return {
    sessionId,
    events: fullResults ? await deps.fillSpills(visible, deps.env) : visible,
    header: header ?? null,
    provisionalOutput,
    provisionalOutputError,
    label: foldLabel(events),
    endSeq: page.at(-1)?.seq ?? null,
    hasMore: page.length > 0 && page[0]!.seq > 1,
  };
}

export type SessionReadDeps = {
  readonly opened: (id: string) => { readonly session: SessionLog; readonly environment: { readonly directory: string } } | undefined;
  readonly defaultEnvironment: { readonly directory: string };
  readonly branchOwner: (id: string) => string | undefined;
  readonly assertSessionId: (id: unknown) => asserts id is string;
  readonly recordPathOf: (id: string, env: { readonly directory: string }) => string;
  readonly fillSpills: FillSpills;
};

// 打开中的会话从运行时读取，派生会话从已保存记录读取；两者使用相同的响应结构。
export async function readRecordPage(id: string, params: SessionReadParams, deps: SessionReadDeps): Promise<SessionPage> {
  const state = deps.opened(id);
  if (state !== undefined) return await readForClient(state.session, id, params, { env: state.environment, fillSpills: deps.fillSpills });
  // 父轮次结束后，派生会话没有运行时状态，因此从已保存记录读取。
  deps.assertSessionId(id);
  const owner = deps.branchOwner(id);
  if (owner === undefined) throw new KernelError('session_not_open', { detail: id });
  const env = deps.opened(owner)?.environment ?? deps.defaultEnvironment;
  try {
    await access(deps.recordPathOf(id, env));
  } catch {
    throw new KernelError('session_not_found', { detail: id });
  }
  return await readForClient(createSessionLog({ directory: env.directory, id }), id, params, { env, fillSpills: deps.fillSpills });
}
