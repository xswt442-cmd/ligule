import type { Client } from './protocol';
import { object } from './guards.ts';

const PAGE_CHARACTERS = 8_192;
const MAX_RESULT_CHARACTERS = 16 * 1024 * 1024;

export type RunResultView = {
  readonly runId: string;
  readonly sessionId: string;
  readonly state: 'completed' | 'failed' | 'cancelled';
  readonly stopReason: string;
  readonly output: { readonly text: string | null; readonly structured?: unknown; readonly partial?: true };
  readonly validation: { readonly status: 'not_requested' | 'valid' | 'invalid'; readonly schemaDigest?: string; readonly errors?: readonly string[] };
  readonly artifacts: readonly Record<string, unknown>[];
  readonly artifactsTruncated?: true;
  readonly fileChanges?: readonly Record<string, unknown>[];
  readonly fileChangesTruncated?: true;
  readonly checks?: readonly Record<string, unknown>[];
  readonly checksTruncated?: true;
  readonly usage: { readonly iterations: number | null; readonly modelCalls: number | null };
  readonly diagnostic?: { readonly code: string; readonly provider?: Record<string, unknown> };
};

function failure(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function checkedRunResult(value: unknown, sessionId: string, runId: string): RunResultView {
  if (!object(value) || value.sessionId !== sessionId || value.runId !== runId
    || !['completed', 'failed', 'cancelled'].includes(String(value.state))
    || typeof value.stopReason !== 'string' || !object(value.output) || !(value.output.text === null || typeof value.output.text === 'string')
    || !object(value.validation) || !['not_requested', 'valid', 'invalid'].includes(String(value.validation.status))
    || !Array.isArray(value.artifacts) || !object(value.usage)
    || !(value.usage.iterations === null || Number.isSafeInteger(value.usage.iterations))
    || !(value.usage.modelCalls === null || Number.isSafeInteger(value.usage.modelCalls))
    || (value.fileChanges !== undefined && !Array.isArray(value.fileChanges))
    || (value.checks !== undefined && !Array.isArray(value.checks))) {
    throw failure('run_result_response_invalid');
  }
  return value as unknown as RunResultView;
}

/** Read one immutable RunResult through the Host's existing bounded JSON page interface. */
export async function readRunResult(client: Client, projectRoot: string, sessionId: string, runId: string): Promise<RunResultView> {
  let offset = 0;
  let totalCharacters: number | undefined;
  const pages: string[] = [];
  for (let pageNumber = 0; pageNumber < MAX_RESULT_CHARACTERS / PAGE_CHARACTERS; pageNumber += 1) {
    const raw = await client.call('run.result', { projectRoot, sessionId, runId, offset }, 15_000);
    if (!object(raw) || raw.runId !== runId || raw.offset !== offset || typeof raw.json !== 'string'
      || !Number.isSafeInteger(raw.totalCharacters) || Number(raw.totalCharacters) <= 0
      || Number(raw.totalCharacters) > MAX_RESULT_CHARACTERS
      || (raw.nextOffset !== null && (!Number.isSafeInteger(raw.nextOffset) || Number(raw.nextOffset) <= offset))) {
      throw failure('run_result_page_invalid');
    }
    if (totalCharacters !== undefined && totalCharacters !== raw.totalCharacters) throw failure('run_result_page_invalid');
    totalCharacters = Number(raw.totalCharacters);
    const nextOffset = raw.nextOffset === null ? null : Number(raw.nextOffset);
    const expectedLength = nextOffset === null ? totalCharacters - offset : nextOffset - offset;
    if (raw.json.length !== expectedLength || nextOffset !== null && nextOffset !== Math.min(offset + PAGE_CHARACTERS, totalCharacters)) {
      throw failure('run_result_page_invalid');
    }
    pages.push(raw.json);
    if (nextOffset === null) {
      if (offset + raw.json.length !== totalCharacters) throw failure('run_result_page_invalid');
      try { return checkedRunResult(JSON.parse(pages.join('')), sessionId, runId); }
      catch (cause) {
        if (cause instanceof Error && 'code' in cause && cause.code === 'run_result_response_invalid') throw cause;
        throw failure('run_result_response_invalid');
      }
    }
    offset = nextOffset;
  }
  throw failure('run_result_page_limit');
}
