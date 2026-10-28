import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, open, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHost } from '../dist/host/host.js';
import { createConfig } from '../dist/kernel/config.js';
import { createKernel } from '../dist/kernel/kernel.js';
import { createLoop } from '../dist/kernel/loop.js';
import { createDecisionChain } from '../dist/kernel/policy.js';
import { createPermissionContext } from '../dist/kernel/permission.js';
import { DEFAULT_PERMISSION_CONTEXT } from '../dist/kernel/permission.js';
import { createTelemetry } from '../dist/kernel/telemetry.js';

const testRoot = join(process.cwd(), 'testplace', 'telemetry-host');

async function filesUnder(directory) {
  const result = [];
  for (const instance of (await readdir(directory)).filter(name => name.startsWith('telemetry-'))) {
    const path = join(directory, instance);
    for (const name of await readdir(path)) result.push(await readFile(join(path, name), 'utf8'));
  }
  return result;
}

async function setupHost(t, { telemetry, provider, permission, policyMode = 'ask' } = {}) {
  await mkdir(testRoot, { recursive: true });
  const root = await mkdtemp(join(testRoot, 'case-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  const sessions = join(root, 'sessions');
  const telemetryDirectory = join(root, 'telemetry');
  await Promise.all([mkdir(project), mkdir(sessions), mkdir(telemetryDirectory)]);
  const config = createConfig({ user: {
    boundary: project,
    workspaceRoot: project,
    host: { sessionDirectory: sessions },
    loop: { iterations: 5, modelCalls: 5 },
    policy: { mode: policyMode },
  } });
  const client = {
    notify() {},
    async request(method, params) {
      if (method === 'approval.request') {
        approvals.push(params);
        return { decision: 'allow' };
      }
      return undefined;
    },
  };
  const approvals = [];
  const host = createHost({ config, provider, policy: config.policy, interactive: true,
    ...(permission === undefined ? {} : { permission }),
    ...(telemetry === true ? { telemetry: { enabled: true, directory: telemetryDirectory } } : {}),
  });
  t.after(async () => host.release());
  const { sessionId } = await host.handle({ method: 'session.create', params: {} }, client);
  return { host, client, project, sessions, sessionId, telemetryDirectory, approvals };
}

test('Host telemetry uses execution IDs plus Session and parent-call links, and excludes sensitive content', async (t) => {
  const provider = {
    name: 'vendor/local-test-provider',
    model: 'vendor/local-test-model',
    async *stream({ tools, messages }) {
      const hasChildTool = tools.some(tool => tool.name === 'subagent');
      const hasToolResult = messages.some(message => message.role === 'tool');
      if (hasChildTool && !hasToolResult) {
        yield { type: 'tool-call', id: 'parent-call-1', name: 'subagent', args: { task: 'child task' } };
        yield { type: 'usage', input: 3, output: 1 };
        yield { type: 'finish', reason: 'tool_calls' };
      } else if (!hasChildTool && !hasToolResult) {
        yield { type: 'tool-call', id: 'child-call-1', name: 'create', args: {
          path: 'child-secret-path.txt', content: 'CHILD_CONTENT_SECRET',
        } };
        yield { type: 'usage', input: 3, output: 1 };
        yield { type: 'finish', reason: 'tool_calls' };
      } else {
        yield { type: 'text', text: 'MODEL_OUTPUT_SECRET' };
        yield { type: 'usage', input: 3, output: 1 };
        yield { type: 'finish', reason: 'stop' };
      }
    },
  };
  const permission = createPermissionContext('workspace-write', 'policy', {
    filesystemRead: 'full', filesystemWrite: 'full', network: 'full', process: 'full',
  });
  const hostContext = await setupHost(t, { provider, permission, telemetry: true });
  await hostContext.host.handle({ method: 'run.start', params: { sessionId: hostContext.sessionId, input: 'PARENT_PROMPT_SECRET' } }, hostContext.client);
  assert.ok(hostContext.approvals.some(item => item.tool === 'create'));

  const parent = await hostContext.host.handle({ method: 'session.read', params: { sessionId: hostContext.sessionId } }, hostContext.client);
  const delegated = parent.events.find(event => event.kind === 'tool' && event.tool === 'subagent');
  assert.ok(delegated);
  const childSessionId = delegated.result.content.sessionId;
  assert.equal(typeof childSessionId, 'string');
  const childLines = (await readFile(join(hostContext.sessions, `${childSessionId}.jsonl`), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(childLines.some(event => event.kind === 'turn' && event.status === 'completed'));
  assert.ok(childLines.filter(event => event.kind === 'turn').every(event => event.runId === undefined));

  const records = (await filesUnder(hostContext.telemetryDirectory)).flatMap(text => text.trim().split('\n').map(JSON.parse));
  const parentStart = records.find(event => event.type === 'run.started' && event.sessionId === hostContext.sessionId);
  const childStart = records.find(event => event.type === 'run.started' && event.sessionId === childSessionId);
  assert.ok(parentStart);
  assert.ok(childStart);
  assert.match(parentStart.runId, /^[0-9a-f-]{36}$/u);
  assert.equal(childStart.runId, undefined);
  assert.equal(childStart.parentExecutionId, parentStart.executionId);
  assert.equal(childStart.parentRunId, parentStart.runId);
  assert.equal(childStart.parentCallId, 'parent-call-1');
  const approval = records.find(event => event.type === 'approval.finished' && event.callId === 'child-call-1');
  assert.ok(approval);
  assert.equal(approval.sessionId, childSessionId);
  assert.equal(approval.runId, undefined);
  assert.equal(approval.parentRunId, parentStart.runId);
  assert.equal(approval.executionId, childStart.executionId);
  assert.equal(approval.parentExecutionId, parentStart.executionId);
  assert.equal(approval.parentCallId, 'parent-call-1');
  assert.ok(records.some(event => event.type === 'tool.finished' && event.callId === 'parent-call-1' && event.outcome === 'success'));
  const model = records.find(event => event.type === 'model.finished' && event.executionId === parentStart.executionId);
  assert.ok(model);
  assert.equal(model.provider, undefined);
  assert.equal(model.model, undefined);
  assert.equal(model.inputTokens, 3);
  assert.equal(model.outputTokens, 1);
  assert.ok(model.durationMs >= 0);
  assert.doesNotMatch(JSON.stringify(records), /PARENT_PROMPT_SECRET|CHILD_CONTENT_SECRET|child-secret-path|MODEL_OUTPUT_SECRET/u);
});

test('Host defaults telemetry off', async (t) => {
  const provider = { async *stream() { yield { type: 'text', text: 'done' }; yield { type: 'finish', reason: 'stop' }; } };
  const context = await setupHost(t, { provider });
  await context.host.handle({ method: 'run.start', params: { sessionId: context.sessionId, input: 'ordinary input' } }, context.client);
  assert.deepEqual(await readdir(context.telemetryDirectory), []);
});

test('Host release stays bounded when the telemetry file flush never settles', async (t) => {
  const provider = { async *stream() { yield { type: 'text', text: 'done' }; yield { type: 'finish', reason: 'stop' }; } };
  const context = await setupHost(t, { provider, telemetry: true });
  await context.host.handle({ method: 'run.start', params: { sessionId: context.sessionId, input: 'create telemetry record' } }, context.client);
  const probe = await open(join(context.telemetryDirectory, 'probe'), 'w');
  const prototype = Object.getPrototypeOf(probe);
  const originalSync = prototype.sync;
  prototype.sync = () => new Promise(() => {});
  try {
    const started = Date.now();
    await context.host.release();
    assert.ok(Date.now() - started < 1_000);
  } finally {
    prototype.sync = originalSync;
    await probe.close();
  }
});

test('Loop classifies permission and tool restrictions as refused outcomes', async (t) => {
  await mkdir(testRoot, { recursive: true });
  const directory = await mkdtemp(join(testRoot, 'refusal-'));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const config = createConfig({ user: { boundary: directory } });
  const telemetry = createTelemetry({ enabled: true, directory });
  for (const [name, code, permission, restrict] of [
    ['write_file', 'permission_read_only', createPermissionContext('read-only', 'disabled', DEFAULT_PERMISSION_CONTEXT.capabilities), false],
    ['read_file', 'tool_denied', undefined, true],
  ]) {
    const kernel = createKernel({ config, ...(permission === undefined ? {} : { permission }), policy: createDecisionChain({ mode: 'auto' }) });
    kernel.register({ name, description: name, access: name === 'write_file' ? 'write' : 'read',
      parameters: { type: 'object', properties: {} }, run: () => 'unused' });
    if (restrict) kernel.restrict([name]);
    let modelCalls = 0;
    const provider = { async *stream() {
      modelCalls += 1;
      if (modelCalls === 1) {
        yield { type: 'tool-call', id: `${name}-call`, name, args: {} };
        yield { type: 'finish', reason: 'tool_calls' };
      } else {
        yield { type: 'text', text: 'finished' };
        yield { type: 'finish', reason: 'stop' };
      }
    } };
    const loop = createLoop({ kernel, provider, telemetry, sessionId: `session-${name}` });
    await loop.run('input');
  }
  await telemetry.shutdown();
  const records = (await filesUnder(directory)).flatMap(text => text.trim().split('\n').map(JSON.parse));
  for (const callId of ['write_file-call', 'read_file-call']) {
    assert.ok(records.some(event => event.type === 'tool.finished' && event.callId === callId && event.outcome === 'refused'));
  }
});
