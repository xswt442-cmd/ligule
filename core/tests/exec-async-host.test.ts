import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createPermissionContext } from '../dist/kernel/permission.js';
import { detectPermissionCapabilities } from '../dist/capability/permission-capabilities.js';
import { withTuiHost } from './helpers/tui-host.ts';

type ChatBody = { messages: { role: string; content?: unknown }[] };
type ToolResult = { kind?: string; tool?: string; runId?: string; result?: { failed?: boolean; code?: string; content?: unknown } };

function lastToolContent(body: ChatBody): Record<string, unknown> | undefined {
  const message = [...body.messages].reverse().find((item) => item.role === 'tool');
  if (typeof message?.content !== 'string') return undefined;
  try {
    const value: unknown = JSON.parse(message.content);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

test('exec waitMs returns a controllable Run-owned handle and bounded logs', {
  skip: process.platform !== 'win32' && process.platform !== 'linux',
  timeout: 45_000,
}, async (t) => {
  let permission;
  if (process.platform === 'win32') {
    permission = createPermissionContext('workspace-write', 'unrestricted', {
      filesystemRead: 'partial', filesystemWrite: 'partial', network: 'partial', process: 'full',
    }, {
      profiles: { readOnly: 'partial', workspaceWrite: 'partial' },
      limitations: ['Windows workspace-write has partial isolation.'],
      partialWorkspaceWriteConfirmationRequired: true,
      partialWorkspaceWriteConfirmed: true,
    });
  } else {
    const capabilities = await detectPermissionCapabilities({ platform: 'linux' });
    if (capabilities.profiles.workspaceWrite === 'unavailable') {
      t.skip(capabilities.limitations.join('; '));
      return;
    }
    permission = createPermissionContext('workspace-write', 'unrestricted', capabilities.capabilities, {
      profiles: capabilities.profiles,
      limitations: capabilities.limitations,
      partialWorkspaceWriteConfirmed: false,
    });
  }

  let step = 0;
  let executionId: string | undefined;
  let firstLogCursor: string | undefined;
  let commandPath = '';
  await withTuiHost(async ({ client, sessionId, projectDirectory, providerRequests, restart }) => {
    const scriptPath = join(projectDirectory, 'finite-command.mjs');
    await mkdir(projectDirectory, { recursive: true });
    commandPath = scriptPath;
    await writeFile(scriptPath, [
      "console.log('first-line');",
      "setTimeout(() => { console.error('second-error'); console.log('second-line'); }, 2_000);",
    ].join('\n'));
    await client.request('workspace.trust', {
      projectRoot: projectDirectory, trusted: true, confirmWorkspaceTrust: true,
    });
    client.onRequest((message) => message.method === 'approval.request' ? { decision: 'allow' } : undefined);

    await client.request('run.start', { sessionId, input: 'start a finite test command' });
    const { events } = await client.request('session.read', { sessionId }) as { events: ToolResult[] };
    const results = events.filter((event) => event.kind === 'tool' && (event.tool === 'exec' || event.tool === 'exec_control'));

    assert.equal(results.length, 5,
      `the Run starts once, polls once, reads a first page, waits, then reads the next page; tools=${JSON.stringify(providerRequests.map((request) => request.tools?.map((tool) => tool.function.name)))} events=${JSON.stringify(results)}`);
    const start = results[0]?.result?.content as Record<string, unknown>;
    assert.equal(results[0]?.result?.failed, false, JSON.stringify(results[0]?.result));
    assert.equal(start.kind, 'execution');
    assert.equal(start.state, 'running');
    assert.equal(start.executionId, executionId);

    const shortWait = results[1]?.result?.content as Record<string, unknown>;
    assert.equal(shortWait.waitTimedOut, true);
    assert.equal(shortWait.state, 'running', 'a wait timeout does not cancel the command');

    const firstPage = results[2]?.result?.content as Record<string, unknown>;
    assert.equal(typeof firstPage.nextCursor, 'string');
    assert.equal(firstPage.truncated, false);
    firstLogCursor = firstPage.nextCursor as string;

    const finalWait = results[3]?.result?.content as Record<string, unknown>;
    assert.equal(finalWait.waitTimedOut, false);
    assert.equal(finalWait.state, 'exited');
    assert.equal(finalWait.exitCode, 0);
    assert.equal(finalWait.terminationPending, false);
    assert.equal(finalWait.cleanupPending, false);

    const secondPage = results[4]?.result?.content as Record<string, unknown>;
    const allPages = JSON.stringify([firstPage, secondPage]);
    assert.match(allPages, /first-line/);
    assert.match(allPages, /second-line/);
    assert.match(allPages, /second-error/);
    assert.equal(secondPage.cursor, firstLogCursor);
    assert.equal(secondPage.truncated, false);

    const runId = results[0]?.runId;
    assert.equal(typeof runId, 'string');
    const hostStatus = await client.request('execution.status', { sessionId, runId, executionId }) as Record<string, unknown>;
    assert.equal(hostStatus.state, 'exited');
    assert.equal(hostStatus.exitCode, 0);
    await assert.rejects(() => client.request('execution.status', { sessionId, runId, executionId, pid: 1 }), { code: 'protocol_args_invalid' });
    await assert.rejects(() => client.request('execution.status', { sessionId, runId: 'unrelated-run', executionId }), { code: 'run_not_found' });
    const hostLogs = await client.request('execution.logs', { sessionId, runId, executionId, cursor: firstLogCursor }) as Record<string, unknown>;
    assert.match(JSON.stringify(hostLogs), /second-line/);
    await client.request('session.close', { sessionId });
    const reopened = await restart();
    await reopened.request('session.open', { sessionId });
    const restoredStatus = await reopened.request('execution.status', { sessionId, runId, executionId }) as Record<string, unknown>;
    assert.equal(restoredStatus.state, 'exited');
    assert.equal(restoredStatus.logAvailable, true);
    const restoredLogs = await reopened.request('execution.logs', { sessionId, runId, executionId, cursor: firstLogCursor }) as Record<string, unknown>;
    assert.match(JSON.stringify(restoredLogs), /second-line/);
  }, {
    providerReply: (body) => {
      const previous = lastToolContent(body);
      if (step === 0) {
        step += 1;
        return { toolCalls: [{ tool: 'exec', args: {
          command: `node "${commandPath.replaceAll('\\', '/')}"`,
          waitMs: 25,
        } }] };
      }
      if (step === 1) {
        const result = previous;
        const id = result?.executionId;
        executionId = typeof id === 'string' ? id : undefined;
        step += 1;
        return { toolCalls: [{ tool: 'exec_control', args: { action: 'wait', executionId, waitMs: 800 } }] };
      }
      if (step === 2) {
        step += 1;
        return { toolCalls: [{ tool: 'exec_control', args: { action: 'logs', executionId } }] };
      }
      if (step === 3) {
        const cursor = previous?.nextCursor;
        firstLogCursor = typeof cursor === 'string' ? cursor : undefined;
        step += 1;
        return { toolCalls: [{ tool: 'exec_control', args: { action: 'wait', executionId, waitMs: 10_000 } }] };
      }
      if (step === 4) {
        step += 1;
        return { toolCalls: [{ tool: 'exec_control', args: { action: 'logs', executionId, cursor: firstLogCursor } }] };
      }
      step += 1;
      return { text: 'command checked' };
    },
    permission,
    permissionControl: true,
    config: { loop: { iterations: 8, modelCalls: 8 } },
    testDirectory: join(process.cwd(), 'testplace'),
  });
});

test('a log cursor older than the retained window reports the missing output range', {
  skip: process.platform !== 'win32' && process.platform !== 'linux',
  timeout: 30_000,
}, async () => {
  const permission = createPermissionContext('full-access', 'unrestricted', {
    filesystemRead: 'full', filesystemWrite: 'full', network: 'full', process: 'full',
  });
  let step = 0;
  let executionId: string | undefined;
  let commandPath = '';
  await withTuiHost(async ({ client, sessionId, projectDirectory }) => {
    commandPath = join(projectDirectory, 'large-finite-command.mjs');
    await mkdir(projectDirectory, { recursive: true });
    await writeFile(commandPath, "process.stdout.write(Buffer.alloc(300 * 1024, 65));\n");
    await client.request('workspace.trust', {
      projectRoot: projectDirectory, trusted: true, confirmWorkspaceTrust: true,
    });
    client.onRequest((message) => message.method === 'approval.request' ? { decision: 'allow' } : undefined);

    await client.request('run.start', { sessionId, input: 'run the large finite output check' });
    const { events } = await client.request('session.read', { sessionId }) as { events: ToolResult[] };
    const results = events.filter((event) => event.kind === 'tool' && (event.tool === 'exec' || event.tool === 'exec_control'));
    assert.equal(results.length, 3, JSON.stringify(results));
    const started = results[0]?.result?.content as Record<string, unknown>;
    executionId = typeof started.executionId === 'string' ? started.executionId : undefined;
    assert.equal(started.kind, 'execution', JSON.stringify(results));
    assert.equal(results[0]?.result?.failed, false);
    const settled = results[1]?.result?.content as Record<string, unknown>;
    assert.equal(settled.state, 'exited');
    assert.equal(settled.exitCode, 0);

    const page = results[2]?.result?.content as Record<string, unknown>;
    const pageEvents = page.events as { byteLength: number; stream: string; dataBase64: string }[];
    assert.equal(page.executionId, executionId);
    assert.equal(page.available, true);
    assert.equal(page.gap, true);
    assert.equal(page.truncated, true);
    assert.ok(Number(page.firstAvailableOffset) > 0);
    assert.deepEqual(page.missingRange, { fromOffset: 0, toOffset: page.firstAvailableOffset });
    assert.ok(Number(page.totalBytes) >= 300 * 1024);
    assert.ok(pageEvents.reduce((total, item) => total + item.byteLength, 0) <= 4 * 1024);
    assert.ok(pageEvents.every((item) => item.stream === 'stdout' && item.dataBase64.length > 0));
  }, {
    providerReply: (body) => {
      const previous = lastToolContent(body);
      if (step === 0) {
        step += 1;
        return { toolCalls: [{ tool: 'exec', args: {
          command: `node "${commandPath.replaceAll('\\', '/')}"`, waitMs: 0,
        } }] };
      }
      if (step === 1) {
        executionId = typeof previous?.executionId === 'string' ? previous.executionId : undefined;
        step += 1;
        return { toolCalls: [{ tool: 'exec_control', args: { action: 'wait', executionId, waitMs: 5_000 } }] };
      }
      if (step === 2) {
        step += 1;
        return { toolCalls: [{ tool: 'exec_control', args: { action: 'logs', executionId } }] };
      }
      return { text: 'bounded output checked' };
    },
    permission,
    permissionControl: true,
    modeName: 'full',
    config: { loop: { iterations: 8, modelCalls: 8 } },
    testDirectory: join(process.cwd(), 'testplace', 'tmp'),
  });
});
