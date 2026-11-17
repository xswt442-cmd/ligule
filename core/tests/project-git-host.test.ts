import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createPermissionContext } from '../dist/kernel/permission.js';
import { withTuiHost } from './helpers/tui-host.ts';

const readable = createPermissionContext('workspace-write', 'policy', {
  filesystemRead: 'full', filesystemWrite: 'full', network: 'full', process: 'full',
});

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', windowsHide: true });
}

async function initializeRepository(directory: string): Promise<void> {
  git(directory, 'init', '--quiet');
  git(directory, 'config', 'user.name', 'Ligule test');
  git(directory, 'config', 'user.email', 'ligule-test@example.invalid');
  await Promise.all([
    writeFile(join(directory, 'tracked.txt'), 'original\n'),
    writeFile(join(directory, 'rename-source.txt'), 'rename me\n'),
    writeFile(join(directory, 'binary.bin'), Buffer.from([0x41, 0x00, 0x42])),
    writeFile(join(directory, '.gitattributes'), '*.bin diff=probe\n'),
  ]);
  git(directory, 'add', '--', '.');
  git(directory, '-c', 'user.name=Ligule test', '-c', 'user.email=ligule-test@example.invalid',
    'commit', '--quiet', '-m', 'baseline');
}

test('Git status on a non-repository returns an explicit read-only state', async () => {
  await withTuiHost(async ({ client, sessionId, providerRequests }) => {
    const before = await client.request('session.read', { sessionId }) as { events: unknown[] };
    const result = await client.request('project.git.status', { sessionId }) as {
      state: string; files: unknown[]; truncated: boolean;
    };
    assert.deepEqual(result, { state: 'not_repository', files: [], truncated: false });
    const after = await client.request('session.read', { sessionId }) as { events: unknown[] };
    assert.equal(after.events.length, before.events.length);
    assert.equal(providerRequests.length, 0);
  }, { permissionControl: true, permission: readable });
});
test('Git status reports staged, unstaged, renamed, binary, and untracked files without Session or model writes', async () => {
  await withTuiHost(async ({ client, sessionId, projectDirectory, providerRequests }) => {
    await initializeRepository(projectDirectory);
    await writeFile(join(projectDirectory, 'tracked.txt'), 'staged revision\n');
    git(projectDirectory, 'add', '--', 'tracked.txt');
    await writeFile(join(projectDirectory, 'tracked.txt'), 'working revision\n');
    git(projectDirectory, 'mv', '--', 'rename-source.txt', 'rename-target.txt');
    await writeFile(join(projectDirectory, 'binary.bin'), Buffer.from([0x43, 0x00, 0x44]));
    await writeFile(join(projectDirectory, 'untracked.txt'), 'new file\n');

    const before = await client.request('session.read', { sessionId }) as { events: unknown[] };
    const result = await client.request('project.git.status', { sessionId }) as {
      state: string; files: { path: string; sourcePath?: string; staged: boolean; unstaged: boolean; untracked: boolean; kind: string }[];
      truncated: boolean;
    };
    assert.equal(result.state, 'ready');
    assert.equal(result.truncated, false);
    assert.deepEqual(result.files.find(file => file.path === 'tracked.txt'), {
      path: 'tracked.txt', kind: 'modified', staged: true, unstaged: true, untracked: false,
    });
    assert.deepEqual(result.files.find(file => file.path === 'rename-target.txt'), {
      path: 'rename-target.txt', sourcePath: 'rename-source.txt', kind: 'renamed', staged: true, unstaged: false, untracked: false,
    });
    assert.deepEqual(result.files.find(file => file.path === 'untracked.txt'), {
      path: 'untracked.txt', kind: 'untracked', staged: false, unstaged: false, untracked: true,
    });
    assert.equal(result.files.find(file => file.path === 'binary.bin')?.unstaged, true);
    const after = await client.request('session.read', { sessionId }) as { events: unknown[] };
    assert.equal(after.events.length, before.events.length);
    assert.equal(providerRequests.length, 0);
  }, { permissionControl: true, permission: readable });
});

test('Git diff separates staged and working changes and identifies untracked and binary files', async () => {
  await withTuiHost(async ({ client, sessionId, projectDirectory, providerRequests }) => {
    await initializeRepository(projectDirectory);
    await writeFile(join(projectDirectory, 'tracked.txt'), 'staged revision\n');
    git(projectDirectory, 'add', '--', 'tracked.txt');
    await writeFile(join(projectDirectory, 'tracked.txt'), 'working revision\n');
    await writeFile(join(projectDirectory, 'binary.bin'), Buffer.from([0x43, 0x00, 0x44]));
    await writeFile(join(projectDirectory, 'untracked.txt'), 'new file\n');

    const result = await client.request('project.git.diff', { sessionId, path: 'tracked.txt' }) as {
      state: string; path: string; staged: string | null; unstaged: string | null;
    };
    assert.equal(result.state, 'ready');
    assert.equal(result.path, 'tracked.txt');
    assert.match(result.staged ?? '', /\+staged revision/u);
    assert.match(result.unstaged ?? '', /\+working revision/u);
    assert.match(result.unstaged ?? '', /-staged revision/u);

    assert.deepEqual(await client.request('project.git.diff', { sessionId, path: 'untracked.txt' }), {
      state: 'untracked', path: 'untracked.txt', staged: null, unstaged: null,
    });
    assert.deepEqual(await client.request('project.git.diff', { sessionId, path: 'binary.bin' }), {
      state: 'binary', path: 'binary.bin', staged: null, unstaged: null,
    });
    await assert.rejects(client.request('project.git.diff', { sessionId, path: '../outside.txt' }), { code: 'project_file_path_invalid' });
    assert.equal(providerRequests.length, 0);
  }, { permissionControl: true, permission: readable });
});

test('Git status disables a repository fsmonitor helper and fails closed on configured content filters', async () => {
  await withTuiHost(async ({ client, sessionId, projectDirectory }) => {
    await initializeRepository(projectDirectory);
    const helper = join(projectDirectory, 'helper.cjs');
    const marker = join(projectDirectory, 'helper-ran');
    await writeFile(helper, `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'called\\n');\n`);
    const helperCommand = `"${process.execPath.replaceAll('\\', '/')}" "${helper.replaceAll('\\', '/')}"`;
    git(projectDirectory, 'config', 'core.fsmonitor', helperCommand);
    git(projectDirectory, 'config', 'diff.external', helperCommand);
    git(projectDirectory, 'config', 'diff.probe.textconv', helperCommand);
    const baseline = spawnSync('git', ['status', '--porcelain=v1', '-z'], { cwd: projectDirectory, windowsHide: true, stdio: 'ignore' });
    assert.equal(baseline.status, 0);
    assert.equal((await readFile(marker, 'utf8')).length > 0, true, 'the fixture proves ordinary Git status starts its configured helper');
    await rm(marker, { force: true });

    const result = await client.request('project.git.status', { sessionId }) as { state: string };
    assert.equal(result.state, 'ready');
    assert.equal(existsSync(marker), false, 'Host status never starts repository-configured helpers');

    await writeFile(join(projectDirectory, 'binary.bin'), Buffer.from([0x43, 0x00, 0x44]));
    const ordinaryDiff = spawnSync('git', ['diff', '--', 'binary.bin'], { cwd: projectDirectory, windowsHide: true, stdio: 'ignore' });
    assert.equal(ordinaryDiff.status, 0);
    assert.equal(existsSync(marker), true, 'the fixture proves ordinary Git diff starts its configured helper');
    await rm(marker, { force: true });
    const safeDiff = await client.request('project.git.diff', { sessionId, path: 'binary.bin' }) as { state: string };
    assert.equal(safeDiff.state, 'binary');
    assert.equal(existsSync(marker), false, 'Host diff disables external diff and text conversion helpers');

    await writeFile(join(projectDirectory, '.gitattributes'), '*.txt filter=probe\n*.bin diff=probe\n');
    git(projectDirectory, 'add', '--', '.gitattributes');
    git(projectDirectory, '-c', 'user.name=Ligule test', '-c', 'user.email=ligule-test@example.invalid',
      'commit', '--quiet', '-m', 'add filter attribute');
    git(projectDirectory, 'config', 'filter.probe.clean', helperCommand);
    await writeFile(join(projectDirectory, 'tracked.txt'), 'modified with filter\n');
    await rm(marker, { force: true });
    const filtered = await client.request('project.git.status', { sessionId }) as { state: string; files: unknown[] };
    assert.deepEqual(filtered, { state: 'unsupported_filter', files: [], truncated: false });
    assert.equal(existsSync(marker), false, 'Host refuses unsupported filters before asking Git to inspect the worktree');
  }, { permissionControl: true, permission: readable });
});

test('Git status and diff report their output limits without returning partial results', async () => {
  await withTuiHost(async ({ client, sessionId, projectDirectory }) => {
    await initializeRepository(projectDirectory);
    const largePath = join(projectDirectory, '000-large.txt');
    const original = Array.from({ length: 10_000 }, (_, index) => `line-${String(index).padStart(5, '0')}-before`).join('\n') + '\n';
    const changed = Array.from({ length: 10_000 }, (_, index) => `line-${String(index).padStart(5, '0')}-after`).join('\n') + '\n';
    await writeFile(largePath, original);
    git(projectDirectory, 'add', '--', '000-large.txt');
    git(projectDirectory, '-c', 'user.name=Ligule test', '-c', 'user.email=ligule-test@example.invalid',
      'commit', '--quiet', '-m', 'large text baseline');
    await writeFile(largePath, changed);
    await mkdir(projectDirectory, { recursive: true });
    await Promise.all(Array.from({ length: 501 }, (_, index) => writeFile(
      join(projectDirectory, `extra-${String(index).padStart(4, '0')}.txt`), 'untracked\n')));

    const status = await client.request('project.git.status', { sessionId }) as {
      state: string; files: { path: string }[]; truncated: boolean;
    };
    assert.equal(status.state, 'ready');
    assert.equal(status.files.length, 500);
    assert.equal(status.truncated, true);
    assert.equal(status.files[0]?.path, '000-large.txt');

    assert.deepEqual(await client.request('project.git.diff', { sessionId, path: '000-large.txt' }), {
      state: 'output_too_large', path: '000-large.txt', staged: null, unstaged: null,
    });
  }, { permissionControl: true, permission: readable });
});
