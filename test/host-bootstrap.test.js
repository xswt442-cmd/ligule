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
