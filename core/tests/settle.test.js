import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { SETTLE_GRACE_MS, settleWithin } from '../dist/kernel/settle.js';

test('settle waits for a run that ends on its own', async () => {
  let finished = false;
  const outcome = await settleWithin(delay(20).then(() => { finished = true; }), 5_000);
  assert.equal(outcome, true);
  assert.equal(finished, true);
});

test('settle treats a failed run as settled, so shutdown keeps releasing', async () => {
  const outcome = await settleWithin(Promise.reject(new Error('tool failed')), 5_000);
  assert.equal(outcome, true);
});

test('settle reports a timeout and keeps the process free to continue', async () => {
  let notified = false;
  const started = Date.now();
  const outcome = await settleWithin(delay(5_000), 60, () => { notified = true; });
  assert.equal(outcome, false);
  assert.equal(notified, true);
  assert.ok(Date.now() - started >= 40);
});

test('settle resolves immediately when there is no run to wait for', async () => {
  assert.equal(await settleWithin(undefined), true);
  assert.equal(SETTLE_GRACE_MS, 10_000);
});
