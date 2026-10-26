import { isFileArtifact, type FileArtifact } from '../session/artifact.js';
import type { TaskBudget } from './task-budget.js';

export interface RunSummary {
  readonly text: string;
  readonly iterations: number;
  readonly modelCalls: number;
  readonly userSeq?: number;
  readonly artifacts?: readonly FileArtifact[];
  readonly task?: ReturnType<TaskBudget['snapshot']>;
}

// Preserve the original error, including frozen errors and cancellation reasons.
const summaries = new WeakMap<object, RunSummary>();
export function rememberRunSummary(error: unknown, summary: RunSummary): void {
  if (typeof error !== 'object' || error === null) return;
  summaries.set(error, Object.freeze({ ...summary,
    ...(summary.artifacts === undefined ? {} : { artifacts: Object.freeze(summary.artifacts.map(item => Object.freeze({ ...item }))) }),
    ...(summary.task === undefined ? {} : { task: Object.freeze({ ...summary.task }) }),
  }));
}

export function runSummary(error: unknown): RunSummary | undefined {
  return typeof error === 'object' && error !== null ? summaries.get(error) : undefined;
}

export function checkedRunSummary(value: unknown): RunSummary {
  if (value === null || typeof value !== 'object') throw new TypeError('run_summary_invalid');
  const item = value as Record<string, unknown>;
  const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  if (typeof item.text !== 'string' || !count(item.iterations) || !count(item.modelCalls)
    || (item.userSeq !== undefined && !count(item.userSeq))
    || (item.artifacts !== undefined && (!Array.isArray(item.artifacts) || item.artifacts.length > 16 || !item.artifacts.every(isFileArtifact)))) {
    throw new TypeError('run_summary_invalid');
  }
  if (item.task !== undefined) {
    if (item.task === null || typeof item.task !== 'object') throw new TypeError('run_summary_invalid');
    const task = item.task as Record<string, unknown>;
    if (!count(task.modelCalls) || !count(task.maxModelCalls) || task.maxModelCalls < 1 || task.modelCalls > task.maxModelCalls
      || !count(task.timeoutMs) || task.timeoutMs < 1 || task.timeoutMs > 86_400_000
      || !count(task.requestTimeoutMs) || task.requestTimeoutMs < 1 || task.requestTimeoutMs > Math.min(task.timeoutMs, 3_600_000)
      || typeof task.startedAt !== 'string' || !Number.isFinite(Date.parse(task.startedAt))
      || typeof task.deadlineAt !== 'string' || !Number.isFinite(Date.parse(task.deadlineAt))) throw new TypeError('run_summary_invalid');
  }
  return { text: item.text, iterations: item.iterations, modelCalls: item.modelCalls,
    ...(item.userSeq === undefined ? {} : { userSeq: item.userSeq as number }),
    ...(item.artifacts === undefined ? {} : { artifacts: item.artifacts as FileArtifact[] }),
    ...(item.task === undefined ? {} : { task: item.task as RunSummary['task'] }),
  };
}
