import test from 'node:test';
import assert from 'node:assert/strict';
import { runLivenessOf } from '../dist/host/run-records.js';

// “这一轮还活着吗”只有一个判据：它仍是当前活动 Run，并且真的有一轮在跑。
// 只有 activeRunId 残留（轮次已结束但清理尚未发生）不能被当成活着。

test('a Run is alive only while it is active and a turn is running', () => {
  assert.equal(runLivenessOf({ activeRunId: 'run-1', running: {} }, 'run-1'), true);
  assert.equal(runLivenessOf({ activeRunId: 'run-1', running: undefined }, 'run-1'), false);
  assert.equal(runLivenessOf({ activeRunId: 'run-2', running: {} }, 'run-1'), false);
  assert.equal(runLivenessOf(undefined, 'run-1'), false);
  assert.equal(runLivenessOf({ running: {} }, 'run-1'), false);
});
