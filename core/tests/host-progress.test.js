import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { withTuiHost, waitFor } from './helpers/tui-host.js';

test('status and notifications expose phase changes, approval waits, counts, and idle cleanup per session', async () => {
  await withTuiHost(async ({ client, sessionId, notifications }) => {
    const run = client.request('run.start', { sessionId, input: 'wait for the model' });
    await waitFor(() => notifications.some((message) => message.notify === 'progress' && message.progress?.phase === 'model_request'));
    const duringRequest = await client.request('status.get', { sessionId });
    assert.equal(duringRequest.running, true);
    assert.equal(duringRequest.progress.phase, 'model_request');
    assert.equal(duringRequest.progress.modelCalls, 1);
    assert.equal(duringRequest.outputTokens, 8192);
    await run;
    const settled = await client.request('status.get', { sessionId });
    assert.equal(settled.running, false);
    assert.equal(settled.progress, null);

    await client.request('mode.set', { sessionId, name: 'full' });
    let question;
    client.onRequest((message) => {
      if (message.method === 'question.request') question = message;
    });
    const questions = JSON.stringify([{ question: 'Continue?', options: [], multiSelect: false }]);
    const waiting = client.request('run.start', {
      sessionId,
      input: JSON.stringify({ tool: 'ask_user_question', args: { questions } }),
    });
    await waitFor(() => question !== undefined
      && notifications.some((message) => message.notify === 'progress' && message.sessionId === sessionId && message.progress?.phase === 'awaiting_input'));
    const awaiting = await client.request('status.get', { sessionId });
    assert.equal(awaiting.progress.phase, 'awaiting_input');
    assert.equal(awaiting.progress.modelCalls, 1);
    assert.equal(awaiting.progress.toolCalls, 1);
    client.reply(question.id, { answers: [{ id: 'q1', custom: 'continue' }] });
    await waiting;
    assert.equal((await client.request('status.get', { sessionId })).progress, null);
    assert.ok(notifications.some((message) => message.notify === 'progress' && message.progress?.phase === 'tool_execution'));
    assert.ok(notifications.some((message) => message.notify === 'progress' && message.progress?.phase === 'settling'));
  }, { delayMs: 250, interactive: true });
});

test('progress snapshots stay attached to their own session when runs overlap and the foreground switches', async () => {
  await withTuiHost(async ({ client, sessionId: sessionA, notifications }) => {
    const { sessionId: sessionB } = await client.request('session.create', {});
    const runA = client.request('run.start', { sessionId: sessionA, input: 'session A' });
    await waitFor(() => notifications.some((message) => message.notify === 'progress' && message.sessionId === sessionA && message.progress?.phase === 'model_request'));
    await delay(100);
    const runB = client.request('run.start', { sessionId: sessionB, input: 'session B' });
    await waitFor(() => notifications.some((message) => message.notify === 'progress' && message.sessionId === sessionB && message.progress?.phase === 'model_request'));

    const duringA = await client.request('status.get', { sessionId: sessionA });
    const duringB = await client.request('status.get', { sessionId: sessionB });
    assert.equal(duringA.running, true);
    assert.equal(duringB.running, true);
    assert.equal(duringA.progress.modelCalls, 1);
    assert.equal(duringB.progress.modelCalls, 1);

    await runA;
    const afterA = await client.request('status.get', { sessionId: sessionA });
    const stillRunningB = await client.request('status.get', { sessionId: sessionB });
    assert.equal(afterA.progress, null);
    assert.equal(stillRunningB.running, true);
    assert.equal(stillRunningB.progress.phase, 'model_request');
    await runB;
    assert.equal((await client.request('status.get', { sessionId: sessionB })).progress, null);
  }, { delayMs: 600 });
});

test('cancellation clears the active phase after the single terminal is persisted', async () => {
  await withTuiHost(async ({ client, sessionId, notifications }) => {
    const running = client.request('run.start', { sessionId, input: 'cancel during model request' });
    await waitFor(() => notifications.some((message) => message.notify === 'progress' && message.progress?.phase === 'model_request'));
    await client.request('run.cancel', { sessionId });
    await assert.rejects(running, (error) => ['provider_cancelled', 'loop_cancelled'].includes(error.code));
    const status = await client.request('status.get', { sessionId });
    assert.equal(status.running, false);
    assert.equal(status.progress, null);
    const events = await client.request('session.read', { sessionId });
    assert.equal(events.events.filter((event) => event.kind === 'turn').length, 1);
    assert.equal(events.events.find((event) => event.kind === 'turn').status, 'cancelled');
  }, { delayMs: 1000 });
});
