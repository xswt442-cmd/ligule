// 检查客户端如何匹配响应、处理超时并清理重连前的等待调用。
import assert from 'node:assert/strict';
import { code, createClient, type Frame, type Transport } from '../../src/protocol.ts';
import { loadSettings, readSettings, saveSettings, updateSettings } from '../../src/settings.ts';

const sent: Frame[] = [];
const handlers: Array<(text: string) => void> = [];
const transport: Transport = {
  send: (text: string) => sent.push(JSON.parse(text) as Frame),
  onFrame: (handle: (text: string) => void) => handlers.push(handle),
  onLog: () => undefined,
};
const client = createClient(transport);

const reply = (frame: Frame) => handlers[0](JSON.stringify(frame));

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

// 请求超时后应清除等待状态，迟到的响应不得再次完成该请求。
const timeout = client.call('session.read', { sessionId: 's1' }, 20);
await assert.rejects(timeout, { code: 'host_unanswered' });
assert.equal(client.waiting(), 0);
reply({ id: sent[2].id, result: { events: [] } });
assert.equal(client.counts().received, 3);

const reconnectTimeout = client.call('workspaces.list', {}, 20);
const reconnectId = sent.at(-1)!.id;
await assert.rejects(reconnectTimeout, { code: 'host_unanswered' });
assert.equal(client.waiting(), 0, 'an unanswered workspace request releases its waiter');
reply({ id: reconnectId, result: { workspaces: [] } });
const reconnectRetry = client.call('workspaces.list', {}, 20);
reply({ id: sent.at(-1)!.id, result: { workspaces: [] } });
assert.deepEqual(await reconnectRetry, { workspaces: [] }, 'a subsequent reconnect request can complete');

// Host 重启时应以稳定错误结束所有未完成调用。
const left = client.call('run.start', { sessionId: 's1', input: 'a' });
const right = client.call('status.get', { sessionId: 's1' });
assert.equal(client.waiting(), 2);
assert.equal(client.discard('host_restarted'), 2, '交回收尾了几条');
await assert.rejects(left, { code: 'host_restarted' });
await assert.rejects(right, { code: 'host_restarted' });
assert.equal(client.waiting(), 0);
assert.equal(client.discard('host_restarted'), 0, '没有等待时收尾零条');
const receivedBeforeLateReply = client.counts().received;
reply({ id: sent[sent.length - 2].id, result: { iterations: 1 } });
assert.equal(client.counts().received, receivedBeforeLateReply + 1, '迟到的那一份答复仍然被读掉，只是没人等它');

// 通知没有请求 ID，不应结束任何等待中的调用。
let seen: string | undefined = '';
const stopSeen = client.onNotification((message) => {
  seen = message.notify;
});
reply({ notify: 'delta', sessionId: 's1', event: { type: 'text', text: 'x' } });
assert.equal(seen, 'delta');
assert.equal(client.waiting(), 0);
// 界面重建订阅时必须能摘掉旧回调，否则同一条通知会被处理两次。
stopSeen();
seen = '';
reply({ notify: 'delta', sessionId: 's1', event: { type: 'text', text: 'y' } });
assert.equal(seen, '', '退订后不再收到通知');
const stopAgain = client.onNotification(() => { seen = 'second'; });
stopAgain();
reply({ notify: 'delta', sessionId: 's1', event: { type: 'text', text: 'z' } });
assert.equal(seen, '', '重复退订不会复活回调');

// code(error) 对 null/undefined 不应抛错。
assert.equal(code(null), 'null');
assert.equal(code(undefined), 'undefined');

// 回调内部退订自己时，不应跳过后续监听者。
const order: string[] = [];
let unsubFirst = () => {};
unsubFirst = client.onNotification(() => {
  order.push('first');
  unsubFirst();
});
const unsubSecond = client.onNotification(() => {
  order.push('second');
});
reply({ notify: 'delta', sessionId: 's1', event: { type: 'text', text: 'snapshot' } });
assert.deepEqual(order, ['first', 'second']);
unsubSecond();

// settings.ts: Host 写入冲突或失败时不得提前污染内存或 localStorage 缓存。
const storage = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value); },
  removeItem: (key: string) => { storage.delete(key); },
  clear: () => { storage.clear(); },
  key: (index: number) => [...storage.keys()][index] ?? null,
  get length() { return storage.size; },
};

let failWrite = false;
const settingsClient = {
  call: async (method: string, params: Record<string, unknown>) => {
    if (method === 'prefs.read') {
      return { version: 'v1', settings: { palette: 'parchment', fontUi: 15 } };
    }
    if (method === 'prefs.write') {
      if (failWrite) throw Object.assign(new Error('prefs_version_conflict'), { code: 'prefs_version_conflict' });
      return { version: 'v2', settings: JSON.parse(String(params.json)) };
    }
    throw new Error(`unexpected_method:${method}`);
  },
} as unknown as ReturnType<typeof createClient>;

const initial = await loadSettings(settingsClient);
assert.equal(initial.palette, 'parchment');
assert.equal(readSettings().palette, 'parchment');

failWrite = true;
await assert.rejects(
  saveSettings(settingsClient, { ...initial, palette: 'forest' }),
  { code: 'prefs_version_conflict' },
);
assert.equal(readSettings().palette, 'parchment', 'saveSettings 冲突时不得提前写入 localStorage');

await loadSettings(settingsClient);
failWrite = true;
await assert.rejects(
  updateSettings(settingsClient, (current) => ({ ...current, fontUi: 22 })),
  { code: 'prefs_version_conflict' },
);
assert.equal(readSettings().fontUi, 15, 'updateSettings 冲突时不得提前写入 localStorage');

console.log('桌面前端的协议检查通过');
