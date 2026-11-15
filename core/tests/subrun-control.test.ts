import test from 'node:test';
import assert from 'node:assert/strict';
import { withTuiHost, waitFor } from './helpers/tui-host.ts';

test('P10 Host publishes one set of independently controllable subrun tools', async () => {
  await withTuiHost(async ({ client, sessionId }) => {
    const status = await client.request('status.get', { sessionId }) as { tools: string[] };
    assert.deepEqual(status.tools.filter((name) => name.startsWith('subagent_')).sort(), [
      'subagent_cancel', 'subagent_message', 'subagent_start', 'subagent_status', 'subagent_wait',
    ]);
  }, { modeName: 'full', permissionControl: true, testDirectory: 'testplace/tmp' });
});

test('Host routes child steering, timeout wait, isolated cancellation, and persisted status through the parent Run', { timeout: 30_000 }, async () => {
  let releaseParent!: () => void;
  let releaseChild!: () => void;
  let releaseSibling!: () => void;
  let parentReached = false;
  let childReached = false;
  let siblingReached = false;
  let markParentEntered!: () => void;
  let markChildEntered!: () => void;
  let markSiblingEntered!: () => void;
  const parentGate = new Promise<void>((resolve) => { releaseParent = resolve; });
  const childGate = new Promise<void>((resolve) => { releaseChild = resolve; });
  const siblingGate = new Promise<void>((resolve) => { releaseSibling = resolve; });
  markParentEntered = () => { parentReached = true; };
  markChildEntered = () => { childReached = true; };
  markSiblingEntered = () => { siblingReached = true; };
  const childTask = JSON.stringify({ tool: 'read', args: { path: 'missing.txt' } });

  try {
    await withTuiHost(async ({ client, sessionId, restart, providerRequests }) => {
      const parent = await client.request('run.submit', { sessionId, input: 'parent-held' }) as { runId: string };
      assert.equal(typeof parent.runId, 'string');
      await waitFor(() => parentReached, { within: 5_000 });

      await assert.rejects(client.request('subrun.start', {
        sessionId, parentRunId: 'not-the-active-parent', task: 'must be rejected',
      }), { code: 'run_not_found' });

      const child = await client.request('subrun.start', {
        sessionId, parentRunId: parent.runId, task: childTask,
      }) as { subrunId: string; sessionId: string; runId: string; parentRunId: string };
      const sibling = await client.request('subrun.start', {
        sessionId, parentRunId: parent.runId, task: 'sibling-held',
      }) as { subrunId: string; sessionId: string; runId: string; parentRunId: string };
      for (const item of [child, sibling]) {
        assert.equal(item.parentRunId, parent.runId);
        assert.equal(item.subrunId, item.sessionId, 'the durable child Session ID is its stable subrun handle');
        assert.equal(typeof item.runId, 'string');
      }
      await waitFor(() => childReached && siblingReached, {
        within: 5_000,
        read: () => JSON.stringify(providerRequests.map(body => body.messages.filter(message => message.role === 'user').map(message => message.content))),
      });

      const status = await client.request('subrun.status', {
        sessionId, parentRunId: parent.runId, subrunId: child.subrunId,
      }) as { state: string; runId: string; sessionId: string };
      assert.equal(status.state, 'running');
      assert.equal(status.runId, child.runId);
      assert.equal(status.sessionId, child.sessionId);

      const input = await client.request('subrun.message', {
        sessionId, parentRunId: parent.runId, subrunId: child.subrunId, runId: child.runId,
        input: 'Please inspect the target file after your current safe step.',
      }) as { source: string; state: string; runId: string };
      assert.equal(input.source, 'human');
      assert.equal(input.state, 'accepted');
      assert.equal(input.runId, child.runId);

      const poll = await client.request('subrun.wait', {
        sessionId, parentRunId: parent.runId, subrunIds: [child.subrunId], timeoutMs: 0,
      }) as { timedOut: boolean; subruns: { state: string }[] };
      assert.equal(poll.timedOut, true, 'zero timeout is a status poll, not an unbounded wait');
      assert.equal(poll.subruns[0]?.state, 'running');

      const timeout = await client.request('subrun.wait', {
        sessionId, parentRunId: parent.runId, subrunIds: [child.subrunId, sibling.subrunId], timeoutMs: 20,
      }) as { timedOut: boolean; subruns: { state: string }[] };
      assert.equal(timeout.timedOut, true);
      assert.equal(timeout.subruns[0]?.state, 'running');
      assert.equal(timeout.subruns[1]?.state, 'running');

      const cancellation = await client.request('subrun.cancel', {
        sessionId, parentRunId: parent.runId, subrunId: sibling.subrunId, runId: sibling.runId,
      }) as { cancelRequested: boolean; state: string };
      assert.equal(cancellation.cancelRequested, true);
      assert.equal(cancellation.state, 'running', 'a cancellation request is not a settled child');
      releaseSibling();

      const settled = await client.request('subrun.wait', {
        sessionId, parentRunId: parent.runId, subrunIds: [sibling.subrunId], timeoutMs: 5_000,
      }) as { timedOut: boolean; subruns: { state: string }[] };
      assert.equal(settled.timedOut, false);
      assert.equal(settled.subruns[0]?.state, 'cancelled', JSON.stringify(settled));
      assert.equal((await client.request('subrun.status', {
        sessionId, parentRunId: parent.runId, subrunId: child.subrunId,
      }) as { state: string }).state, 'running', 'cancelling one child leaves its sibling running');

      releaseChild();
      const completed = await client.request('subrun.wait', {
        sessionId, parentRunId: parent.runId, subrunIds: [child.subrunId], timeoutMs: 5_000,
      }) as { timedOut: boolean; subruns: { state: string }[] };
      assert.equal(completed.timedOut, false);
      assert.equal(completed.subruns[0]?.state, 'completed');
      assert.ok(providerRequests.some(body => body.messages.some(message =>
        typeof message.content === 'string' && message.content.includes('Please inspect the target file'))),
      'accepted child steering must appear in a later Provider request');

      releaseParent();
      await client.request('run.wait', { sessionId, runId: parent.runId });
      await assert.rejects(client.request('subrun.status', {
        sessionId, parentRunId: 'another-parent-run', subrunId: child.subrunId,
      }), { code: 'run_not_found' });

      const restarted = await restart();
      await restarted.request('session.open', { sessionId });
      const persistedChild = await restarted.request('subrun.status', {
        sessionId, parentRunId: parent.runId, subrunId: child.subrunId,
      }) as { state: string; runId: string };
      const persistedSibling = await restarted.request('subrun.status', {
        sessionId, parentRunId: parent.runId, subrunId: sibling.subrunId,
      }) as { state: string; runId: string };
      assert.equal(persistedChild.state, 'completed');
      assert.equal(persistedChild.runId, child.runId);
      assert.equal(persistedSibling.state, 'cancelled');
      assert.equal(persistedSibling.runId, sibling.runId);
    }, {
      modeName: 'full',
      permissionControl: true,
      config: { loop: { iterations: 8, modelCalls: 16, maxConcurrentSubagents: 3 } },
      testDirectory: 'testplace/tmp',
      beforeResponse: async (body) => {
        const lastUser = [...body.messages].reverse().find((message) => message.role === 'user')?.content;
        if (lastUser === 'parent-held') { markParentEntered(); await parentGate; }
        if (JSON.stringify(body.messages).includes('missing.txt')) { markChildEntered(); await childGate; }
        if (lastUser === 'sibling-held') { markSiblingEntered(); await siblingGate; }
      },
    });
  } finally {
    releaseChild();
    releaseSibling();
    releaseParent();
  }
});
