import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { KernelError } from '../dist/kernel/error.js';
import { createTaskBudget } from '../dist/kernel/task-budget.js';

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
