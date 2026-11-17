import type { Record_ } from './rows';

export type SubrunBranch = {
  readonly seq: number;
  readonly id: string;
  readonly task: string;
  readonly source?: 'human' | 'controller';
  readonly reference?: {
    readonly parentRunId: string;
    readonly subrunId: string;
    readonly runId: string;
  };
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function subrunBranchOf(value: Record_ | Record<string, unknown>): SubrunBranch | null {
  const event = value as unknown as Record<string, unknown>;
  if (event.kind === 'subrunStarted' && event.ignorable === true
    && typeof event.parentRunId === 'string' && typeof event.subrunId === 'string'
    && typeof event.childSessionId === 'string' && typeof event.childRunId === 'string'
    && typeof event.taskLabel === 'string' && (event.source === 'human' || event.source === 'controller')) {
    return {
      seq: typeof event.seq === 'number' ? event.seq : 0,
      id: event.childSessionId,
      task: event.taskLabel,
      source: event.source,
      reference: { parentRunId: event.parentRunId, subrunId: event.subrunId, runId: event.childRunId },
    };
  }
  if (event.kind !== 'tool' || (event.tool !== 'subagent' && event.tool !== 'subagent_start')) return null;
  const result = record(event.result) ? event.result : undefined;
  const content = record(result?.content) ? result.content : undefined;
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
    seq: typeof event.seq === 'number' ? event.seq : 0,
    id,
    task: String(record(event.args) ? event.args.task ?? '' : ''),
    ...(reference === undefined ? {} : { reference }),
  };
}
