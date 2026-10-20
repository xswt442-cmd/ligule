import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createControl } from '../dist/host/control.js';

const testplace = resolve('testplace');

test('await waits on the active run, returns the result once complete, and can time out without cancelling it', async () => {
  await mkdir(testplace, { recursive: true });
  const directory = await mkdtemp(join(testplace, 'control-await-'));
  await (async () => {
    let finishRun;
    let runCalls = 0;
    const host = {
      async handle({ method }) {
        if (method === 'session.create') return { sessionId: 'await-session' };
        if (method === 'run.start') {
          runCalls += 1;
          return new Promise((resolve) => { finishRun = resolve; });
        }
        throw new Error(`unexpected host method: ${method}`);
      },
      async release() {},
    };
    const control = createControl(host, directory);
    try {
      const { sessionId } = await control.create(directory);
      const started = control.start(sessionId, 'finish the task');
      const timedOut = await control.await(started.operationId, 1);
      assert.equal(timedOut.state, 'running');
      assert.equal(timedOut.timedOut, true);
      assert.equal(timedOut.result, null);

      const waiting = control.await(started.operationId, 5_000);
      finishRun({ text: 'Task complete', iterations: 3, modelCalls: 2 });
      const completed = await waiting;
      assert.equal(completed.state, 'done');
      assert.equal(completed.timedOut, false);
      assert.equal(completed.result.state, 'completed');
      assert.equal(completed.result.stopReason, 'assistant_completed');
      assert.deepEqual(completed.result.output, { text: 'Task complete' });
      assert.deepEqual(completed.result.usage, { iterations: 3, modelCalls: 2 });
      assert.deepEqual(completed.result.artifacts, [{ kind: 'session', sessionId }]);
      assert.equal(runCalls, 1);

      const repeated = await control.await(started.operationId, 0);
      assert.deepEqual(repeated.result, completed.result);
      assert.equal(runCalls, 1);
    } finally {
      await control.release();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test('await rejects unknown operations and invalid wait bounds', async () => {
  await mkdir(testplace, { recursive: true });
  const directory = await mkdtemp(join(testplace, 'control-await-'));
  await (async () => {
    const control = createControl({ async release() {} }, directory);
    try {
      await assert.rejects(control.await('missing', 1), { code: 'operation_not_found' });
      await assert.rejects(control.await('missing', -1), { code: 'control_wait_timeout_invalid' });
    } finally {
      await control.release();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
