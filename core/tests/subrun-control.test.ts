import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createPermissionContext } from '../dist/kernel/permission.js';
import { withTuiHost, waitFor } from './helpers/tui-host.ts';

const fullAccess = createPermissionContext('full-access', 'unrestricted', {
  filesystemRead: 'full', filesystemWrite: 'full', network: 'full', process: 'full',
});

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

test('the model subagent_message tool invalidates a child approval before a late allow', { timeout: 30_000 }, async () => {
  let releaseApproval!: (value: unknown) => void;
  let releaseParent!: () => void;
  const approvalReply = new Promise<unknown>((resolve) => { releaseApproval = resolve; });
  const parentGate = new Promise<void>((resolve) => { releaseParent = resolve; });
  let childReference: { subrunId: string; sessionId: string; runId: string } | undefined;
  let parentStartSent = false;
  let childCreateSent = false;
  let childMessageSent = false;
  let parentMessageHeld = false;
  let approvalWasRequested = false;

  const parseChildReference = (body: { messages: { role: string; content?: unknown }[] }) => {
    for (const message of body.messages) {
      if (message.role !== 'tool' || typeof message.content !== 'string') continue;
      try {
        const parsed = JSON.parse(message.content) as Record<string, unknown>;
        const content = typeof parsed.content === 'object' && parsed.content !== null
          ? parsed.content as Record<string, unknown> : parsed;
        if (typeof content.subrunId === 'string' && typeof content.sessionId === 'string' && typeof content.runId === 'string') {
          return { subrunId: content.subrunId, sessionId: content.sessionId, runId: content.runId };
        }
      } catch { /* Other tool results are not child references. */ }
    }
    return undefined;
  };

  try {
    await withTuiHost(async ({ client, sessionId, projectDirectory, providerRequests }) => {
      await client.request('workspace.trust', {
        projectRoot: projectDirectory, trusted: true, confirmWorkspaceTrust: true,
      });
      client.onRequest((request) => {
        if (request.method !== 'approval.request') return undefined;
        approvalWasRequested = true;
        return approvalReply;
      });

      const submitted = await client.request('run.submit', { sessionId, input: 'parent-start-child' }) as { runId: string };
      assert.equal(typeof submitted.runId, 'string');
      const requestsSeen = () => JSON.stringify({
        requests: providerRequests.map((body) => ({
          user: [...body.messages].reverse().find((message) => message.role === 'user')?.content,
          tools: body.tools?.map((tool) => tool.function.name),
        })),
        parentStartSent, childCreateSent, childMessageSent, parentMessageHeld,
      });
      try {
        await waitFor(() => approvalWasRequested, { within: 5_000, read: requestsSeen });
      } catch (error) {
        const record = await client.request('session.read', { sessionId, fullResults: true }) as {
          events: { kind?: string; tool?: string; result?: unknown }[];
        };
        throw new Error(`${error instanceof Error ? error.message : 'approval_request_missing'}\n${JSON.stringify(record.events.filter((event) => event.kind === 'tool'))}`);
      }
      try {
        await waitFor(() => parentMessageHeld, { within: 5_000, read: requestsSeen });
      } catch (error) {
        const record = await client.request('session.read', { sessionId, fullResults: true }) as {
          events: { kind?: string; tool?: string; result?: unknown }[];
        };
        throw new Error(`${error instanceof Error ? error.message : 'model_subagent_message_missing'}\n${JSON.stringify(record.events.filter((event) => event.kind === 'tool'))}`);
      }
      releaseApproval({ decision: 'allow' });
      releaseParent();
      await client.request('run.wait', { sessionId, runId: submitted.runId });

      assert.ok(childReference, 'the parent model call must start a child Run');
      const childRecord = await client.request('session.read', {
        sessionId: childReference.sessionId, fullResults: true,
      }) as { events: { kind?: string; tool?: string; result?: { failed?: boolean; code?: string } }[] };
      const create = childRecord.events.find((event) => event.kind === 'tool' && event.tool === 'create');
      assert.equal(existsSync(join(projectDirectory, 'subagent-message-must-not-create.txt')), false,
        'a late allow from the approval prompt must not apply after subagent_message was accepted');
      assert.equal(create?.result?.failed, true);
      assert.equal(create?.result?.code, 'policy_approval_cancelled');
    }, {
      permission: fullAccess,
      permissionControl: true,
      modeName: 'full',
      config: {
        policy: { mode: 'auto', rules: [{ tool: 'create', decision: 'ask' }] },
        loop: { iterations: 8, modelCalls: 16, maxConcurrentSubagents: 3 },
      },
      testDirectory: 'testplace/tmp',
      providerReply: async (body) => {
        const lastUser = [...body.messages].reverse().find((message) => message.role === 'user')?.content;
        const tools = new Set(body.tools?.map((tool) => tool.function.name));
        if (tools.has('subagent_start') && lastUser === 'parent-start-child' && !parentStartSent) {
          parentStartSent = true;
          return { toolCalls: [{ tool: 'subagent_start', args: { task: 'child-create-pending-approval' } }] };
        }
        if (!tools.has('subagent_start') && tools.has('create')
          && lastUser === 'child-create-pending-approval' && !childCreateSent) {
          childCreateSent = true;
          return { toolCalls: [{ tool: 'create', args: {
            path: 'subagent-message-must-not-create.txt', content: 'must not be written',
          } }] };
        }
        if (tools.has('subagent_message') && !childMessageSent) {
          childReference = parseChildReference(body);
          if (childReference === undefined) throw new Error('subagent_start_result_missing_from_parent_request');
          await waitFor(() => approvalWasRequested, { within: 5_000 });
          childMessageSent = true;
          return { toolCalls: [{ tool: 'subagent_message', args: {
            subrunId: childReference.subrunId,
            runId: childReference.runId,
            input: 'Do not create subagent-message-must-not-create.txt.',
          } }] };
        }
        if (tools.has('subagent_message') && childMessageSent && !parentMessageHeld
          && body.messages.some((message) => message.role === 'tool'
            && typeof message.content === 'string' && message.content.includes('"state":"accepted"'))) {
          parentMessageHeld = true;
          await parentGate;
          return { text: 'parent finished' };
        }
        if (!tools.has('subagent_message') && body.messages.some((message) => message.role === 'user'
          && typeof message.content === 'string' && message.content.includes('Do not create subagent-message-must-not-create.txt.'))) {
          return { text: 'I will follow the new instruction.' };
        }
        return { text: 'No further action.' };
      },
    });
  } finally {
    releaseApproval({ decision: 'allow' });
    releaseParent();
  }
});

test('steering a parent does not invalidate a child Run approval', { timeout: 30_000 }, async () => {
  let releaseApproval!: (value: unknown) => void;
  let markApprovalRequested!: () => void;
  let releaseParentRequest!: () => void;
  let markParentRequestStarted!: () => void;
  const approvalReply = new Promise<unknown>((resolve) => { releaseApproval = resolve; });
  const approvalRequested = new Promise<void>((resolve) => { markApprovalRequested = resolve; });
  const parentRequestGate = new Promise<void>((resolve) => { releaseParentRequest = resolve; });
  const parentRequestStarted = new Promise<void>((resolve) => { markParentRequestStarted = resolve; });

  try {
    await withTuiHost(async ({ client, sessionId, projectDirectory }) => {
      await client.request('workspace.trust', {
        projectRoot: projectDirectory, trusted: true, confirmWorkspaceTrust: true,
      });
      client.onRequest((request) => {
        if (request.method !== 'approval.request') return undefined;
        markApprovalRequested();
        return approvalReply;
      });

      const parent = await client.request('run.submit', {
        sessionId, input: 'parent-held-for-child-approval',
      }) as { runId: string };
      await parentRequestStarted;
      const child = await client.request('subrun.start', {
        sessionId, parentRunId: parent.runId, task: 'child-create-after-parent-steer',
      }) as { subrunId: string; sessionId: string; runId: string };
      await approvalRequested;

      const accepted = await client.request('run.steer', {
        sessionId, runId: parent.runId, input: 'Continue the parent while its child waits for approval.',
      }) as { cancelledInteractions: number };
      assert.equal(accepted.cancelledInteractions, 0, 'the parent has no pending interaction to cancel');

      releaseParentRequest();
      releaseApproval({ decision: 'allow' });
      await client.request('run.wait', { sessionId, runId: parent.runId });
      const childRecord = await client.request('session.read', { sessionId: child.sessionId, fullResults: true }) as {
        events: { kind?: string; tool?: string; result?: { failed?: boolean; code?: string } }[];
      };
      const create = childRecord.events.find((event) => event.kind === 'tool' && event.tool === 'create');
      assert.equal(create?.result?.failed, false, JSON.stringify(create));
      assert.equal(existsSync(join(projectDirectory, 'parent-steer-child-approval.txt')), true,
        'a late child approval remains valid when only the parent Run was steered');
    }, {
      permission: fullAccess,
      permissionControl: true,
      modeName: 'full',
      config: {
        policy: { mode: 'auto', rules: [{ tool: 'create', decision: 'ask' }] },
        loop: { iterations: 8, modelCalls: 16, maxConcurrentSubagents: 3 },
      },
      testDirectory: 'testplace/tmp',
      beforeResponse: async (body) => {
        const lastUser = [...body.messages].reverse().find((message) => message.role === 'user')?.content;
        if (lastUser === 'parent-held-for-child-approval') {
          markParentRequestStarted();
          await parentRequestGate;
        }
      },
      providerReply: (body) => {
        const lastUser = [...body.messages].reverse().find((message) => message.role === 'user')?.content;
        const tools = new Set(body.tools?.map((tool) => tool.function.name));
        if (lastUser === 'parent-held-for-child-approval') return { text: 'parent finished safely' };
        if (lastUser === 'child-create-after-parent-steer' && tools.has('create')) {
          return { toolCalls: [{ tool: 'create', args: {
            path: 'parent-steer-child-approval.txt', content: 'child approval remains scoped to the child Run',
          } }] };
        }
        return { text: 'no further action' };
      },
    });
  } finally {
    releaseApproval({ decision: 'allow' });
    releaseParentRequest();
  }
});
