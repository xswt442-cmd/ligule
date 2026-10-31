import assert from 'node:assert/strict';
import { thinkingRequest } from '../../frontend/src/thinking-request.ts';

// 界面写的思考档必须落到 Core 的 session.configure 上：方法名写错时 Host 只能回“未知方法”，
// 而界面会把它显示成“没有效果”。这里把方法名与参数形状一起锁住。
const set = thinkingRequest('s1', 'low');
assert.equal(set.method, 'session.configure');
assert.deepEqual(set.params, { sessionId: 's1', thinkingEffort: 'low' });

const reset = thinkingRequest('s1', null);
assert.equal(reset.method, 'session.configure');
assert.deepEqual(reset.params, { sessionId: 's1', resetThinking: true });
assert.equal('thinkingEffort' in reset.params, false);

// 任何非 null 档位原样透传，由 Host 负责校验合法值。
assert.deepEqual(thinkingRequest('s2', 'max').params, { sessionId: 's2', thinkingEffort: 'max' });
console.log('thinking-request ok');
