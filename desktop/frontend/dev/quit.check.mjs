// 退出前那一张清单的检查：跑 `node dev/quit.check.mjs`。
// 这里量的是「哪几份会话会被这次退出打断、各说得出为什么」；托盘、隐藏与真收进程那几步走的是壳，读数在真壳那一趟。
import assert from 'node:assert/strict';
import { blockedSessions } from '../src/quit.ts';

// 什么都没有：不画一张空卡片，界面上那一条直接交回退出。
assert.deepEqual(blockedSessions({ running: [], approvals: [], questions: [], queued: {} }), []);
assert.deepEqual(blockedSessions({ running: [], approvals: [], questions: [], queued: { '会话甲': { items: [] } } }), [], '排着零句不算拦住退出');

// 每种事由各说各的：跑着的、等批准的、等回答的、排着句子的。
assert.deepEqual(blockedSessions({ running: ['a'], approvals: [], questions: [], queued: {} }), [{ sessionId: 'a', reasons: ['一轮在跑'] }]);
assert.deepEqual(blockedSessions({ running: [], approvals: ['b'], questions: [], queued: {} }), [{ sessionId: 'b', reasons: ['等一次批准'] }]);
assert.deepEqual(blockedSessions({ running: [], approvals: [], questions: ['c'], queued: {} }), [{ sessionId: 'c', reasons: ['等你回答一道题'] }]);
assert.deepEqual(blockedSessions({ running: [], approvals: [], questions: [], queued: { d: { items: ['一句', '两句'] } } }), [{ sessionId: 'd', reasons: ['排着 2 句没发出去'] }]);

// 同一份会话同时有几件事：并在一行里说完，且这份只出现一次；顺序跟着「先跑着的、再等人的、最后排着的」那一趟。
assert.deepEqual(blockedSessions({ running: ['a', 'b'], approvals: ['b'], questions: ['b'], queued: { b: { items: ['一句'] }, a: { items: ['一句', '两句'] } } }), [
  { sessionId: 'a', reasons: ['一轮在跑', '排着 2 句没发出去'] },
  { sessionId: 'b', reasons: ['一轮在跑', '等一次批准', '等你回答一道题', '排着 1 句没发出去'] },
]);

// 一份会话都不受影响、别的那一份还在跑：后台那份仍然列出来（方案 3.1 与 6.4 都要的是「说得出受影响的是谁」）。
assert.deepEqual(blockedSessions({ running: ['bg'], approvals: [], questions: [], queued: {} }).map((row) => row.sessionId), ['bg']);

console.log('桌面前端的退出清单检查通过');
