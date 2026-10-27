import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { withTuiHost } from './helpers/tui-host.js';

const input = JSON.stringify({ tool: 'ask_user_question', args: {
  questions: JSON.stringify([{ question: 'Continue?', options: [], multiSelect: false }]),
} });

test('Host pauses the execution deadline while a question is the only active work', async () => {
  await withTuiHost(async ({ client, sessionId }) => {
    client.onRequest(async (message) => {
      if (message.method !== 'question.request') return undefined;
      await delay(1_200);
      return { answers: [{ id: 'q1', custom: 'yes' }] };
    });
    const result = await client.request('run.start', { sessionId, input });
    assert.ok(result.runId);
    const { events } = await client.request('session.read', { sessionId });
    assert.equal(events.findLast((event) => event.kind === 'turn')?.status, 'completed');
  }, { interactive: true, config: { loop: { iterations: 2, modelCalls: 2, taskTimeoutMs: 1_000, requestTimeoutMs: 500, interactionWaitTimeoutMs: 3_000 } } });
});

test('Host ends a pending question with a distinct cumulative interaction timeout', async () => {
  await withTuiHost(async ({ client, sessionId }) => {
    client.onRequest((message) => message.method === 'question.request' ? new Promise(() => {}) : undefined);
    await assert.rejects(client.request('run.start', { sessionId, input }), (error) => error.code === 'task_interaction_timeout');
    const { events } = await client.request('session.read', { sessionId });
    const turn = events.findLast((event) => event.kind === 'turn');
    assert.equal(turn?.status, 'failed');
    assert.equal(turn?.code, 'task_interaction_timeout');
  }, { interactive: true, config: { loop: { iterations: 2, modelCalls: 2, taskTimeoutMs: 3_000, requestTimeoutMs: 1_000, interactionWaitTimeoutMs: 150 } } });
});
