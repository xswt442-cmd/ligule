import assert from 'node:assert/strict';
import test from 'node:test';
import { checkLogStatus, parseCheckReport } from '../dist/host/checks.js';
import type { CheckDeclaration } from '../dist/session/checks.js';

const declaration: CheckDeclaration = {
  name: 'tests', purpose: 'check output contract', expectedExitCodes: [0], scope: ['src/example.ts'],
  report: { format: 'ligule-test-report-v1' },
};

function stdout(text: string, { totalBytes, firstAvailableOffset = 0 }: { totalBytes?: number; firstAvailableOffset?: number } = {}) {
  const data = Buffer.from(text, 'utf8');
  return { totalBytes: totalBytes ?? data.length, firstAvailableOffset,
    chunks: [{ sequence: 0, stream: 'stdout' as const, offset: firstAvailableOffset, data }] };
}

test('the declared report line parses only exact versioned counters', () => {
  const report = { schema: 'ligule-test-report', version: 1, passed: 3, failed: 0, skipped: 1, todo: 0 };
  const text = `ordinary output\nLIGULE_TEST_REPORT_V1\t${JSON.stringify(report)}\n`;
  const snapshot = stdout(text);
  assert.equal(checkLogStatus(snapshot), 'complete');
  assert.deepEqual(parseCheckReport(declaration, snapshot, 'complete'), {
    status: 'reported_pass', report: { schema: 'ligule-test-report', version: 1, passed: 3, failed: 0, skipped: 1, todo: 0 },
  });
});

test('missing, repeated, unsupported, and incomplete reports stay unverified', () => {
  const report = { schema: 'ligule-test-report', version: 1, passed: 1, failed: 0, skipped: 0, todo: 0 };
  const line = `LIGULE_TEST_REPORT_V1\t${JSON.stringify(report)}\n`;
  assert.deepEqual(parseCheckReport(declaration, undefined, 'unknown'), { status: 'unverified', reason: 'execution_logs_incomplete' });
  assert.deepEqual(parseCheckReport(declaration, stdout('tests passed\n'), 'complete'), { status: 'unverified', reason: 'report_missing' });
  assert.deepEqual(parseCheckReport(declaration, stdout(line + line), 'complete'), { status: 'unverified', reason: 'report_ambiguous_or_too_large' });
  assert.deepEqual(parseCheckReport(declaration, stdout(line.replace('"version":1', '"version":2')), 'complete'), {
    status: 'unverified', reason: 'report_schema_unsupported',
  });
  const truncated = stdout(line, { totalBytes: Buffer.byteLength(line) + 4, firstAvailableOffset: 4 });
  assert.equal(checkLogStatus(truncated), 'partial');
  assert.deepEqual(parseCheckReport(declaration, truncated, 'partial'), { status: 'unverified', reason: 'execution_logs_incomplete' });
});
