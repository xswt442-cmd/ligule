import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createConnection } from '../core/dist/host/connection.js';
import { listenFetchable } from '../test/helpers/port.js';

const repository = fileURLToPath(new URL('../', import.meta.url));

async function within(work, label) {
  let timer;
  try {
    return await Promise.race([work, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), 10000);
    })]);
  } finally { clearTimeout(timer); }
}

function startHost(project, home) {
  const child = spawn(process.execPath, [join(repository, 'tui', 'dist', 'cli.js'), 'host'], {
    cwd: project, env: { ...process.env, LIGULE_HOME: home, OUTPUT_BUDGET_TEST_KEY: 'synthetic-budget-host-key' },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  child.stderr.resume();
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  return {
    child, client: createConnection({ input: child.stdout, output: child.stdin }),
    async stop() {
      child.stdin.end();
      try { assert.equal(await within(exited, 'Host EOF'), 0); }
      finally { if (child.exitCode === null) child.kill(); }
    },
  };
}

test('Host applies budgets at turn boundaries, retains explicit model selection, and reloads them after restart', async () => {
  const scratch = join(repository, 'testplace', 'tmp');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'budget-host-'));
  const project = join(root, 'project');
  const home = join(root, 'home');
  await Promise.all([mkdir(project), mkdir(home)]);
  const requests = [];
  let gate;
  let release;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    if (gate !== undefined) await gate;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: {"choices":[{"delta":{"content":"budget verified"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  const port = await listenFetchable(server);
  await writeFile(join(home, 'config.toml'), [
    '[model]',
    `services = [{ id = "local", name = "Local", api = "chat-completions", baseURL = "http://127.0.0.1:${port}/v1", apiKeyEnv = "OUTPUT_BUDGET_TEST_KEY", models = ["local-a", "local-b"] }]`,
    'selection = { provider = "local", model = "local-a" }',
    'outputTokens = 2048',
    '[policy]',
    'mode = "ask"',
  ].join('\n'));
  let host;
  try {
    host = startHost(project, home);
    const call = (method, params) => within(host.client.request(method, params), method);
    const { sessionId } = await call('session.create', { projectRoot: project });
    await call('model.select', { sessionId, provider: 'local', model: 'local-a' });
    gate = new Promise((resolve) => { release = resolve; });
    const running = call('run.start', { sessionId, input: 'check the current output budget' });
    await within((async () => { while (requests.length < 1) await delay(10); })(), 'actual HTTP request');
    assert.equal(requests[0].max_tokens, 2048);
    const shown = await call('config.get', { projectRoot: project });
    const saved = await call('config.set', { field: 'model.outputTokens', value: 1024, layer: 'user', version: shown.layers[0].version, projectRoot: project });
    assert.deepEqual(saved.applies, [{ sessionId, when: 'round' }]);
    assert.equal((await call('status.get', { sessionId })).outputTokens, 2048);
    release();
    gate = undefined;
    await running;
    assert.equal((await call('status.get', { sessionId })).outputTokens, 1024);
    await call('run.start', { sessionId, input: 'check the updated budget' });
    assert.equal(requests.at(-1).max_tokens, 1024);
    const created = await call('session.create', { projectRoot: project });
    assert.equal((await call('status.get', { sessionId: created.sessionId })).outputTokens, 1024);
    await host.stop();
    host = startHost(project, home);
    await call('session.open', { projectRoot: project, sessionId });
    const restored = await call('status.get', { sessionId });
    assert.equal(restored.outputTokens, 1024);
    assert.equal(restored.serviceId, 'local');
    await call('run.start', { sessionId, input: 'check again after restart' });
    assert.equal(requests.at(-1).max_tokens, 1024);
    const settings = await call('config.get', { projectRoot: project });
    const before = await readFile(join(home, 'config.toml'));
    await assert.rejects(call('config.set', { field: 'model.outputTokens', value: 16384, layer: 'user', version: settings.layers[0].version, projectRoot: project }), { code: 'provider_output_budget_unsupported' });
    assert.deepEqual(await readFile(join(home, 'config.toml')), before);
    assert.equal((await call('status.get', { sessionId })).outputTokens, 1024);
    await host.stop();
    host = startHost(project, home);
    await call('session.open', { projectRoot: project, sessionId });
    await call('run.start', { sessionId, input: 'the refused write must not prevent restart' });
    assert.equal(requests.at(-1).max_tokens, 1024);
    await host.stop();
    host = undefined;
  } finally {
    release?.();
    if (host !== undefined) await host.stop();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('Host validates project-local budgets before saving and preserves a shadowed user write', async () => {
  const scratch = join(repository, 'testplace', 'tmp');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'budget-local-'));
  const project = join(root, 'project');
  const home = join(root, 'home');
  await Promise.all([mkdir(join(project, '.ligule'), { recursive: true }), mkdir(home)]);
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: {"choices":[{"delta":{"content":"restart verified"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  const port = await listenFetchable(server);
  const userFile = join(home, 'config.toml');
  const localFile = join(project, '.ligule', 'config.local.toml');
  await writeFile(userFile, `[model]\napi = "chat-completions"\nbaseURL = "http://127.0.0.1:${port}/v1"\nmodel = "local"\napiKeyEnv = "OUTPUT_BUDGET_TEST_KEY"\noutputTokens = 2048\n[policy]\nmode = "ask"\n`);
  await writeFile(localFile, '# local bytes must survive a refusal\n[model]\noutputTokens = 1024\n');
  await writeFile(join(project, '.ligule', 'config.toml'), '[limits]\ncontextTokens = 1500\n');
  let host;
  try {
    host = startHost(project, home);
    const call = (method, params) => within(host.client.request(method, params), method);
    const { sessionId } = await call('session.create', { projectRoot: project });
    const settings = await call('config.get', { projectRoot: project });
    const before = await readFile(localFile);
    await assert.rejects(call('config.set', { projectRoot: project, layer: 'projectLocal', field: 'model.outputTokens', value: 16384, version: settings.layers[1].version }), { code: 'provider_output_budget_unsupported' });
    assert.deepEqual(await readFile(localFile), before);
    await assert.rejects(call('config.set', { projectRoot: project, layer: 'projectLocal', field: 'model.outputTokens', value: 2048, version: settings.layers[1].version }), { code: 'provider_output_budget_unsupported' });
    assert.deepEqual(await readFile(localFile), before, 'validation includes the non-editable project context limit');
    const saved = await call('config.set', { projectRoot: project, layer: 'user', field: 'model.outputTokens', value: 4096, version: settings.layers[0].version });
    assert.equal(saved.shadowed, true);
    assert.equal(saved.shadowedBy, 'local');
    assert.deepEqual(saved.applies, []);
    await host.stop();
    host = startHost(project, home);
    await call('session.open', { projectRoot: project, sessionId });
    await call('run.start', { sessionId, input: 'check project-local config after restart' });
    assert.equal(requests.at(-1).max_tokens, 1024);
    await host.stop();
    host = undefined;
  } finally {
    if (host !== undefined) await host.stop();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('a user budget write validates every loaded project before changing shared config', async () => {
  const scratch = join(repository, 'testplace', 'tmp');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'budget-shared-'));
  const project = join(root, 'default-project');
  const other = join(root, 'other-project');
  const home = join(root, 'home');
  await Promise.all([mkdir(project), mkdir(join(other, '.ligule'), { recursive: true }), mkdir(home)]);
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: {"choices":[{"delta":{"content":"shared config survived"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  const port = await listenFetchable(server);
  const userFile = join(home, 'config.toml');
  await writeFile(userFile, '[model]\napi = "chat-completions"\nbaseURL = "https://api.deepseek.com/v1"\nmodel = "deepseek-flash"\napiKeyEnv = "OUTPUT_BUDGET_TEST_KEY"\noutputTokens = 1024\n[policy]\nmode = "ask"\n');
  await writeFile(join(other, '.ligule', 'config.local.toml'), `[model]\nbaseURL = "http://127.0.0.1:${port}/v1"\nmodel = "local"\n`);
  let host;
  try {
    host = startHost(project, home);
    const call = (method, params) => within(host.client.request(method, params), method);
    const { sessionId } = await call('session.create', { projectRoot: other });
    const settings = await call('config.get', { projectRoot: project });
    const before = await readFile(userFile);
    await assert.rejects(call('config.set', { projectRoot: project, layer: 'user', field: 'model.outputTokens', value: 16384, version: settings.layers[0].version }), { code: 'provider_output_budget_unsupported' });
    assert.deepEqual(await readFile(userFile), before, 'the default model supports 16384 but another loaded project does not');
    await host.stop();
    host = startHost(other, home);
    await call('session.open', { projectRoot: other, sessionId });
    await call('run.start', { sessionId, input: 'read the unchanged shared config in a new Host' });
    assert.equal(requests.at(-1).max_tokens, 1024);
    await host.stop();
    host = undefined;
  } finally {
    if (host !== undefined) await host.stop();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('a project model override cannot hide an invalid shared default from a future Host', async () => {
  const scratch = join(repository, 'testplace', 'tmp');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'budget-future-'));
  const project = join(root, 'overridden-project');
  const future = join(root, 'future-project');
  const home = join(root, 'home');
  await Promise.all([mkdir(join(project, '.ligule'), { recursive: true }), mkdir(future), mkdir(home)]);
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: {"choices":[{"delta":{"content":"future project works"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  const port = await listenFetchable(server);
  const userFile = join(home, 'config.toml');
  await writeFile(userFile, `[model]\napi = "chat-completions"\nbaseURL = "http://127.0.0.1:${port}/v1"\nmodel = "local"\napiKeyEnv = "OUTPUT_BUDGET_TEST_KEY"\noutputTokens = 1024\n[policy]\nmode = "ask"\n`);
  await writeFile(join(project, '.ligule', 'config.local.toml'), '[model]\nbaseURL = "https://api.deepseek.com/v1"\nmodel = "deepseek-flash"\n');
  let host;
  try {
    host = startHost(project, home);
    const call = (method, params) => within(host.client.request(method, params), method);
    await call('session.create', { projectRoot: project });
    const settings = await call('config.get', { projectRoot: project });
    const before = await readFile(userFile);
    await assert.rejects(call('config.set', { projectRoot: project, layer: 'user', field: 'model.outputTokens', value: 16384, version: settings.layers[0].version }), { code: 'provider_output_budget_unsupported' });
    assert.deepEqual(await readFile(userFile), before);
    await host.stop();
    host = startHost(future, home);
    const { sessionId } = await call('session.create', { projectRoot: future });
    await call('run.start', { sessionId, input: 'load the shared defaults in a previously unloaded project' });
    assert.equal(requests.at(-1).max_tokens, 1024);
    await host.stop();
    host = undefined;
  } finally {
    if (host !== undefined) await host.stop();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
