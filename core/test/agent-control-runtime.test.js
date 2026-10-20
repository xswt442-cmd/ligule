import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createAgentControlRuntime, requestAgentControl } from '../dist/host/agent-control-runtime.js';

const testplace = resolve('testplace');

async function fixture(run) {
  await mkdir(testplace, { recursive: true });
  const directory = await mkdtemp(join(testplace, 'agent-control-runtime-'));
  const projectRoot = join(directory, 'project');
  const otherProject = join(directory, 'other-project');
  await Promise.all([mkdir(projectRoot), mkdir(otherProject)]);
  try { await run({ directory, projectRoot, otherProject }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('a registered local controller accepts scoped status and human actions', async () => {
  await fixture(async ({ projectRoot, otherProject }) => {
    const calls = [];
    const sessionId = 'session-for-local-control';
    const runtime = createAgentControlRuntime(projectRoot, async (requestedSessionId, request) => {
      calls.push({ requestedSessionId, request });
      return { sessionId: requestedSessionId, action: request.action };
    });
    try {
      await runtime.register(sessionId);
      const response = await requestAgentControl(projectRoot, sessionId, {
        action: 'status', after: 0, limit: 10, waitMs: 0,
      });
      assert.deepEqual(response, { sessionId, action: 'status' });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].requestedSessionId, sessionId);

      const sent = await requestAgentControl(projectRoot, sessionId, { action: 'send', input: 'Continue with the next step.' });
      assert.deepEqual(sent, { sessionId, action: 'send' });
      assert.equal(calls[1].request.input, 'Continue with the next step.');

      await assert.rejects(
        requestAgentControl(otherProject, sessionId, { action: 'status', after: 0, limit: 10, waitMs: 0 }),
        { code: 'control_project_forbidden' },
      );
      await assert.rejects(
        requestAgentControl(projectRoot, '../other-session', { action: 'status', after: 0, limit: 10, waitMs: 0 }),
        { code: 'agent_control_request_invalid' },
      );
    } finally {
      await runtime.close();
    }
    await assert.rejects(
      requestAgentControl(projectRoot, sessionId, { action: 'status', after: 0, limit: 10, waitMs: 0 }),
      { code: 'agent_control_runtime_unavailable' },
    );
  });
});

test('the local controller validates replies and keeps request errors bounded', async () => {
  await fixture(async ({ projectRoot }) => {
    const runtime = createAgentControlRuntime(projectRoot, async () => { throw Object.assign(new Error('private path'), { code: 'control_interaction_stale' }); });
    try {
      await runtime.register('session-reply-control');
      await assert.rejects(
        requestAgentControl(projectRoot, 'session-reply-control', {
          action: 'reply', requestId: 'request-1', type: 'approval', decision: 'allow',
        }),
        { code: 'control_interaction_stale' },
      );
      await assert.rejects(
        requestAgentControl(projectRoot, 'session-reply-control', { action: 'reply', requestId: 'request-1', type: 'approval', decision: 'maybe' }),
        { code: 'agent_control_request_invalid' },
      );
      await assert.rejects(
        requestAgentControl(projectRoot, 'session-reply-control', { action: 'send', input: '   ' }),
        { code: 'agent_control_request_invalid' },
      );
    } finally { await runtime.close(); }
  });
});
