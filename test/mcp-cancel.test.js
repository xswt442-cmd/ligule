import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  createConfig, createConnection, createMemoryConnectionPair, createMcpRegistry, MESSAGES_CAPABILITIES,
  modeDirectories, mcpServerConfigs, serveHost,
} from '../dist/index.js';

const fixturePath = fileURLToPath(new URL('./fixtures/mcp-cancellable.mjs', import.meta.url));

async function withDirectory(run) {
  const testplace = resolve('testplace');
  await mkdir(testplace, { recursive: true });
  const directory = await mkdtemp(join(testplace, 'mcp-cancel-'));
  const absoluteDirectory = resolve(directory);
  assert.equal(absoluteDirectory.startsWith(`${testplace}${process.platform === 'win32' ? '\\' : '/'}`), true);
  try {
    await run(directory);
  } finally {
    await rm(absoluteDirectory, { recursive: true, force: true });
  }
}

async function waitForFile(path) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await delay(20);
    }
  }
  throw new Error(`mcp_fixture_marker_missing: ${path}`);
}

async function waitForProcessExit(pid) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') return;
      throw error;
    }
    await delay(25);
  }
  throw new Error(`mcp_fixture_process_still_running: ${pid}`);
}

function registryFor(directory, { initializeDelay = 0, listDelay = 0 } = {}) {
  const pidPath = join(directory, 'mcp.pid');
  const listStartedPath = join(directory, 'list.started');
  const callStartedPath = join(directory, 'call.started');
  const configs = mcpServerConfigs({ mcp: { servers: { slow: {
    command: process.execPath,
    args: [fixturePath, pidPath, listStartedPath, callStartedPath, String(initializeDelay), String(listDelay)],
  } } } });
  return { registry: createMcpRegistry(configs), pidPath, listStartedPath, callStartedPath };
}

async function rejectedQuickly(promise) {
  const outcome = await Promise.race([
    promise.then(() => ({ status: 'resolved' }), (error) => ({ status: 'rejected', error })),
    delay(2000).then(() => ({ status: 'timeout' })),
  ]);
  assert.equal(outcome.status, 'rejected', 'the SDK request rejects promptly after cancellation');
  return outcome.error;
}

test('the SDK cancels a real delayed MCP tool call through AbortSignal', async () => {
  await withDirectory(async (directory) => {
    const { registry, pidPath, callStartedPath } = registryFor(directory);
    try {
      const definition = await registry.definition('slow', 'wait');
      assert.equal(definition.name, 'wait');
      const controller = new AbortController();
      const pending = registry.call('slow', 'wait', { milliseconds: 30000 }, controller.signal);
      await waitForFile(callStartedPath);
      const cancelled = rejectedQuickly(pending);
      controller.abort();
      const error = await cancelled;
      assert.ok(error instanceof Error);
    } finally {
      await registry.close();
    }
    await waitForProcessExit(Number(await readFile(pidPath, 'utf8')));
  });
});

test('cancellation stops MCP initialization and tools/list requests', async () => {
  await withDirectory(async (directory) => {
    const initializing = registryFor(directory, { initializeDelay: 30000 });
    try {
      const controller = new AbortController();
      const pending = initializing.registry.toolsOf('slow', controller.signal);
      await waitForFile(initializing.pidPath);
      await delay(50);
      const cancelled = rejectedQuickly(pending);
      controller.abort();
      assert.ok(await cancelled instanceof Error);
    } finally {
      await initializing.registry.close();
    }
    await waitForProcessExit(Number(await readFile(initializing.pidPath, 'utf8')));

    const listing = registryFor(directory, { listDelay: 30000 });
    try {
      const controller = new AbortController();
      const pending = listing.registry.toolsOf('slow', controller.signal);
      await waitForFile(listing.listStartedPath);
      const cancelled = rejectedQuickly(pending);
      controller.abort();
      assert.ok(await cancelled instanceof Error);
    } finally {
      await listing.registry.close();
    }
    await waitForProcessExit(Number(await readFile(listing.pidPath, 'utf8')));
  });
});

test('Host shutdown cancels an MCP operation and ends its stdio server', { timeout: 15000 }, async () => {
  await withDirectory(async (directory) => {
    const project = join(directory, 'project');
    const home = join(directory, 'home');
    const sessionDirectory = join(directory, 'sessions');
    await Promise.all([mkdir(project), mkdir(home), mkdir(sessionDirectory)]);
    const pidPath = join(directory, 'mcp.pid');
    const listStartedPath = join(directory, 'list.started');
    const callStartedPath = join(directory, 'call.started');
    const config = createConfig({ user: {
      boundary: project,
      host: { sessionDirectory },
      model: { api: 'messages', baseURL: 'http://127.0.0.1:1', model: 'host-cancel-test' },
      loop: { iterations: 4, modelCalls: 4 },
      mcp: { servers: { slow: {
        command: process.execPath,
        args: [fixturePath, pidPath, listStartedPath, callStartedPath, '0', '0'],
      } } },
      policy: { mode: 'auto' },
    } });
    let phase = 0;
    const provider = {
      name: 'local-operation-provider',
      model: 'host-cancel-test',
      capabilities: MESSAGES_CAPABILITIES,
      async *stream(request, { signal } = {}) {
        if (signal?.aborted) throw signal.reason;
        const lastUser = [...request.messages].reverse().find((message) => message.role === 'user');
        const operation = JSON.parse(lastUser.text);
        if (operation.tool === 'mcp.inspect' && phase === 0) {
          phase += 1;
          yield { type: 'tool-call', id: 'inspect', name: 'mcp.inspect', args: operation.args };
        } else if (operation.tool === 'mcp.inspect') {
          yield { type: 'text', text: 'definition read' };
        } else {
          yield { type: 'tool-call', id: 'call', name: 'mcp.call', args: operation.args };
        }
      },
    };
    const pair = createMemoryConnectionPair();
    const host = serveHost({
      ...pair.host,
      config,
      provider,
      policy: config.policy,
      modeName: 'minimal',
      modePaths: modeDirectories(project, fileURLToPath(new URL('../modes/', import.meta.url)), home),
    });
    const client = createConnection(pair.client);
    try {
      const { sessionId } = await client.request('session.create', {});
      await client.request('run.start', {
        sessionId,
        input: JSON.stringify({ tool: 'mcp.inspect', args: { server: 'slow', tool: 'wait' } }),
      });
      const { events } = await client.request('session.read', { sessionId });
      const inspected = events.find((event) => event.kind === 'tool' && event.tool === 'mcp.inspect');
      const schemaDigest = inspected.result.content.schemaDigest;
      const callInput = JSON.stringify({
        tool: 'mcp.call',
        args: {
          server: 'slow',
          tool: 'wait',
          arguments: JSON.stringify({ milliseconds: 30000 }),
          schemaDigest,
        },
      });
      const startedAt = Date.now();
      const settled = client.request('run.start', { sessionId, input: callInput }).then(
        (value) => ({ status: 'resolved', value }),
        (error) => ({ status: 'rejected', error }),
      );
      await waitForFile(callStartedPath);
      const processId = Number(await readFile(pidPath, 'utf8'));
      await host.release();
      const result = await settled;
      assert.equal(result.status, 'rejected');
      assert.ok(Date.now() - startedAt < 5000, 'Host shutdown finishes the delayed operation promptly');
      await waitForProcessExit(processId);
    } finally {
      pair.client.output.end();
      await host.release();
    }
  });
});
