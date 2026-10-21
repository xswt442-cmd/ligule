import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createConfig, createDecisionChain, createKernel, createManagedProcessRegistry, createPermissionContext, managedProcessPlugin } from '../dist/index.js';
import { setTrusted } from '../dist/kernel/workspace-trust.js';

const permission = createPermissionContext('workspace-write', 'unrestricted', {
  filesystemRead: 'partial', filesystemWrite: 'partial', network: 'partial', process: 'full',
}, {
  profiles: { readOnly: 'partial', workspaceWrite: 'partial' },
  limitations: ['Windows workspace-write provides partial filesystem and network isolation.'],
  partialWorkspaceWriteConfirmationRequired: true,
  partialWorkspaceWriteConfirmed: true,
  workspaceTrusted: true,
});

async function availableLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.notEqual(address, null);
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitForRequest(url) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      return response;
    } catch {
      await delay(20);
    }
  }
  assert.fail(`server at ${url} did not accept an HTTP request`);
}

async function waitForUnavailable(url) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      await response.body?.cancel();
    } catch {
      return;
    }
    await delay(20);
  }
  assert.fail(`server at ${url} remained reachable`);
}

async function waitForFile(path, within = 5_000) {
  const deadline = Date.now() + within;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await delay(20);
  }
  assert.fail(`file ${path} was not created`);
}

test('managed process start returns after loopback readiness and stop releases its port', async (t) => {
  const previousHome = process.env.LIGULE_HOME;
  const directory = await mkdtemp(join(tmpdir(), 'ligule-managed-process-'));
  const workspace = join(directory, 'workspace');
  const home = join(directory, 'home');
  await Promise.all([mkdir(workspace), mkdir(home)]);
  process.env.LIGULE_HOME = home;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.LIGULE_HOME;
    else process.env.LIGULE_HOME = previousHome;
    await rm(directory, { recursive: true, force: true });
  });
  const port = await availableLoopbackPort();
  const url = `http://127.0.0.1:${port}/`;
  await writeFile(join(workspace, 'server.mjs'), "import { createServer } from 'node:http';\nconst port = Number(process.argv[2]);\ncreateServer((request, response) => response.end('managed-ready')).listen(port, '127.0.0.1', () => console.log(`listening ${port}`));\n");
  const command = `node "${join(workspace, 'server.mjs').replaceAll('\\', '/')}" ${port}`;
  const kernel = createKernel({
    config: createConfig({ user: { boundary: workspace } }),
    policy: createDecisionChain({ mode: 'auto', ask: async () => true }),
    permission,
  });
  await setTrusted(workspace, true);
  let grantActive = true;
  const registry = createManagedProcessRegistry({
    validateOwner: async () => {
      if (!grantActive) throw new Error('delegation grant revoked');
    },
  });
  const dispose = managedProcessPlugin(registry).setup(kernel);
  t.after(async () => {
    await dispose();
    await registry.close();
  });

  const started = await kernel.call('managed_process', { action: 'start', command, readyUrl: url });
  assert.equal(started.status, 'running');
  assert.equal(started.ready, true);
  assert.equal(started.port, port);
  const response = await waitForRequest(url);
  assert.equal(await response.text(), 'managed-ready');

  const status = await kernel.call('managed_process', { action: 'status', id: started.id });
  assert.equal(status.status, 'running');
  assert.match(status.logs, /listening/);

  const stopped = await kernel.call('managed_process', { action: 'stop', id: started.id });
  assert.equal(stopped.status, 'stopped');
  await waitForUnavailable(url);

  const latePort = await availableLoopbackPort();
  const lateUrl = `http://127.0.0.1:${latePort}/`;
  const latePath = join(workspace, 'late-server.mjs');
  const startedMarker = join(workspace, 'late-server-started.txt');
  const lateMarker = join(workspace, 'late-server-ran.txt');
  await writeFile(latePath, [
    "import { writeFileSync } from 'node:fs';",
    "import { createServer } from 'node:http';",
    `writeFileSync(${JSON.stringify(startedMarker)}, 'started');`,
    `setTimeout(() => { writeFileSync(${JSON.stringify(lateMarker)}, 'late'); createServer((_request, response) => response.end('late')).listen(${latePort}, '127.0.0.1'); }, 800);`,
  ].join('\n'));
  const controller = new AbortController();
  const pendingStart = kernel.call('managed_process', {
    action: 'start',
    command: `node "${latePath.replaceAll('\\', '/')}"`,
    readyUrl: lateUrl,
  }, { signal: controller.signal });
  await waitForFile(startedMarker);
  controller.abort();
  await assert.rejects(pendingStart, { code: 'exec_cancelled' });
  await delay(1_000);
  assert.equal(existsSync(lateMarker), false, 'cancellation prevents the delayed server from starting');
  await waitForUnavailable(lateUrl);

  const shortPort = await availableLoopbackPort();
  const shortUrl = `http://127.0.0.1:${shortPort}/`;
  const shortPath = join(workspace, 'short-server.mjs');
  await writeFile(shortPath, [
    "import { createServer } from 'node:http';",
    `const server = createServer((_request, response) => response.end('short-lived'));`,
    `server.listen(${shortPort}, '127.0.0.1', () => setTimeout(() => process.exit(0), 250));`,
  ].join('\n'));
  let shortStarted;
  try {
    shortStarted = await kernel.call('managed_process', {
      action: 'start',
      command: `node "${shortPath.replaceAll('\\', '/')}"`,
      readyUrl: shortUrl,
    });
  } catch (error) {
    assert.ok(['managed_process_exited', 'managed_process_not_ready'].includes(error.code), error.code);
  }
  await waitForUnavailable(shortUrl);
  await delay(100);
  if (shortStarted !== undefined) {
    const deadline = Date.now() + 2_000;
    let status;
    while (Date.now() < deadline) {
      status = await kernel.call('managed_process', { action: 'status', id: shortStarted.id });
      if (status.status !== 'running') break;
      await delay(20);
    }
    assert.notEqual(status.status, 'running', JSON.stringify(status));
  }

  const revokedPort = await availableLoopbackPort();
  const revokedUrl = `http://127.0.0.1:${revokedPort}/`;
  const revoked = await kernel.call('managed_process', {
    action: 'start',
    command: `node "${join(workspace, 'server.mjs').replaceAll('\\', '/')}" ${revokedPort}`,
    readyUrl: revokedUrl,
  });
  assert.equal((await waitForRequest(revokedUrl)).status, 200);
  grantActive = false;
  await waitForUnavailable(revokedUrl);
  const revokedStatusDeadline = Date.now() + 2_000;
  let revokedStatus;
  while (Date.now() < revokedStatusDeadline) {
    revokedStatus = await kernel.call('managed_process', { action: 'status', id: revoked.id });
    if (revokedStatus.status === 'stopped') break;
    await delay(20);
  }
  assert.equal(revokedStatus.status, 'stopped', JSON.stringify(revokedStatus));
  assert.match(revokedStatus.failure, /Grant is no longer valid/);
});

test('an exec Policy denial also blocks managed start before spawning the command', async (t) => {
  const port = await availableLoopbackPort();
  const registry = createManagedProcessRegistry();
  const kernel = createKernel({
    config: createConfig({ user: { boundary: process.cwd() } }),
    policy: createDecisionChain({ rules: [{ tool: 'exec', decision: 'deny' }] }),
    permission,
  });
  const dispose = managedProcessPlugin(registry).setup(kernel);
  t.after(async () => {
    await dispose();
    await registry.close();
  });

  await assert.rejects(
    () => kernel.call('managed_process', {
      action: 'start',
      command: `node -e "require('http').createServer((request, response) => response.end('should-not-run')).listen(${port}, '127.0.0.1')"`,
      readyUrl: `http://127.0.0.1:${port}/`,
    }),
    { code: 'policy_denied' },
  );
  await assert.rejects(() => fetch(`http://127.0.0.1:${port}/`));
});

test('managed process refuses readiness URLs outside loopback before starting a command', async () => {
  const kernel = createKernel({
    config: createConfig({ user: { boundary: process.cwd() } }),
    policy: createDecisionChain({ mode: 'auto', ask: async () => true }),
    permission,
  });
  await setTrusted(process.cwd(), true);
  const registry = createManagedProcessRegistry();
  const dispose = managedProcessPlugin(registry).setup(kernel);
  try {
    await assert.rejects(
      () => kernel.call('managed_process', { action: 'start', command: 'node -e "process.exit(0)"', readyUrl: 'https://example.com/' }),
      { code: 'managed_process_url_invalid' },
    );
  } finally {
    await dispose();
    await registry.close();
  }
});
