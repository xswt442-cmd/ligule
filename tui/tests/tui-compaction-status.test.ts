import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCompactionStatus } from '../dist/tui/compaction-status.js';

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
