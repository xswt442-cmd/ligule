import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLinuxSandbox } from '../dist/capability/sandbox-linux.js';

const linux = process.platform === 'linux';
const testDirectory = fileURLToPath(new URL('../../testplace/tmp/', import.meta.url));
const temporaryDirectories = new Set();

after(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function fixture(t) {
  if (!linux) return undefined;
  mkdirSync(testDirectory, { recursive: true });
  const root = mkdtempSync(join(testDirectory, 'sandbox-linux-'));
  temporaryDirectories.add(root);
  const privateTempDir = mkdtempSync(join(tmpdir(), 'ligule-sandbox-private-'));
  chmodSync(privateTempDir, 0o700);
  temporaryDirectories.add(privateTempDir);
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    temporaryDirectories.delete(root);
    rmSync(privateTempDir, { recursive: true, force: true });
    temporaryDirectories.delete(privateTempDir);
  });
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  return { root, workspace, privateTempDir };
}

function request(paths, overrides = {}) {
  return {
    profile: 'workspace-write',
    network: 'disabled',
    workspaceRoot: paths.workspace,
    cwd: paths.workspace,
    privateTempDir: paths.privateTempDir,
    executable: '/bin/sh',
    argv: ['-c', 'echo sandbox-ready'],
    environment: { TERM: 'dumb' },
    ...overrides,
  };
}

function run(result) {
  assert.equal(result.available, true, result.available ? '' : result.reason);
  const child = spawnSync(result.executable, result.argv, {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 64 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(child.error, undefined, child.error?.message);
  return child;
}

test('the actual WSL bubblewrap command limits writable paths and clears inherited credentials', { skip: !linux }, async (t) => {
  const paths = fixture(t);
  const result = await buildLinuxSandbox(request(paths, {
    argv: ['-c', 'touch /run/ligule/workspace/workspace-file; touch /run/ligule/tmp/temp-file; test -z "$(ls -A /home)"; test -z "$(ls -A /root)"; test -z "$(ls -A /mnt)"; test -z "$(ls -A /dev/shm)"; test ! -e /mnt/c/Windows; if touch /run/other 2>/dev/null; then exit 45; fi; if touch /etc/ligule-probe 2>/dev/null; then exit 46; fi; if env | cut -d= -f1 | grep -Eq "(_KEY|_TOKEN|_SECRET|CREDENTIAL)"; then exit 47; fi; echo isolated'],
  }));
  if (!result.available) return t.skip(result.reason);

  assert.equal(result.capabilities.filesystemRead, 'partial');
  assert.equal(result.capabilities.filesystemWrite, 'partial');
  assert.equal(result.capabilities.network, 'full');
  assert.equal(result.capabilities.process, 'full');
  assert.match(result.cwd, /^\/run\/ligule\/workspace(?:\/|$)/);
  const child = run(result);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /isolated/);
  assert.equal(lstatSync(join(paths.workspace, 'workspace-file')).isFile(), true);
  assert.equal(lstatSync(join(paths.privateTempDir, 'temp-file')).isFile(), true);
});

test('read-only profile blocks workspace writes but keeps its private temporary directory writable', { skip: !linux }, async (t) => {
  const paths = fixture(t);
  const result = await buildLinuxSandbox(request(paths, {
    profile: 'read-only',
    argv: ['-c', 'if touch /run/ligule/workspace/denied 2>/dev/null; then exit 31; fi; touch /run/ligule/tmp/allowed; echo read-only'],
  }));
  if (!result.available) return t.skip(result.reason);
  assert.equal(result.capabilities.filesystemWrite, 'full');
  const child = run(result);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(lstatSync(join(paths.workspace, 'denied'), { throwIfNoEntry: false }), undefined);
  assert.equal(lstatSync(join(paths.privateTempDir, 'allowed')).isFile(), true);
});

test('workspace links cannot use hidden host paths and existing hard links fail closed', { skip: !linux }, async (t) => {
  const paths = fixture(t);
  const outside = join(paths.root, 'outside-secret');
  writeFileSync(outside, 'must stay outside the sandbox workspace');
  symlinkSync(outside, join(paths.workspace, 'outside-link'));
  const symbolic = await buildLinuxSandbox(request(paths, {
    argv: ['-c', 'if cat /run/ligule/workspace/outside-link >/dev/null 2>&1; then exit 32; fi; echo link-contained'],
  }));
  if (!symbolic.available) return t.skip(symbolic.reason);
  const child = run(symbolic);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /link-contained/);

  const hardlink = join(paths.workspace, 'outside-hardlink');
  try {
    linkSync(outside, hardlink);
  } catch (error) {
    return t.skip(`this filesystem cannot create the hard-link fixture: ${error.code ?? error.message}`);
  }
  assert.equal(lstatSync(outside).nlink, 2, 'the fixture must be a real hard link before checking the sandbox');
  const refused = await buildLinuxSandbox(request(paths));
  assert.equal(refused.available, false);
  assert.equal(refused.code, 'sandbox_unavailable');
  assert.match(refused.reason, /multiply-linked file/);
});

test('the PID namespace hides host processes while allowing child processes', { skip: !linux }, async (t) => {
  const paths = fixture(t);
  const hostProcess = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
  t.after(() => hostProcess.kill('SIGKILL'));
  await once(hostProcess, 'spawn');
  const result = await buildLinuxSandbox(request(paths, {
    argv: ['-c', `test ! -e /proc/${hostProcess.pid}; sleep 0.05 & wait; echo process-isolated`],
  }));
  if (!result.available) return t.skip(result.reason);
  const child = run(result);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /process-isolated/);
});

test('network stays isolated by default and is shared only when explicitly requested', { skip: !linux }, async (t) => {
  const paths = fixture(t);
  const server = createServer((socket) => socket.end('connected'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const address = server.address();
  assert.notEqual(address, null);
  const script = 'import socket,sys\ns=socket.socket()\ns.settimeout(0.7)\ntry:\n s.connect(("127.0.0.1",int(sys.argv[1])))\n print("connected")\nexcept OSError:\n print("blocked")\n';

  const closed = await buildLinuxSandbox(request(paths, { executable: '/usr/bin/python3', argv: ['-c', script, String(address.port)] }));
  if (!closed.available) return t.skip(closed.reason);
  const closedRun = run(closed);
  assert.equal(closedRun.status, 0, closedRun.stderr);
  assert.match(closedRun.stdout, /blocked/);

  const shared = await buildLinuxSandbox(request(paths, {
    network: 'unrestricted',
    executable: '/usr/bin/python3',
    argv: ['-c', script, String(address.port)],
  }));
  if (!shared.available) return t.skip(shared.reason);
  const sharedRun = run(shared);
  assert.equal(sharedRun.status, 0, sharedRun.stderr);
  assert.match(sharedRun.stdout, /connected/);
});

test('invalid workspace boundaries and unapproved environment variables are rejected', { skip: !linux }, async (t) => {
  const paths = fixture(t);
  await assert.rejects(
    () => buildLinuxSandbox(request(paths, { cwd: resolve(paths.workspace, '..') })),
    (error) => error.code === 'sandbox_request_invalid',
  );
  await assert.rejects(
    () => buildLinuxSandbox(request(paths, { environment: { ANTHROPIC_API_KEY: 'must-not-enter' } })),
    (error) => error.code === 'sandbox_request_invalid',
  );
  await assert.rejects(
    () => buildLinuxSandbox(request(paths, { privateTempDir: paths.workspace })),
    (error) => error.code === 'sandbox_request_invalid',
  );
});
