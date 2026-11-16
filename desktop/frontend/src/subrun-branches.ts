import type { Record_ } from './rows';

export type SubrunBranch = {
  readonly seq: number;
  readonly id: string;
  readonly task: string;
  readonly reference?: {
    readonly parentRunId: string;
    readonly subrunId: string;
    readonly runId: string;
  };
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function subrunBranchOf(event: Record_): SubrunBranch | null {
  if (event.kind !== 'tool' || (event.tool !== 'subagent' && event.tool !== 'subagent_start')) return null;
  const content = record(event.result?.content) ? event.result.content : undefined;
  const id = content?.sessionId ?? (event.tool === 'subagent_start' ? content?.subrunId : undefined);
  if (typeof id !== 'string' || id === '') return null;
  const parentRunId = typeof event.runId === 'string' ? event.runId : content?.parentRunId;
  const subrunId = content?.subrunId;
  const runId = content?.runId;
  const reference = event.tool === 'subagent_start' && typeof parentRunId === 'string'
    && typeof subrunId === 'string' && typeof runId === 'string'
    ? { parentRunId, subrunId, runId }
    : undefined;
  return {
    seq: event.seq ?? 0,
    id,
    task: String(record(event.args) ? event.args.task ?? '' : ''),
    ...(reference === undefined ? {} : { reference }),
  };
}
