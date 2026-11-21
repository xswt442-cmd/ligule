import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCompactionStatus, compactionStartAllowed, queueShouldSend } from '../dist/tui/compaction-status.js';

test('a stale compaction status response cannot overwrite a newer running state', () => {
  // 请求发出时 generation=3，读取期间轮次结束使 generation 变为 4。
  assert.deepEqual(applyCompactionStatus(3, 4, { running: true }), { apply: false });
  assert.deepEqual(applyCompactionStatus(3, 4, { running: false }), { apply: false });
});

test('a failed status read leaves the running state untouched', () => {
  assert.deepEqual(applyCompactionStatus(3, 3, null), { apply: false });
});

test('a fresh status response applies idle and running states', () => {
  assert.deepEqual(applyCompactionStatus(3, 3, { running: false }), { apply: true, running: false });
  assert.deepEqual(applyCompactionStatus(3, 3, { running: true }), { apply: true, running: true });
});

test('the queue pauses while compaction holds the session', () => {
  assert.equal(queueShouldSend({ running: false, compacting: true, paused: false, pending: 1 }), false);
  assert.equal(queueShouldSend({ running: true, compacting: false, paused: false, pending: 1 }), false);
  assert.equal(queueShouldSend({ running: false, compacting: false, paused: false, pending: 1 }), true);
  assert.equal(queueShouldSend({ running: false, compacting: false, paused: true, pending: 1 }), false);
  assert.equal(queueShouldSend({ running: false, compacting: false, paused: false, pending: 0 }), false);
});

test('a second compaction is refused while the first is still running', () => {
  assert.equal(compactionStartAllowed(true), false);
  assert.equal(compactionStartAllowed(false), true);
});
