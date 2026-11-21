// 从会话记录里识别有限命令的 executionId 与所属 runId；执行视图和 /exec 共用这一判定。
import type { TuiExecutionReference } from './app.js';
import { isRecord } from './guards.js';
import type { TuiRecord } from './transcript.js';

export function executionReferenceOf(record: TuiRecord | undefined): TuiExecutionReference | null {
  if (record?.kind !== 'execution' && (record?.kind !== 'tool' || record.tool !== 'exec')) return null;
  const result = isRecord(record.result) ? record.result : undefined;
  const content = record.kind === 'execution'
    ? record
    : isRecord(result?.content) ? result.content : undefined;
  const executionId = content?.executionId;
  const runId = typeof record.runId === 'string' ? record.runId : content?.runId;
  if (typeof executionId !== 'string' || typeof runId !== 'string') return null;
  return { executionId, runId };
}
