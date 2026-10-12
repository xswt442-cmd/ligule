// 客户端那一层的两条检查：答复按 id 对上；超时那一条把等待中的调用收掉。
// 跑 `node dev/protocol.check.mjs`，坏了就非零退出。
import assert from 'node:assert/strict';
import { createClient } from '../src/protocol.ts';

const sent = [];
const handlers = [];
const transport = {
  send: (text) => sent.push(JSON.parse(text)),
  onFrame: (handle) => handlers.push(handle),
  onLog: () => undefined,
};
const client = createClient(transport);

const reply = (frame) => handlers[0](JSON.stringify(frame));

const answered = client.call('status.get', { sessionId: 's1' });
assert.equal(sent[0].method, 'status.get');
assert.equal(client.waiting(), 1);
reply({ id: sent[0].id, result: { sessionId: 's1' } });
assert.deepEqual(await answered, { sessionId: 's1' });
assert.equal(client.waiting(), 0);

const failed = client.call('run.cancel', { sessionId: 's1' }, 50);
reply({ id: sent[1].id, error: { code: 'run_not_running', message: '没在跑' } });
await assert.rejects(failed, { code: 'run_not_running' });
assert.equal(client.waiting(), 0);

// 那一个调用不回：超时把这一格收掉，之后迟到的答复不再动它。
const timeout = client.call('session.read', { sessionId: 's1' }, 20);
await assert.rejects(timeout, { code: 'host_unanswered' });
assert.equal(client.waiting(), 0);
reply({ id: sent[2].id, result: { events: [] } });
assert.equal(client.counts().received, 3);

// 换了一具宿主：还没答复的那些调用按一个稳定码收尾，之后迟到的答复不再动它们（第 65 步）。
const left = client.call('run.start', { sessionId: 's1', input: 'a' });
const right = client.call('status.get', { sessionId: 's1' });
assert.equal(client.waiting(), 2);
assert.equal(client.discard('host_restarted'), 2, '交回收尾了几条');
await assert.rejects(left, { code: 'host_restarted' });
await assert.rejects(right, { code: 'host_restarted' });
assert.equal(client.waiting(), 0);
assert.equal(client.discard('host_restarted'), 0, '没有等待时收尾零条');
reply({ id: sent[sent.length - 2].id, result: { iterations: 1 } });
assert.equal(client.counts().received, 4, '迟到的那一份答复仍然被读掉，只是没人等它');

// 通报与反向请求不算答复：它们没有 id。
let seen = '';
client.onNotification((message) => {
  seen = message.notify;
});
reply({ notify: 'delta', sessionId: 's1', event: { type: 'text', text: 'x' } });
assert.equal(seen, 'delta');
assert.equal(client.waiting(), 0);
console.log('桌面前端的协议检查通过');
