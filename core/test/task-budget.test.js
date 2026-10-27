import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { KernelError } from '../dist/kernel/error.js';
import { createTaskBudget } from '../dist/kernel/task-budget.js';
import { createLoop } from '../dist/kernel/loop.js';
import { createKernel } from '../dist/kernel/kernel.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('a Loop forwards its task deadline to the provider without a separate caller signal', async () => {
  const budget = createTaskBudget({ maxModelCalls: 1, timeoutMs: 80, requestTimeoutMs: 50 });
  const keepAlive = setTimeout(() => {}, 1_000);
  const provider = { async *stream(_request, { signal }) {
    await new Promise((resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  } };
  try {
    await assert.rejects(createLoop({ kernel: createKernel(), provider }).run('hello', { task: budget }),
      { code: 'task_deadline_exceeded' });
  } finally { clearTimeout(keepAlive); budget.dispose(); }
});

test('fully blocked interaction pauses execution while accumulating a separate wait budget', async () => {
  const budget = createTaskBudget({ maxModelCalls: 2, timeoutMs: 100, requestTimeoutMs: 80, interactionWaitTimeoutMs: 400 });
  try {
    await budget.runWork(async () => {
      const end = budget.startInteraction();
      await wait(160);
      assert.equal(budget.signal.aborted, false);
      end();
      budget.consumeModelCall();
    });
  } finally { budget.dispose(); }
});

test('other active work keeps the execution deadline running during interaction', async () => {
  const budget = createTaskBudget({ maxModelCalls: 2, timeoutMs: 80, requestTimeoutMs: 50, interactionWaitTimeoutMs: 400 });
  const other = budget.startWork();
  try {
    await budget.runWork(async () => {
      const end = budget.startInteraction();
      await wait(120);
      assert.equal(budget.signal.reason?.code, 'task_deadline_exceeded');
      end();
    });
  } finally { other.dispose(); budget.dispose(); }
});

test('overlapping interactions share one cumulative wait budget across separate waits', async () => {
  const budget = createTaskBudget({ maxModelCalls: 2, timeoutMs: 500, requestTimeoutMs: 100, interactionWaitTimeoutMs: 150 });
  try {
    await Promise.all([budget.runWork(async () => {
      const end = budget.startInteraction();
      await wait(90);
      end();
      await wait(20);
      const endAgain = budget.startInteraction();
      await wait(90);
      endAgain();
    }), budget.runWork(async () => {
      const end = budget.startInteraction();
      await wait(90);
      end();
    })]);
    assert.equal(budget.signal.reason?.code, 'task_interaction_timeout');
  } finally { budget.dispose(); }
});

test('validates limits and allows exactly the configured number of calls', () => {
  assert.throws(() => createTaskBudget({ maxModelCalls: 0, timeoutMs: 50, requestTimeoutMs: 10 }), TypeError);
  assert.throws(() => createTaskBudget({ maxModelCalls: 1, timeoutMs: 5, requestTimeoutMs: 10 }), TypeError);
  const budget = createTaskBudget({ maxModelCalls: 1, timeoutMs: 500, requestTimeoutMs: 100 });
  try {
    budget.consumeModelCall();
    assert.equal(budget.snapshot().modelCalls, 1);
    assert.equal(budget.signal.aborted, false);
    assert.throws(() => budget.consumeModelCall(), (error) => error.code === 'task_model_budget_exhausted');
    assert.equal(budget.signal.reason.code, 'task_model_budget_exhausted');
  } finally { budget.dispose(); }
});

test('concurrent consumers cannot exceed the shared limit and exhaustion stops active requests', async () => {
  const budget = createTaskBudget({ maxModelCalls: 1, timeoutMs: 500, requestTimeoutMs: 200 });
  const request = budget.request();
  try {
    const results = await Promise.all(Array.from({ length: 32 }, async () => {
      await Promise.resolve();
      try { budget.consumeModelCall(); return 'consumed'; }
      catch (error) { return error.code; }
    }));
    assert.equal(results.filter((result) => result === 'consumed').length, 1);
    assert.equal(budget.snapshot().modelCalls, 1);
    assert.equal(budget.signal.aborted, true);
    assert.equal(budget.signal.reason.code, 'task_model_budget_exhausted');
    assert.equal(request.signal.aborted, true);
    assert.equal(request.signal.reason.code, 'task_model_budget_exhausted');
  } finally {
    request.dispose();
    budget.dispose();
  }
});

test('task deadline aborts its signal and rejects later calls', async () => {
  const budget = createTaskBudget({ maxModelCalls: 2, timeoutMs: 20, requestTimeoutMs: 10 });
  await sleep(35);
  assert.equal(budget.signal.aborted, true);
  assert.throws(() => budget.consumeModelCall(), (error) => error instanceof KernelError && error.code === 'task_deadline_exceeded');
  budget.dispose();
});

test('request timeout is local and dispose clears request timers', async () => {
  const budget = createTaskBudget({ maxModelCalls: 2, timeoutMs: 500, requestTimeoutMs: 20 });
  const timed = budget.request();
  await sleep(35);
  assert.equal(timed.signal.aborted, true);
  assert.equal(timed.signal.reason.code, 'task_request_timeout');
  assert.equal(budget.signal.aborted, false);
  timed.dispose();
  const caller = new AbortController();
  const request = budget.request(caller.signal);
  caller.abort(new Error('caller stopped'));
  assert.equal(request.signal.reason.message, 'caller stopped');
  request.dispose();
  budget.dispose();
});

test('parent cancellation reaches task and active provider requests', () => {
  const parent = new AbortController();
  const budget = createTaskBudget({ maxModelCalls: 2, timeoutMs: 500, requestTimeoutMs: 100 }, parent.signal);
  const request = budget.request();
  parent.abort(new Error('parent stopped'));
  assert.equal(budget.signal.aborted, true);
  assert.equal(request.signal.aborted, true);
  assert.throws(() => budget.consumeModelCall(), (error) => error.code === 'task_cancelled');
  request.dispose();
  budget.dispose();
});

test('disposing clears successful task and request timers without aborting signals', async () => {
  const budget = createTaskBudget({ maxModelCalls: 2, timeoutMs: 100, requestTimeoutMs: 80 });
  const request = budget.request();
  budget.dispose();
  await sleep(110);
  assert.equal(budget.signal.aborted, false);
  assert.equal(request.signal.aborted, false);
  assert.throws(() => budget.consumeModelCall(), (error) => error.code === 'task_budget_disposed');
  assert.throws(() => budget.request(), (error) => error.code === 'task_budget_disposed');
});
