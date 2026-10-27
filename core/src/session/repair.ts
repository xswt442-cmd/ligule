// 进程异常结束后，记录可能包含工具调用，却没有对应结果。
// 此时无法确认外部副作用是否发生，也无法安全重放调用。
// 恢复时补写普通工具结果，明确说明调用结果未知，并保持请求与结果配对。
import type { PendingSessionEvent, SessionEvent } from './format.js';
import { isRunAcceptance } from './run.js';

export interface UnresolvedCall {
  tool: string;
  callId: string;
  args: unknown;
  // 记录被补写结果所对应的原始调用 ID。
  assistantSeq: number;
}

const OUTCOME_UNKNOWN = 'tool_outcome_unknown';

// 根据工具是否可能改变外部状态，选择相应的恢复说明。
// 只读调用可安全重试；可能产生副作用的调用需先检查实际状态。
const TEXT_READ_ONLY = 'This call was dispatched, but no result was recorded before the run ended. '
  + 'This tool does not change anything on this machine, so run it again if the answer is still needed.';
const TEXT_MAY_CHANGE = 'This call was dispatched, but no result was recorded before the run ended, '
  + 'so its external effect may or may not have happened. Do not repeat it: read the current state first '
  + '(the file, the directory, the target) and only then decide whether to run it again.';

// 工具结果通过 `callId` 关联其调用；助手事件中没有结果的调用属于未完成尾部。
export function findUnresolvedCalls(events: SessionEvent[]): UnresolvedCall[] {
  const unresolved: UnresolvedCall[] = [];
  for (const event of events) {
    if (event.kind === 'tool') {
      const index = unresolved.findIndex((call) => call.callId === event.callId);
      if (index >= 0) unresolved.splice(index, 1);
      continue;
    }
    if (event.kind !== 'assistant') continue;
    const calls = Array.isArray(event.toolCalls) ? event.toolCalls as { id?: unknown; name?: unknown; args?: unknown }[] : [];
    for (const call of calls) {
      if (typeof call.id !== 'string') continue;
      unresolved.push({
        tool: typeof call.name === 'string' ? call.name : '',
        callId: call.id,
        args: call.args,
        assistantSeq: event.seq,
      });
    }
  }
  return unresolved;
}

// `turnContext`、未完成工具调用或没有后续助手答复的用户事件都可证明轮次已开始。
// 缺少这些证据时保持旧记录不变，避免误报已完成轮次。
function findUnfinishedTurns(events: SessionEvent[]): number[] {
  const users = events.filter((event) => event.kind === 'user' && Number.isInteger(event.seq));
  const userSeqs = new Set(users.map((event) => Number(event.seq)));
  const started = new Set<number>();
  const terminal = new Set<number>();
  let latestUserSeq: number | undefined;
  for (const event of events) {
    if (event.kind === 'user' && Number.isInteger(event.seq)) {
      latestUserSeq = Number(event.seq);
    } else if (event.kind === 'turnContext' && Number.isInteger(event.userSeq) && userSeqs.has(Number(event.userSeq))) {
      started.add(Number(event.userSeq));
    } else if (event.kind === 'turn') {
      if (Number.isInteger(event.userSeq)) terminal.add(Number(event.userSeq));
      else if (latestUserSeq !== undefined) terminal.add(latestUserSeq);
    }
  }
  const lastUser = users.at(-1);
  if (lastUser !== undefined
    && !events.some((event) => event.kind === 'assistant' && Number(event.seq) > Number(lastUser.seq))) {
    started.add(Number(lastUser.seq));
  }
  for (const user of users) {
    if (isRunAcceptance(user.run)) started.add(Number(user.seq));
  }
  for (const call of findUnresolvedCalls(events)) {
    const user = users.filter((event) => Number(event.seq) < call.assistantSeq).at(-1);
    if (user !== undefined) started.add(Number(user.seq));
  }
  return [...started].filter((userSeq) => !terminal.has(userSeq));
}

export function buildRepairEvents(
  unresolved: UnresolvedCall[],
  { readOnly }: { readOnly: Set<string> },
): PendingSessionEvent[] {
  return unresolved.map((call) => {
    const safeToRedo = readOnly.has(call.tool);
    return {
      kind: 'tool',
      tool: call.tool,
      callId: call.callId,
      args: call.args,
      result: {
        content: safeToRedo ? TEXT_READ_ONLY : TEXT_MAY_CHANGE,
        failed: true,
        code: OUTCOME_UNKNOWN,
        reason: safeToRedo ? 'dispatched without a recorded result; this tool reads only' : 'dispatched without a recorded result; its effect may have landed',
      },
      // 标记对应的助手事件和工具是否可以安全重试，供界面与诊断使用。
      recovery: { assistantSeq: call.assistantSeq, safeToRedo },
    };
  });
}

export interface RepairSession {
  read(): Promise<SessionEvent[]>;
  append(event: PendingSessionEvent): Promise<SessionEvent>;
}

// 已有结果的调用不会重复补写，因此恢复操作是幂等的。
// 仅可写恢复流程会调用此函数；`session.read`、界面和列表只报告缺口，不修改记录。
export async function repairUnresolvedCalls(
  session: RepairSession,
  { readOnly }: { readOnly: Set<string> },
): Promise<SessionEvent[]> {
  const events = await session.read();
  const unresolved = findUnresolvedCalls(events);
  const appended: SessionEvent[] = [];
  for (const event of buildRepairEvents(unresolved, { readOnly })) appended.push(await session.append(event));
  for (const userSeq of findUnfinishedTurns(events)) {
    const user = events.find(event => event.kind === 'user' && event.seq === userSeq);
    await session.append({ kind: 'turn', ignorable: true, status: 'interrupted', userSeq,
      ...(isRunAcceptance(user?.run) ? { runId: user.run.runId } : {}), code: 'host_restarted' });
  }
  return appended;
}
