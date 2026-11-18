import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createPermissionContext } from '../dist/kernel/permission.js';
import { VIEW_REQUEST_METHOD } from '../dist/host/protocol.js';
import { withTuiHost } from './helpers/tui-host.ts';

const readableUiPermission = createPermissionContext('full-access', 'disabled', {
  filesystemRead: 'full', filesystemWrite: 'unavailable', network: 'unavailable', process: 'unavailable',
});
const commandUiPermission = createPermissionContext('full-access', 'unrestricted', {
  filesystemRead: 'full', filesystemWrite: 'full', network: 'full', process: 'full',
});

async function runViewRequest({ kind, path, responseStatus = 'sent' }: {
  readonly kind: 'file' | 'directory' | 'diff';
  readonly path: string;
  readonly responseStatus?: 'sent' | 'view_unavailable';
}) {
  let providerCall = 0;
  return await withTuiHost(async ({ client, sessionId, projectDirectory, providerRequests }) => {
    await mkdir(join(projectDirectory, 'src'), { recursive: true });
    await writeFile(join(projectDirectory, 'src', 'note.md'), 'A bounded file reference for the model view request.\n');
    if (kind === 'diff') {
      execFileSync('git', ['init', '--quiet'], { cwd: projectDirectory, windowsHide: true });
      execFileSync('git', ['config', 'user.name', 'Ligule view test'], { cwd: projectDirectory, windowsHide: true });
      execFileSync('git', ['config', 'user.email', 'ligule-view-test@example.invalid'], { cwd: projectDirectory, windowsHide: true });
      execFileSync('git', ['add', '--', 'src/note.md'], { cwd: projectDirectory, windowsHide: true });
      execFileSync('git', ['-c', 'user.name=Ligule view test', '-c', 'user.email=ligule-view-test@example.invalid',
        'commit', '--quiet', '-m', 'baseline'], { cwd: projectDirectory, windowsHide: true });
      await writeFile(join(projectDirectory, 'src', 'note.md'), 'Current bounded file reference for the model view request.\n');
    }
    const viewRequests: Record<string, unknown>[] = [];
    const approvalRequests: Record<string, unknown>[] = [];
    client.onRequest(message => {
      if (message.method === 'approval.request') {
        const params = message.params as Record<string, unknown>;
        assert.equal(params.tool, 'open_resource');
        approvalRequests.push(params);
        return { decision: 'allow' };
      }
      if (message.method !== VIEW_REQUEST_METHOD) return { status: 'view_unavailable' };
      const params = message.params as Record<string, unknown>;
      assert.equal(params.sessionId, sessionId);
      viewRequests.push(params);
      return { status: responseStatus };
    });
    await client.request('run.start', { sessionId, input: 'Inspect the selected project resource.' });
    assert.ok(providerRequests[0]?.tools?.some(tool => tool.function.name === 'open_resource'),
      JSON.stringify(providerRequests[0]?.tools?.map(tool => tool.function.name)));
    assert.equal(providerRequests.length, 2);
    const toolResult = providerRequests[1]?.messages.find(message => message.role === 'tool');
    assert.equal(typeof toolResult?.content, 'string');
    const sessionRecord = await client.request('session.read', { sessionId, fullResults: true }) as { events: Record<string, unknown>[] };
    return { sessionId, projectDirectory, providerRequests, viewRequests, approvalRequests,
      sessionEvents: sessionRecord.events, toolResult: String(toolResult?.content) };
  }, {
    permissionControl: true,
    permission: readableUiPermission,
    providerReply: async () => {
      providerCall += 1;
      if (providerCall === 1) return { toolCalls: [{ tool: 'open_resource', args: { kind, path } }] };
      return { text: 'View request completed.' };
    },
  });
}

test('open_resource verifies the file source and returns only a delivered reference', async () => {
  const result = await runViewRequest({ kind: 'file', path: 'src/note.md' });
  assert.equal(result.viewRequests.length, 1, result.toolResult);
  assert.equal(result.approvalRequests.length, 1, 'the ordinary policy approval remains in force for this model tool');
  const request = result.viewRequests[0];
  assert.equal(request.sessionId, result.sessionId);
  assert.equal(typeof request.runId, 'string');
  assert.deepEqual(request.target, {
    kind: 'file', projectRoot: result.projectDirectory, path: 'src/note.md',
    version: (request.target as { version: string }).version,
  });
  assert.match((request.target as { version: string }).version, /^[a-f0-9]{16}$/u);
  assert.match(result.toolResult, /"status":"sent"/u);
  assert.match(result.toolResult, /"opened":false/u);
  assert.match(result.toolResult, /"read":false/u);
  assert.equal(result.sessionEvents.some(event => event.kind === 'viewRequest' && event.targetKind === 'file'), true);
  assert.equal(result.sessionEvents.some(event => event.kind === 'viewRequestDelivered'), true);
  assert.equal(result.sessionEvents.some(event => event.kind === 'viewRequestOpened' || event.kind === 'viewRequestDismissed'), false);
  assert.doesNotMatch(result.toolResult, /A bounded file reference/u);
});

test('open_resource binds a Git diff request to the current diff snapshot', async () => {
  const result = await runViewRequest({ kind: 'diff', path: 'src/note.md' });
  assert.equal(result.viewRequests.length, 1, result.toolResult);
  const target = result.viewRequests[0]?.target as { kind: string; projectRoot: string; path: string; version: string };
  assert.deepEqual({ kind: target.kind, projectRoot: target.projectRoot, path: target.path },
    { kind: 'git', projectRoot: result.projectDirectory, path: 'src/note.md' });
  assert.match(target.version, /^[a-f0-9]{64}$/u);
  assert.match(result.toolResult, /"status":"sent"/u);
  assert.equal(result.sessionEvents.some(event => event.kind === 'viewRequestDelivered'), true);
});

test('open_resource reports an unavailable Desktop view without claiming it opened the resource', async () => {
  const result = await runViewRequest({ kind: 'directory', path: '.' , responseStatus: 'view_unavailable' });
  assert.equal(result.viewRequests.length, 1);
  assert.equal(result.sessionEvents.some(event => event.kind === 'viewRequestUnavailable'), true);
  assert.deepEqual(result.viewRequests[0]?.target, { kind: 'directory', projectRoot: result.projectDirectory, path: '.' });
  assert.match(result.toolResult, /"status":"view_unavailable"/u);
  assert.match(result.toolResult, /"opened":false/u);
  assert.match(result.toolResult, /"read":false/u);
});

test('open_resource rejects an out-of-bound diff before sending a Desktop request', async () => {
  const result = await runViewRequest({ kind: 'diff', path: '../outside.txt' });
  assert.equal(result.viewRequests.length, 0);
  assert.match(result.toolResult, /project_file_path_invalid/u);
  assert.equal(result.sessionEvents.some(event => String(event.kind).startsWith('viewRequest')), false);
});

test('open_resource binds a command handle to an operation owned by the source Session', async () => {
  let providerCall = 0;
  let executionId = '';
  await withTuiHost(async ({ client, sessionId, projectDirectory, providerRequests }) => {
    await client.request('workspace.trust', {
      projectRoot: projectDirectory, trusted: true, confirmWorkspaceTrust: true,
    });
    const viewRequests: Record<string, unknown>[] = [];
    const approvedTools: string[] = [];
    client.onRequest(message => {
      if (message.method === 'approval.request') {
        const params = message.params as Record<string, unknown>;
        approvedTools.push(String(params.tool));
        return { decision: 'allow' };
      }
      if (message.method === VIEW_REQUEST_METHOD) {
        viewRequests.push(message.params as Record<string, unknown>);
        return { status: 'sent' };
      }
      return { status: 'view_unavailable' };
    });
    const operation = await client.request('operation.start', { sessionId, command: 'node --version' }) as {
      operationSessionId: string; operationId: string; executionId: string;
    };
    assert.equal(typeof operation.executionId, 'string');
    executionId = operation.executionId;
    await client.request('run.start', { sessionId, input: 'Open the command output.' });
    assert.ok(approvedTools.includes('exec'), 'starting the command retains the ordinary execution approval');
    assert.equal(viewRequests.length, 1);
    const request = viewRequests[0];
    assert.equal(request.sessionId, sessionId);
    const target = request.target as { kind: string; reference: Record<string, string> };
    assert.equal(target.kind, 'command');
    assert.deepEqual(target.reference, {
      sourceSessionId: sessionId,
      operationSessionId: operation.operationSessionId,
      operationId: operation.operationId,
      executionId: operation.executionId,
    });
    const sourceRecord = await client.request('session.read', { sessionId, fullResults: true }) as { events: Record<string, unknown>[] };
    assert.equal(sourceRecord.events.some(event => event.kind === 'viewRequest' && event.targetKind === 'command'), true);
    assert.equal(sourceRecord.events.some(event => event.kind === 'viewRequestDelivered'), true);
    assert.equal(providerRequests.length, 2);
    const toolResult = providerRequests[1]?.messages.find(message => message.role === 'tool')?.content;
    assert.match(String(toolResult), /"status":"sent"/u);
  }, {
    permissionControl: true,
    permission: commandUiPermission,
    providerReply: async () => {
      providerCall += 1;
      if (providerCall === 1) return { toolCalls: [{ tool: 'open_resource', args: { kind: 'command', executionId } }] };
      return { text: 'Command reference requested.' };
    },
  });
});

test('open_resource binds a direct subrun reference to the active parent Run', async () => {
  let releaseParentProvider = () => {};
  let markParentProviderStarted = () => {};
  const parentProviderStarted = new Promise<void>(resolve => { markParentProviderStarted = resolve; });
  const parentProviderGate = new Promise<void>(resolve => { releaseParentProvider = resolve; });
  let subrunId = '';
  let parentToolIssued = false;
  let providerCall = 0;
  const viewRequests: Record<string, unknown>[] = [];
  await withTuiHost(async ({ client, sessionId, providerRequests }) => {
    client.onRequest(message => {
      if (message.method === 'approval.request') return { decision: 'allow' };
      if (message.method === VIEW_REQUEST_METHOD) {
        viewRequests.push(message.params as Record<string, unknown>);
        return { status: 'sent' };
      }
      return { status: 'view_unavailable' };
    });
    const parentRun = client.request('run.start', { sessionId, input: 'parent view task' });
    try {
      await parentProviderStarted;
      const parentStatus = await client.request('status.get', { sessionId }) as { activeRunId?: string };
      assert.ok(parentStatus.activeRunId);
      const child = await client.request('subrun.start', {
        sessionId, parentRunId: parentStatus.activeRunId, task: 'child view task',
      }) as { subrunId: string; sessionId: string; runId: string };
      subrunId = child.subrunId;
      releaseParentProvider();
      await parentRun;

      assert.equal(viewRequests.length, 1);
      assert.equal(viewRequests[0]?.sessionId, sessionId);
      assert.equal(viewRequests[0]?.runId, parentStatus.activeRunId);
      assert.deepEqual(viewRequests[0]?.target, {
        kind: 'subrun', sessionId, parentRunId: parentStatus.activeRunId,
        subrunId: child.subrunId, childSessionId: child.sessionId, childRunId: child.runId,
      });
      const sourceRecord = await client.request('session.read', { sessionId, fullResults: true }) as { events: Record<string, unknown>[] };
      assert.equal(sourceRecord.events.some(event => event.kind === 'viewRequest' && event.targetKind === 'subrun'), true);
      assert.equal(sourceRecord.events.some(event => event.kind === 'viewRequestDelivered'), true);
      assert.equal(providerRequests.length >= 3, true, 'both the parent and child used the deterministic Provider');
      const result = providerRequests.find(request => request.messages.some(message => message.role === 'tool'
        && typeof message.content === 'string' && message.content.includes('"status":"sent"')));
      assert.ok(result, 'the parent model receives only the view delivery status');
    } finally {
      releaseParentProvider();
      await parentRun.catch(() => undefined);
    }
  }, {
    permissionControl: true,
    permission: readableUiPermission,
    config: { loop: { iterations: 8, modelCalls: 8 } },
    providerReply: async body => {
      providerCall += 1;
      const lastUser = [...body.messages].reverse().find(message => message.role === 'user');
      const content = typeof lastUser?.content === 'string' ? lastUser.content : '';
      if (content.includes('child view task')) return { text: 'Child task completed.' };
      if (providerCall === 1 && !parentToolIssued) {
        markParentProviderStarted();
        await parentProviderGate;
        parentToolIssued = true;
        return { toolCalls: [{ tool: 'open_resource', args: { kind: 'subrun', subrunId } }] };
      }
      return { text: 'Parent task completed.' };
    },
  });
});
