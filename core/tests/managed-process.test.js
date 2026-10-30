import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createConfig, createDecisionChain, createKernel, createManagedProcessRegistry, createPermissionContext, managedProcessPlugin, managedProcessTool } from '../dist/index.js';
import { isTrusted, setTrusted } from '../dist/kernel/workspace-trust.js';

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

  let started;
  try {
    started = await kernel.call('managed_process', { action: 'start', command, readyUrl: url });
  } catch (error) {
    if (process.platform === 'linux' && error?.code === 'permission_sandbox_unavailable'
      && String(error.detail ?? '').includes('bwrap: setting up uid map: Permission denied')) {
      t.skip('this Linux runner denies bubblewrap user-namespace mapping');
      return;
    }
    throw error;
  }
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
    `writeFileSync(new URL('./late-server-started.txt', import.meta.url), 'started');`,
    `setTimeout(() => { writeFileSync(new URL('./late-server-ran.txt', import.meta.url), 'late'); createServer((_request, response) => response.end('late')).listen(${latePort}, '127.0.0.1'); }, 800);`,
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

test('managed process waits for a successful health response after a transient HTTP 503', async (t) => {
  let healthy = false;
  let requests = 0;
  const server = createHttpServer((_request, response) => {
    requests += 1;
    response.statusCode = healthy ? 200 : 503;
    response.end();
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.notEqual(address, null);
  const registry = createManagedProcessRegistry();
  let finishLease;
  const lease = {
    completion: new Promise((resolve) => { finishLease = resolve; }),
    logs: () => '',
    async stop() { finishLease(0); },
  };
  t.after(async () => {
    await registry.close();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  let settled = false;
  const pending = registry.start(new URL(`http://127.0.0.1:${address.port}/health`), lease).finally(() => { settled = true; });
  const deadline = Date.now() + 1_000;
  while (requests === 0 && Date.now() < deadline) await delay(10);
  assert.ok(requests > 0, 'readiness URL was checked');
  await delay(250);
  assert.equal(settled, false, 'HTTP 503 is not readiness');
  assert.ok(requests <= 6, `HTTP 503 retry was not bounded: ${requests} requests in 250ms`);

  healthy = true;
  const started = await pending;
  assert.equal(started.ready, true);
  assert.equal(started.status, 'running');
});

test('managed process becomes ready immediately on HTTP 200 without a retry delay', async (t) => {
  let requests = 0;
  const server = createHttpServer((_request, response) => {
    requests += 1;
    response.statusCode = 200;
    response.end();
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.notEqual(address, null);
  const registry = createManagedProcessRegistry();
  let finishLease;
  const lease = {
    completion: new Promise((resolve) => { finishLease = resolve; }),
    logs: () => '',
    async stop() { finishLease(0); },
  };
  t.after(async () => {
    await registry.close();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  const startedAt = Date.now();
  const started = await registry.start(new URL(`http://127.0.0.1:${address.port}/health`), lease);
  assert.equal(started.ready, true);
  assert.equal(requests, 1);
  assert.ok(Date.now() - startedAt < 500, 'HTTP 200 should not wait for the retry interval');
});

test('managed process retries after a timed-out health request and observes cancellation', async (t) => {
  let requests = 0;
  const server = createHttpServer(() => { requests += 1; });
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.notEqual(address, null);
  const registry = createManagedProcessRegistry();
  let finishLease;
  const lease = {
    completion: new Promise((resolve) => { finishLease = resolve; }),
    logs: () => '',
    async stop() { finishLease(0); },
  };
  const controller = new AbortController();
  t.after(async () => {
    await registry.close();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  const pending = registry.start(new URL(`http://127.0.0.1:${address.port}/health`), lease, controller.signal);
  const secondRequestDeadline = Date.now() + 1_800;
  while (requests < 2 && Date.now() < secondRequestDeadline) await delay(10);
  assert.equal(requests, 2, 'a timed-out request should be followed by a delayed retry');
  controller.abort();
  await assert.rejects(pending, { code: 'exec_cancelled' });
  assert.equal(requests, 2, 'cancellation should stop further probes');
});

test('managed process readiness exits promptly when the owned process terminates', async (t) => {
  let requests = 0;
  const server = createHttpServer((_request, response) => {
    requests += 1;
    response.statusCode = 503;
    response.end();
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.notEqual(address, null);
  const registry = createManagedProcessRegistry();
  let finishLease;
  const lease = {
    completion: new Promise((resolve) => { finishLease = resolve; }),
    logs: () => '',
    async stop() { finishLease(0); },
  };
  t.after(async () => {
    await registry.close();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  const pending = registry.start(new URL(`http://127.0.0.1:${address.port}/health`), lease);
  const firstRequestDeadline = Date.now() + 1_000;
  while (requests === 0 && Date.now() < firstRequestDeadline) await delay(10);
  assert.equal(requests, 1);
  finishLease(1);
  await assert.rejects(pending, { code: 'managed_process_exited' });
  assert.equal(requests, 1, 'process exit should stop further readiness probes');
});

test('managed process checks an IPv6 readiness port on IPv6 loopback', async (t) => {
  const server = net.createServer();
  try {
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '::1', resolve));
  } catch (error) {
    if (['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'ENOTSUP'].includes(error?.code)) {
      t.skip('IPv6 loopback is unavailable on this host');
      return;
    }
    throw error;
  }
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.notEqual(address, null);
  const tool = managedProcessTool(createManagedProcessRegistry());
  await assert.rejects(tool.preflight({
    action: 'start', command: 'node -e "process.exit(0)"', readyUrl: `http://[::1]:${address.port}/`,
  }), { code: 'managed_process_port_in_use' });
});

test('revoking shared workspace trust stops a managed process that started from trusted project code', { timeout: 15_000 }, async (t) => {
  const testplace = join(process.cwd(), 'testplace');
  await mkdir(testplace, { recursive: true });
  const directory = await mkdtemp(join(testplace, 'managed-process-trust-revocation-'));
  const workspace = join(directory, 'workspace');
  const home = join(directory, 'home');
  await Promise.all([mkdir(workspace), mkdir(home)]);
  const previousHome = process.env.LIGULE_HOME;
  process.env.LIGULE_HOME = home;
  const port = await availableLoopbackPort();
  const url = `http://127.0.0.1:${port}/`;
  const script = join(workspace, 'server.mjs');
  await writeFile(script, "import { createServer } from 'node:http';\nconst port = Number(process.argv[2]);\ncreateServer((_request, response) => response.end('trusted-server-ready')).listen(port, '127.0.0.1');\n");
  await setTrusted(workspace, true);
  const registry = createManagedProcessRegistry({
    async validateWorkspaceTrust() {
      if (!(await isTrusted(workspace))) throw new Error('workspace trust was revoked');
    },
  });
  const kernel = createKernel({
    config: createConfig({ user: { boundary: workspace, workspaceRoot: workspace } }),
    policy: createDecisionChain({ mode: 'auto', ask: async () => true }),
    permission,
  });
  const dispose = managedProcessPlugin(registry).setup(kernel);
  t.after(async () => {
    try {
      await dispose();
      await registry.close();
    } finally {
      if (previousHome === undefined) delete process.env.LIGULE_HOME;
      else process.env.LIGULE_HOME = previousHome;
      await rm(directory, { recursive: true, force: true });
    }
  });

  let started;
  try {
    started = await kernel.call('managed_process', {
      action: 'start', command: `node "${script.replaceAll('\\', '/')}" ${port}`, readyUrl: url,
    });
  } catch (error) {
    if (process.platform === 'linux' && error?.code === 'permission_sandbox_unavailable'
      && String(error.detail ?? '').includes('bwrap: setting up uid map: Permission denied')) {
      t.skip('this Linux runner denies bubblewrap user-namespace mapping');
      return;
    }
    throw error;
  }
  assert.equal(started.status, 'running');
  assert.equal(await (await fetch(url)).text(), 'trusted-server-ready');

  await setTrusted(workspace, false);
  await waitForUnavailable(url);
  const deadline = Date.now() + 3_000;
  let stopped = registry.status(started.id);
  while (stopped.status === 'stopping' && Date.now() < deadline) {
    await delay(20);
    stopped = registry.status(started.id);
  }
  assert.equal(stopped.status, 'stopped', JSON.stringify(stopped));
  assert.match(stopped.failure, /workspace trust was revoked/u);
});
