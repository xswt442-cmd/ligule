import { tokenCount, type ProviderCacheUsage } from '../session/usage.js';
import type { CompactionBlock } from '../session/checkpoint.js';
import type { SessionEvent } from '../session/format.js';

export const REQUEST_DIAGNOSTIC_LIMIT = 32;
export const REQUEST_DIAGNOSTIC_COMPACTION_BLOCK_LIMIT = 16;

export interface RequestDiagnostic {
  readonly sessionId: string;
  readonly runId: string;
  readonly logicalRequestId: string;
  readonly requestId: string;
  readonly attempt: number;
  readonly provider?: string;
  readonly model?: string;
  readonly preparedAt: string;
  status: 'sending' | 'completed' | 'failed' | 'cancelled';
  readonly components: {
    readonly systemBytes: number;
    readonly systemPrefixBytes: number;
    readonly projectGuideBytes: number;
    readonly dynamicContextBytes: number;
    readonly systemOverheadBytes: number;
    readonly toolSchemaBytes: number;
    readonly historyBytes: number;
    readonly imageReferenceCount: number;
    readonly imageReferenceBytes: number;
    readonly totalRequestBytes: number;
  };
  readonly estimatedInputTokens: number;
  readonly estimateMethod: 'request-v1';
  readonly truncation: {
    readonly promptFragments: number;
    readonly preparationChangedProjection: boolean;
    readonly messagesBeforePreparation: number;
    readonly messagesAfterPreparation: number;
  };
  readonly compaction: {
    readonly summaryUsageScope: 'session_to_date';
    readonly checkpointValidation: 'valid' | 'absent' | 'ignored';
    readonly checkpointValidationReason?: string;
    readonly blocks: readonly {
      readonly blockId: number;
      readonly fromSeq: number;
      readonly toSeq: number;
      readonly summaryBytes: number;
      readonly reason?: string;
    }[];
    readonly omittedBlocks: boolean;
    readonly summaryRequests: number;
    readonly summaryInputTokens: number | null;
    readonly summaryOutputTokens: number | null;
    readonly summaryCachedInputTokens: number | null;
    readonly unknownSummaryInputRequests: number;
    readonly unknownSummaryOutputRequests: number;
    readonly unknownSummaryCacheRequests: number;
    readonly diagnosticsErrorCode?: string;
  };
  resolvedImages: { count: number; bytes: number };
  inputTokens: number | null;
  outputTokens: number | null;
  cache?: ProviderCacheUsage;
  errorCode?: string;
  finishedAt?: string;
}

export interface RequestDiagnosticStore {
  enabled: boolean;
  readonly entries: RequestDiagnostic[];
}

export function emptyRequestCompactionDiagnostics(): RequestDiagnostic['compaction'] {
  return {
    summaryUsageScope: 'session_to_date',
    checkpointValidation: 'absent',
    blocks: [],
    omittedBlocks: false,
    summaryRequests: 0,
    summaryInputTokens: 0,
    summaryOutputTokens: 0,
    summaryCachedInputTokens: 0,
    unknownSummaryInputRequests: 0,
    unknownSummaryOutputRequests: 0,
    unknownSummaryCacheRequests: 0,
  };
}

export function requestCompactionDiagnostics(events: readonly SessionEvent[], blocks: readonly CompactionBlock[], checkpointReason = 'checkpoint_absent'): RequestDiagnostic['compaction'] {
  const reasonByBlock = new Map(events.filter(event => event.kind === 'compaction' && typeof event.blockId === 'number')
    .map(event => [Number(event.blockId), typeof event.reason === 'string' ? event.reason : undefined] as const));
  const summaryUsage = events.filter(event => event.kind === 'usage' && event.source === 'summary');
  const inputValues = summaryUsage.map(event => tokenCount(event.input)).filter((value): value is number => value !== null);
  const outputValues = summaryUsage.map(event => tokenCount(event.output)).filter((value): value is number => value !== null);
  const unknownSummaryInputRequests = summaryUsage.filter(event => tokenCount(event.input) === null).length;
  const unknownSummaryOutputRequests = summaryUsage.filter(event => tokenCount(event.output) === null).length;
  const unknownSummaryCacheRequests = summaryUsage.filter(event => {
    const cache = typeof event.cache === 'object' && event.cache !== null ? event.cache as Record<string, unknown> : undefined;
    return tokenCount(cache?.hitInputTokens) === null;
  }).length;
  const summaryCachedInputTokens = summaryUsage.reduce((sum, event) => {
    const cache = typeof event.cache === 'object' && event.cache !== null ? event.cache as Record<string, unknown> : undefined;
    return sum + (tokenCount(cache?.hitInputTokens) ?? 0);
  }, 0);
  const keptBlocks = blocks.slice(-REQUEST_DIAGNOSTIC_COMPACTION_BLOCK_LIMIT);
  return {
    summaryUsageScope: 'session_to_date',
    checkpointValidation: checkpointReason === '' ? 'valid' : checkpointReason === 'checkpoint_absent' ? 'absent' : 'ignored',
    ...(checkpointReason === '' || checkpointReason === 'checkpoint_absent' ? {} : { checkpointValidationReason: checkpointReason }),
    blocks: keptBlocks.map(block => ({
      blockId: block.blockId,
      fromSeq: block.fromSeq,
      toSeq: block.toSeq,
      summaryBytes: Buffer.byteLength(block.text, 'utf8'),
      ...(reasonByBlock.get(block.blockId) === undefined ? {} : { reason: reasonByBlock.get(block.blockId)! }),
    })),
    omittedBlocks: blocks.length > keptBlocks.length,
    summaryRequests: summaryUsage.length,
    summaryInputTokens: unknownSummaryInputRequests > 0 ? null : inputValues.reduce((sum, value) => sum + value, 0),
    summaryOutputTokens: unknownSummaryOutputRequests > 0 ? null : outputValues.reduce((sum, value) => sum + value, 0),
    summaryCachedInputTokens: unknownSummaryCacheRequests > 0 ? null : summaryCachedInputTokens,
    unknownSummaryInputRequests,
    unknownSummaryOutputRequests,
    unknownSummaryCacheRequests,
  };
}

export function createRequestDiagnosticStore(): RequestDiagnosticStore {
  return { enabled: false, entries: [] };
}

export function appendRequestDiagnostic(store: RequestDiagnosticStore, entry: RequestDiagnostic): void {
  if (!store.enabled) return;
  store.entries.push(entry);
  while (store.entries.length > REQUEST_DIAGNOSTIC_LIMIT) store.entries.shift();
}

export function requestDiagnosticSnapshot(store: RequestDiagnosticStore) {
  return { enabled: store.enabled, entries: structuredClone(store.entries) };
}

export function configureRequestDiagnostics(store: RequestDiagnosticStore, enabled: boolean) {
  store.enabled = enabled;
  if (!enabled) store.entries.length = 0;
  return requestDiagnosticSnapshot(store);
}
