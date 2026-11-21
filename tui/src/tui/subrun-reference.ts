// 从会话记录里识别异步子任务的引用：父 Run、子任务 ID、派生会话与 Run。
import type { TuiSubrunReference } from './app.js';
import { isRecord } from './guards.js';
import type { TuiRecord } from './transcript.js';

export function subrunReferenceOf(record: TuiRecord | undefined): TuiSubrunReference | null {
  if (record?.kind !== 'tool' || record.tool !== 'subagent_start') return null;
  const result = isRecord(record.result) ? record.result : undefined;
  const content = isRecord(result?.content) ? result.content : undefined;
  const parentRunId = typeof record.runId === 'string' ? record.runId : content?.parentRunId;
  const subrunId = content?.subrunId;
  const sessionId = content?.sessionId;
  const runId = content?.runId;
  if (typeof parentRunId !== 'string' || typeof subrunId !== 'string' || typeof sessionId !== 'string' || typeof runId !== 'string') return null;
  return { parentRunId, subrunId, sessionId, runId };
}
