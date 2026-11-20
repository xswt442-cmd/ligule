import test from 'node:test';
import assert from 'node:assert/strict';
import { withTuiHost } from './helpers/tui-host.ts';
import type { SessionReadPage } from '../dist/wire.js';

const PAGE_FIELDS = ['endSeq', 'events', 'hasMore', 'header', 'label', 'provisionalOutput', 'provisionalOutputError', 'sessionId'];

// wire 类型是 Host 与客户端共同引用的字段表；这里用真实回复确认声明的字段确实在发送，也没有未声明的字段。
test('session.read 与 session.observe 的回复与共享页类型一致', async () => {
  await withTuiHost(async ({ client, sessionId }) => {
    const page = await client.request('session.read', { sessionId }) as SessionReadPage;
    assert.deepEqual(Object.keys(page).sort(), [...PAGE_FIELDS].sort());
    assert.equal(page.sessionId, sessionId);
    assert.deepEqual(page.label, { name: '', archived: false });
    assert.equal(page.endSeq, page.events.at(-1)?.seq ?? null);
    assert.equal(page.hasMore, false);

    const observed = await client.request('session.observe', {
      projectRoot: page.header?.projectRoot ?? undefined, sessionId,
    }) as SessionReadPage & { readonly writerActive: boolean };
    for (const field of PAGE_FIELDS) assert.ok(Object.hasOwn(observed, field), `session.observe 缺少 ${field}`);
    assert.equal(typeof observed.writerActive, 'boolean');
  });
});
