import assert from 'node:assert/strict';
import test from 'node:test';
import { readRunResult } from '../../frontend/src/run-result.ts';

test('run result reader reassembles bounded Host pages and checks their identity', async () => {
  const expected = {
    runId: 'run-1', sessionId: 'session-1', state: 'completed', stopReason: 'assistant_completed',
    output: { text: 'result '.repeat(2_000) }, validation: { status: 'not_requested' },
    artifacts: [], fileChanges: [], checks: [], usage: { iterations: 1, modelCalls: 1 },
  };
  const json = JSON.stringify(expected);
  const calls = [];
  const client = {
    async call(method, params, timeout) {
      calls.push({ method, params, timeout });
      assert.equal(method, 'run.result');
      const offset = params.offset ?? 0;
      const end = Math.min(offset + 8192, json.length);
      return { runId: params.runId, json: json.slice(offset, end), offset,
        nextOffset: end < json.length ? end : null, totalCharacters: json.length };
    },
  };

  assert.deepEqual(await readRunResult(client, '/repo', 'session-1', 'run-1'), expected);
  assert.ok(calls.length > 1, 'a large result is read through multiple Host pages');
  assert.deepEqual(calls.map(call => call.params.offset), calls.map((_, index) => index * 8192));
  assert.ok(calls.every(call => call.timeout === 15_000));
});

test('run result reader rejects a page that changes the requested identity', async () => {
  const client = { call: async (_method, params) => ({ runId: 'other-run', json: '{}', offset: params.offset,
    nextOffset: null, totalCharacters: 2 }) };
  await assert.rejects(readRunResult(client, '/repo', 'session-1', 'run-1'), { code: 'run_result_page_invalid' });
});

test('run result reader rejects a sidecar body for another Session or Run', async () => {
  const other = { runId: 'run-other', sessionId: 'session-other', state: 'completed', stopReason: 'assistant_completed',
    output: { text: 'wrong owner' }, validation: { status: 'not_requested' }, artifacts: [], usage: { iterations: 1, modelCalls: 1 } };
  const json = JSON.stringify(other);
  const client = { call: async (_method, params) => ({ runId: params.runId, json, offset: params.offset,
    nextOffset: null, totalCharacters: json.length }) };
  await assert.rejects(readRunResult(client, '/repo', 'session-1', 'run-1'), { code: 'run_result_response_invalid' });
});
