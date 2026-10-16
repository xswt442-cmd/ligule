import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { spawnWindowsCommand } from '../dist/capability/windows-command.js';
import { resolveShell, withNativeExitCode } from '../dist/capability/shell.js';

const descendant = fileURLToPath(new URL('./fixtures/exec-descendant.mjs', import.meta.url));
const hostFixture = fileURLToPath(new URL('./fixtures/owned-command-host.mjs', import.meta.url));
const options = { skip: process.platform === 'win32' ? false : 'Windows Job Object verification' };

async function withDirectory(run) {
  const testplace = resolve('testplace');
  await mkdir(testplace, { recursive: true });
  const directory = await mkdtemp(join(testplace, 'owned-command-'));
  try {
    await run(directory);
  } finally {
    const checked = resolve(directory);
    assert.ok(checked.startsWith(`${testplace}\\`));
    await rm(checked, { recursive: true, force: true });
  }
}

async function waitForDescendant(marker) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(marker, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await delay(10);
  }
  throw new Error('exec_descendant_start_timeout');
}

async function assertStopped(processId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(processId, 0);
    } catch (error) {
      if (error.code === 'ESRCH') return;
      throw error;
    }
    await delay(10);
  }
  assert.fail(`owned process ${processId} is still running`);
}

function startTree(directory, marker) {
  const command = `node "${descendant.replace(/\\/g, '/')}" tree "${marker.replace(/\\/g, '/')}"`;
  const shell = withNativeExitCode(resolveShell({}), command);
  const owned = spawnWindowsCommand(shell.executable, [...shell.prefix, `${command}${shell.tail}`], directory);
  owned.child.stdout.resume();
  owned.child.stderr.resume();
  return owned;
}

test('cancellation during startup and execution terminates the entire owned command tree', options, async () => {
  await withDirectory(async (directory) => {
    const shell = resolveShell({});
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const owned = spawnWindowsCommand(shell.executable, [...shell.prefix, 'Start-Sleep -Seconds 20'], directory);
      owned.child.stdout.resume();
      owned.child.stderr.resume();
      const outcome = assert.rejects(owned.completion, (error) => error.code === 'exec_cancelled');
      if (attempt % 2 === 1) await delay(150);
      const cancelledAt = Date.now();
      owned.cancel();
      await outcome;
      assert.ok(Date.now() - cancelledAt < 5_000);
    }
    const marker = join(directory, 'running.json');
    const owned = startTree(directory, marker);
    const outcome = assert.rejects(owned.completion, (error) => error.code === 'exec_cancelled');
    try {
      const leaf = await waitForDescendant(marker);
      owned.cancel();
      await outcome;
      await assertStopped(leaf.processId);
      await assertStopped(leaf.parentId);
    } finally {
      owned.cancel();
      await outcome;
    }
  });
});

test('hard-killing the host or guardian also terminates running descendants', options, async () => {
  await withDirectory(async (directory) => {
    const marker = join(directory, 'host-leaf.json');
    const host = spawn(process.execPath, [hostFixture, descendant, marker, directory], { windowsHide: true, stdio: 'ignore' });
    const closed = once(host, 'close');
    try {
      const leaf = await waitForDescendant(marker);
      host.kill('SIGKILL');
      await closed;
      await assertStopped(leaf.processId);
      await assertStopped(leaf.parentId);
    } finally {
      if (host.exitCode === null && host.signalCode === null) host.kill('SIGKILL');
      await closed;
    }
    const owned = startTree(directory, join(directory, 'guardian-leaf.json'));
    const outcome = assert.rejects(owned.completion, (error) => error.code === 'exec_guardian_failed');
    try {
      const leaf = await waitForDescendant(join(directory, 'guardian-leaf.json'));
      owned.child.kill('SIGKILL');
      await outcome;
      await assertStopped(leaf.processId);
      await assertStopped(leaf.parentId);
    } finally {
      if (owned.child.exitCode === null && owned.child.signalCode === null) owned.child.kill('SIGKILL');
      await outcome;
    }
  });
});

test('a missing target executable reports a spawn failure through the guardian protocol', options, async () => {
  await withDirectory(async (directory) => {
    const owned = spawnWindowsCommand(join(directory, 'missing.exe'), [], directory);
    owned.child.stdout.resume();
    owned.child.stderr.resume();
    await assert.rejects(owned.completion, (error) => error.code === 'exec_spawn_failed');
  });
});
