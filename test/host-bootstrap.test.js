import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from '../dist/host/connection.js';

const repository = fileURLToPath(new URL('../', import.meta.url));
const cli = join(repository, 'dist', 'cli.js');

function deadline(pending, label) {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not finish`)), 10_000);
  });
  return Promise.race([pending, expired]).finally(() => clearTimeout(timer));
}

test('a real unconfigured host opens another workspace while settings remain available', async () => {
  const scratch = join(repository, 'testplace', 'tmp');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'host-bootstrap-'));
  const first = join(root, 'first');
  const second = join(root, 'second');
  const data = join(root, 'data');
  await Promise.all([first, second, data].map((path) => mkdir(path, { recursive: true })));
  await writeFile(join(data, 'config.toml'), '[policy]\nmode = "ask"\n', 'utf8');
  const child = spawn(process.execPath, [cli, 'host'], {
    cwd: first,
    env: { ...process.env, LIGULE_HOME: data, LIGULE_BOOTSTRAP_KEY: 'bootstrap-environment-key' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code));
  });
  const client = createConnection({ input: child.stdout, output: child.stdin });
  child.stderr.resume();
  try {
    assert.deepEqual(await deadline(client.request('prefs.read', {}), 'read preferences'), { settings: {}, version: '' });
    const opened = await deadline(client.request('session.create', { projectRoot: second }), 'open unconfigured workspace');
    const status = await deadline(client.request('status.get', { sessionId: opened.sessionId }), 'read session status');
    assert.equal(status.running, false);
    assert.equal(status.model, null);
    const shown = await deadline(client.request('config.get', { projectRoot: second }), 'read model settings');
    assert.deepEqual(shown.model, {});
    assert.deepEqual(await client.request('credentials.status', { reference: 'LIGULE_BOOTSTRAP_KEY' }), { reference: 'LIGULE_BOOTSTRAP_KEY', source: 'environment', configured: true });
    await assert.rejects(client.request('credentials.set', { reference: 'LIGULE_BOOTSTRAP_KEY', value: 'replacement' }), (error) => error.code === 'credential_environment_override');
    await assert.rejects(client.request('credentials.delete', { reference: 'LIGULE_BOOTSTRAP_KEY' }), (error) => error.code === 'credential_environment_override');
    const record = await client.request('session.read', { sessionId: opened.sessionId });
    assert.equal(JSON.stringify({ shown, record }).includes('bootstrap-environment-key'), false);
    await assert.rejects(client.request('run.start', { sessionId: opened.sessionId, input: 'an actual unconfigured run' }), error => error.code === 'host_model_config_missing');
    const failed = await client.request('session.read', { sessionId: opened.sessionId });
    const turns = failed.events.filter(event => event.kind === 'turn');
    assert.equal(turns.length, 1);
    assert.equal(turns[0].status, 'failed');
    assert.equal(turns[0].code, 'host_model_config_missing');
    assert.equal(turns[0].userSeq, failed.events.find(event => event.kind === 'user').seq);
    let catalog = await client.request('config.get', { projectRoot: second });
    const services = [
      { id: 'alpha', name: 'Alpha', api: 'messages', baseURL: 'http://127.0.0.1:1', apiKeyEnv: 'LIGULE_BOOTSTRAP_KEY', models: ['alpha-1'] },
      { id: 'beta', name: 'Beta', api: 'chat-completions', baseURL: 'http://127.0.0.1:1', apiKeyEnv: 'LIGULE_BOOTSTRAP_KEY', models: ['beta-1', 'beta-2'] },
    ];
    await client.request('config.set', { projectRoot: second, field: 'model.services', layer: 'user', version: catalog.layers.find(layer => layer.layer === 'user').version, value: services });
    assert.equal((await client.request('status.get', { sessionId: opened.sessionId })).model, 'alpha-1');
    assert.equal((await client.request('model.select', { sessionId: opened.sessionId, provider: 'beta', model: 'beta-2' })).when, 'now');
    const peer = await client.request('session.create', { projectRoot: second });
    assert.equal((await client.request('status.get', { sessionId: peer.sessionId })).model, 'alpha-1');
    catalog = await client.request('config.get', { projectRoot: second });
    await client.request('config.set', { projectRoot: second, field: 'model.selection', layer: 'user', version: catalog.layers.find(layer => layer.layer === 'user').version, value: { provider: 'alpha', model: 'alpha-1' } });
    assert.equal((await client.request('status.get', { sessionId: opened.sessionId })).model, 'beta-2', '保存默认选择不切换已单独选择的会话');
    await client.request('session.close', { sessionId: opened.sessionId });
    await client.request('session.open', { sessionId: opened.sessionId, projectRoot: second });
    const restored = await client.request('status.get', { sessionId: opened.sessionId });
    assert.equal(restored.model, 'beta-2');
    assert.equal(restored.serviceId, 'beta');
    await assert.rejects(client.request('model.select', { sessionId: opened.sessionId, provider: 'alpha', model: 'unknown' }), error => error.code === 'model_not_available');
    let signalStarted;
    const began = new Promise(resolve => { signalStarted = resolve; });
    client.onNotification(message => {
      if (message.sessionId === opened.sessionId && message.event?.kind === 'user') signalStarted();
    });
    const running = client.request('run.start', { sessionId: opened.sessionId, input: 'cancel a real connection attempt' }).then(result => ({ result }), error => ({ error }));
    await deadline(began, 'observe the round input');
    const selection = await client.request('model.select', { sessionId: opened.sessionId, provider: 'alpha', model: 'alpha-1' });
    assert.equal(selection.when, 'round');
    const during = await client.request('status.get', { sessionId: opened.sessionId });
    assert.equal(during.model, 'beta-2');
    assert.equal(during.pendingModel, 'alpha-1');
    await client.request('run.cancel', { sessionId: opened.sessionId });
    const outcome = await deadline(running, 'cancel the actual model transport');
    assert.equal(outcome.error?.code, 'provider_cancelled');
    const cancelled = await client.request('session.read', { sessionId: opened.sessionId });
    assert.equal(cancelled.events.filter(event => event.kind === 'turn').at(-1).status, 'cancelled');
    assert.equal(cancelled.events.filter(event => event.kind === 'turnContext').at(-1).model, 'beta-2');
    assert.equal((await client.request('status.get', { sessionId: opened.sessionId })).model, 'alpha-1');
    await client.request('session.close', { sessionId: peer.sessionId });
    const saved = await deadline(client.request('prefs.write', { json: '{"palette":"forest"}', version: '' }), 'save preferences');
    assert.deepEqual(saved.settings, { palette: 'forest' });
    assert.notEqual(saved.version, '');
    assert.deepEqual(JSON.parse(await readFile(join(data, 'desktop.json'), 'utf8')), saved.settings);
    await deadline(client.request('session.close', { sessionId: opened.sessionId }), 'close session');
    child.stdin.end();
    assert.equal(await deadline(exited, 'stop host'), 0);
  } finally {
    if (child.exitCode === null) child.kill();
    await deadline(exited, 'clean host');
    await rm(root, { recursive: true, force: true });
  }
});
