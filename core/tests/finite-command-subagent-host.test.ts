import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createPermissionContext } from '../dist/kernel/permission.js';
import { withTuiHost } from './helpers/tui-host.ts';

const fullAccess = createPermissionContext('full-access', 'unrestricted', {
  filesystemRead: 'full', filesystemWrite: 'full', network: 'full', process: 'full',
});

type ChatBody = { messages: { role: string; content?: unknown }[]; tools?: { function: { name: string } }[] };

function lastToolContent(body: ChatBody): Record<string, unknown> | undefined {
  const message = [...body.messages].reverse().find((item) => item.role === 'tool');
  if (typeof message?.content !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(message.content);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    const wrapper = parsed as Record<string, unknown>;
    return typeof wrapper.content === 'object' && wrapper.content !== null && !Array.isArray(wrapper.content)
      ? wrapper.content as Record<string, unknown>
      : wrapper;
  } catch {
    return undefined;
  }
}

test('a child Run controls a finite command under its own Session, Run and shared TaskBudget', {
  skip: process.platform !== 'win32' && process.platform !== 'linux',
  timeout: 45_000,
}, async () => {
  let scriptPath = '';
  let parentStartSent = false;
  let childStartSent = false;
  let parentWaitSent = false;
  const parentInput = 'parent-start-finite-child';
  const childInput = 'child-run-finite-command';

  await withTuiHost(async ({ client, sessionId, projectDirectory, providerRequests }) => {
    scriptPath = join(projectDirectory, 'child-finite-command.mjs');
    await writeFile(scriptPath, [
      "console.log('child-command-output');",
      "setTimeout(() => {}, 350);",
    ].join('\n'));
    await client.request('workspace.trust', {
      projectRoot: projectDirectory, trusted: true, confirmWorkspaceTrust: true,
    });
    client.onRequest((message) => message.method === 'approval.request' ? { decision: 'allow' } : undefined);

    await client.request('run.start', { sessionId, input: parentInput });
    const parentRecord = await client.request('session.read', { sessionId, fullResults: true }) as {
      events: { kind?: string; tool?: string; runId?: string; result?: { content?: Record<string, unknown> } }[];
    };
    const parentStart = parentRecord.events.find((event) => event.kind === 'tool' && event.tool === 'subagent_start');
    assert.ok(parentStart, 'the parent model started a child Run');
    const childReference = parentStart.result?.content;
    if (childReference === undefined || typeof childReference.sessionId !== 'string'
      || typeof childReference.runId !== 'string' || typeof childReference.subrunId !== 'string') {
      throw new Error(`the child reference is incomplete: ${JSON.stringify(childReference)}`);
    }

    const childRecord = await client.request('session.read', {
      sessionId: childReference.sessionId, fullResults: true,
    }) as { events: { kind?: string; state?: string; runId?: string; parentRunId?: string; executionId?: string }[] };
    const executionEvents = childRecord.events.filter((event) => event.kind === 'execution');
    assert.ok(executionEvents.some((event) => event.state === 'accepted'),
      `the child Session records command acceptance; child=${JSON.stringify(childRecord.events)} tools=${JSON.stringify(providerRequests.map((body) => body.tools?.map((tool) => tool.function.name)))}`);
    assert.ok(executionEvents.some((event) => event.state === 'started'), 'the child Session records the actual start');
    const completed = executionEvents.findLast((event) => event.state === 'exited');
    assert.ok(completed, `the child Run settles its command before completion: ${JSON.stringify(executionEvents)}`);
    assert.equal(completed.runId, childReference.runId);
    assert.equal(completed.parentRunId, parentStart.runId);
    assert.equal(typeof completed.executionId, 'string');
  }, {
    providerReply: (body) => {
      const user = [...body.messages].reverse().find((message) => message.role === 'user')?.content;
      const tools = new Set(body.tools?.map((tool) => tool.function.name));
      const previous = lastToolContent(body);
      if (user === parentInput && tools.has('subagent_start') && !parentStartSent) {
        parentStartSent = true;
        return { toolCalls: [{ tool: 'subagent_start', args: { task: childInput } }] };
      }
      if (user === childInput && tools.has('exec') && !childStartSent) {
        childStartSent = true;
        return { toolCalls: [{ tool: 'exec', args: {
          command: `node "${scriptPath.replaceAll('\\', '/')}"`, waitMs: 0,
        } }] };
      }
      if (user === parentInput && tools.has('subagent_wait') && previous?.subrunId !== undefined && !parentWaitSent) {
        parentWaitSent = true;
        return { toolCalls: [{ tool: 'subagent_wait', args: { subrunIds: [previous.subrunId], timeoutMs: 5_000 } }] };
      }
      return { text: 'Run finished.' };
    },
    permission: fullAccess,
    permissionControl: true,
    modeName: 'full',
    config: { loop: { iterations: 8, modelCalls: 16, maxConcurrentSubagents: 3 } },
    testDirectory: join(process.cwd(), 'testplace', 'tmp'),
  });
});
