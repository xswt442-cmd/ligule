import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { appendRequestDiagnostic, configureRequestDiagnostics, createRequestDiagnosticStore, requestCompactionDiagnostics, requestDiagnosticSnapshot, REQUEST_DIAGNOSTIC_LIMIT } from '../dist/kernel/request-diagnostics.js';
import { withTuiHost } from './helpers/tui-host.ts';

test('compaction diagnostic totals remain unknown when any summary request usage is unreported', () => {
  const diagnostic = requestCompactionDiagnostics([
    { seq: 1, kind: 'usage', source: 'summary', input: 10, output: 4, cache: { hitInputTokens: 3 } },
    { seq: 2, kind: 'usage', source: 'summary', input: null, output: 2, cache: null },
  ], [], '');

  assert.equal(diagnostic.summaryRequests, 2);
  assert.equal(diagnostic.summaryInputTokens, null);
  assert.equal(diagnostic.summaryOutputTokens, 6);
  assert.equal(diagnostic.summaryCachedInputTokens, null);
  assert.equal(diagnostic.unknownSummaryInputRequests, 1);
  assert.equal(diagnostic.unknownSummaryOutputRequests, 0);
  assert.equal(diagnostic.unknownSummaryCacheRequests, 1);
});

test('request diagnostics are opt-in, describe the sent request, and omit prompt content', { timeout: 20_000 }, async () => {
  await withTuiHost(async ({ client, sessionId, sessionDirectory, providerRequests }) => {
    const disabled = await client.request('usage.diagnostics', { sessionId, action: 'read' }) as {
      enabled: boolean; entries: unknown[];
    };
    assert.deepEqual(disabled, { enabled: false, entries: [] });

    const enabled = await client.request('usage.diagnostics', { sessionId, action: 'enable' }) as { enabled: boolean };
    assert.equal(enabled.enabled, true);
    await client.request('run.start', { sessionId, input: 'PRIVATE_REQUEST_INPUT_MARKER' });

    const diagnostic = await client.request('usage.diagnostics', { sessionId, action: 'read' }) as {
      enabled: boolean;
      entries: Record<string, unknown>[];
    };
    assert.equal(diagnostic.enabled, true);
    assert.equal(diagnostic.entries.length, 1);
    const entry = diagnostic.entries[0]!;
    assert.equal(entry.sessionId, sessionId);
    assert.equal(typeof entry.runId, 'string');
    assert.equal(typeof entry.logicalRequestId, 'string');
    assert.equal(entry.attempt, 1);
    assert.equal(entry.status, 'completed');
    assert.ok(Number(entry.estimatedInputTokens) > 0);
    assert.equal(entry.estimateMethod, 'request-v1');
    assert.equal(typeof (entry.components as Record<string, unknown>).systemBytes, 'number');
    assert.equal(typeof (entry.components as Record<string, unknown>).toolSchemaBytes, 'number');
    assert.equal(typeof (entry.components as Record<string, unknown>).historyBytes, 'number');
    assert.equal(typeof entry.compaction, 'object');
    assert.equal((entry.compaction as Record<string, unknown>).checkpointValidation, 'absent');
    assert.equal(typeof entry.inputTokens, 'number');
    assert.equal(typeof entry.outputTokens, 'number');
    assert.equal(JSON.stringify(entry).includes('PRIVATE_REQUEST_INPUT_MARKER'), false);
    assert.equal(providerRequests.length, 1);

    const events = await client.request('session.read', { sessionId }) as { events: Record<string, unknown>[] };
    const usage = events.events.findLast((event) => event.kind === 'usage');
    assert.equal(entry.inputTokens, usage?.input, 'reported usage is the same one persisted for this request');
    assert.equal(entry.outputTokens, usage?.output);

    const disabledAgain = await client.request('usage.diagnostics', { sessionId, action: 'disable' }) as {
      enabled: boolean; entries: unknown[];
    };
    assert.deepEqual(disabledAgain, { enabled: false, entries: [] });
    const sessionRecord = await readFile(join(sessionDirectory, `${sessionId}.jsonl`), 'utf8');
    assert.equal(sessionRecord.includes('PRIVATE_REQUEST_INPUT_MARKER'), true, 'the Session itself remains authoritative');
    assert.equal(sessionRecord.includes('requestDiagnostic'), false, 'diagnostic counts are not persisted in Session JSONL');
  }, {
    permissionControl: true,
    config: { policy: { mode: 'auto' }, prompt: { static: 'REQUEST_DIAGNOSTIC_STATIC_PREFIX' } },
    testDirectory: 'testplace/tmp',
  });
});

test('request diagnostic access requires the trusted local UI channel', async () => {
  await withTuiHost(async ({ client, sessionId }) => {
    await assert.rejects(client.request('usage.diagnostics', { sessionId, action: 'read' }), {
      code: 'request_diagnostics_trusted_ui_required',
    });
  });
});

test('request diagnostic retention is bounded and disabling clears the in-memory entries', () => {
  const store = createRequestDiagnosticStore();
  const first = {
    sessionId: 'session', runId: 'run', logicalRequestId: 'logical', requestId: 'request-0', attempt: 1,
    preparedAt: new Date(0).toISOString(), status: 'sending' as const,
    components: { systemBytes: 0, systemPrefixBytes: 0, projectGuideBytes: 0, dynamicContextBytes: 0,
      systemOverheadBytes: 0, toolSchemaBytes: 0, historyBytes: 0, imageReferenceCount: 0,
      imageReferenceBytes: 0, totalRequestBytes: 0 },
    estimatedInputTokens: 0, estimateMethod: 'request-v1' as const,
    truncation: { promptFragments: 0, preparationChangedProjection: false, messagesBeforePreparation: 0, messagesAfterPreparation: 0 },
    compaction: { summaryUsageScope: 'session_to_date' as const, checkpointValidation: 'absent' as const, blocks: [], omittedBlocks: false,
      summaryRequests: 0, summaryInputTokens: 0, summaryOutputTokens: 0, summaryCachedInputTokens: 0,
      unknownSummaryInputRequests: 0, unknownSummaryOutputRequests: 0, unknownSummaryCacheRequests: 0 },
    resolvedImages: { count: 0, bytes: 0 }, inputTokens: null, outputTokens: null,
  };
  appendRequestDiagnostic(store, { ...first, requestId: 'disabled' });
  assert.equal(requestDiagnosticSnapshot(store).entries.length, 0);
  configureRequestDiagnostics(store, true);
  for (let index = 0; index < REQUEST_DIAGNOSTIC_LIMIT + 3; index += 1) {
    appendRequestDiagnostic(store, { ...first, requestId: `request-${index}` });
  }
  const snapshot = requestDiagnosticSnapshot(store);
  assert.equal(snapshot.entries.length, REQUEST_DIAGNOSTIC_LIMIT);
  assert.equal(snapshot.entries[0]?.requestId, 'request-3');
  configureRequestDiagnostics(store, false);
  assert.deepEqual(requestDiagnosticSnapshot(store), { enabled: false, entries: [] });
});
