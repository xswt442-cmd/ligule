// 崩溃留下的那一段（D72、D79）：助手那一轮已经带着一次工具调用，记录里却没有对得上的结果。
// 这一格既不是失败也不是取消——派发意图可靠地记下来了，外部副作用做没做、做了几次不知道。
// 补出来的是一条正常的工具结果：交付方要的配对关系仍然成立，模型看得见的是「结果未知」这一句本身。
import type { PendingSessionEvent, SessionEvent } from './format.js';

export interface UnresolvedCall {
  tool: string;
  callId: string;
  args: unknown;
  // 补出来的那一条要指回它补的是哪一次派发（D72）。
  assistantSeq: number;
}

const OUTCOME_UNKNOWN = 'tool_outcome_unknown';

// 两种说法只在一件事上分开：这一件工具在本机这一侧改不改东西。
// 只读的可以按需重做；可能改了外部状态的要先看现状，别把一个副作用做成两个。
const TEXT_READ_ONLY = 'This call was dispatched, but no result was recorded before the run ended. '
  + 'This tool does not change anything on this machine, so run it again if the answer is still needed.';
const TEXT_MAY_CHANGE = 'This call was dispatched, but no result was recorded before the run ended, '
  + 'so its external effect may or may not have happened. Do not repeat it: read the current state first '
  + '(the file, the directory, the target) and only then decide whether to run it again.';

// 记录里的每一条工具结果都带着那一次调用的 `callId`，所以配对关系读得出来；
// 一次助手事件里的调用没有结果，就是这一次运行留下的开放尾巴。
export function findUnresolvedCalls(events: SessionEvent[]): UnresolvedCall[] {
  const answered = new Set(
    events.filter((event) => event.kind === 'tool').map((event) => String(event.callId)),
  );
  const unresolved: UnresolvedCall[] = [];
  for (const event of events) {
    if (event.kind !== 'assistant') continue;
    const calls = Array.isArray(event.toolCalls) ? event.toolCalls as { id?: unknown; name?: unknown; args?: unknown }[] : [];
    for (const call of calls) {
      if (typeof call.id !== 'string' || answered.has(call.id)) continue;
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

// turnContext、未答复的助手调用和尾部没有助手答复的 user 都能证明一轮已经开始。
// 没有这些证据的旧记录保持原样，避免把旧版已完成轮次补成中断。
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
      // 这一格是给界面与排错看的：那一次派发是哪条助手事件，补的是不是可以重做（D72）。
      recovery: { assistantSeq: call.assistantSeq, safeToRedo },
    };
  });
}

export interface RepairSession {
  read(): Promise<SessionEvent[]>;
  append(event: PendingSessionEvent): Promise<SessionEvent>;
}

// 补只补一次：第二次再扫的时候那些调用已经各自有了结果这一条，一个都不会再补——幂等是这么来的，
// 不需要额外的标记（D72）。可写的恢复路径才调这一条；读的那几处（`session.read`、界面、列表）报告缺口而不改盘。
export async function repairUnresolvedCalls(
  session: RepairSession,
  { readOnly }: { readOnly: Set<string> },
): Promise<SessionEvent[]> {
  const events = await session.read();
  const unresolved = findUnresolvedCalls(events);
  const appended: SessionEvent[] = [];
  for (const event of buildRepairEvents(unresolved, { readOnly })) appended.push(await session.append(event));
  for (const userSeq of findUnfinishedTurns(events)) {
    await session.append({ kind: 'turn', ignorable: true, status: 'interrupted', userSeq, code: 'host_restarted' });
  }
  return appended;
}
