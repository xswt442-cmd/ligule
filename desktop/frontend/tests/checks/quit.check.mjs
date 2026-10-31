// 检查退出提示是否列出所有会被退出操作影响的会话及原因。
import assert from 'node:assert/strict';
import { blockedSessions } from '../../src/quit.ts';

// 没有运行中或待处理的内容时，不应阻止退出。
assert.deepEqual(blockedSessions({ running: [], approvals: [], questions: [], queued: {} }), []);
assert.deepEqual(blockedSessions({ running: [], approvals: [], questions: [], queued: { '会话甲': { items: [] } } }), [], '排着零句不算拦住退出');

// 分别报告运行中、等待审批、等待回答和排队中的内容。
assert.deepEqual(blockedSessions({ running: ['a'], approvals: [], questions: [], queued: {} }), [{ sessionId: 'a', reasons: ['一轮在跑'] }]);
assert.deepEqual(blockedSessions({ running: [], approvals: ['b'], questions: [], queued: {} }), [{ sessionId: 'b', reasons: ['等一次批准'] }]);
assert.deepEqual(blockedSessions({ running: [], approvals: [], questions: ['c'], queued: {} }), [{ sessionId: 'c', reasons: ['等你回答一道题'] }]);
assert.deepEqual(blockedSessions({ running: [], approvals: [], questions: [], queued: { d: { items: ['一句', '两句'] } } }), [{ sessionId: 'd', reasons: ['排着 2 句没发出去'] }]);

// 同一会话的多个阻止原因应合并显示，并按固定顺序排列。
assert.deepEqual(blockedSessions({ running: ['a', 'b'], approvals: ['b'], questions: ['b'], queued: { b: { items: ['一句'] }, a: { items: ['一句', '两句'] } } }), [
  { sessionId: 'a', reasons: ['一轮在跑', '排着 2 句没发出去'] },
  { sessionId: 'b', reasons: ['一轮在跑', '等一次批准', '等你回答一道题', '排着 1 句没发出去'] },
]);

// 后台会话即使不在前台显示，也应出现在受影响的会话列表中。
assert.deepEqual(blockedSessions({ running: ['bg'], approvals: [], questions: [], queued: {} }).map((row) => row.sessionId), ['bg']);

console.log('桌面前端的退出清单检查通过');
