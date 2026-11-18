import assert from 'node:assert/strict';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createPermissionContext } from '../dist/kernel/permission.js';
import { versionOf } from '../dist/kernel/observe.js';
import { withTuiHost } from './helpers/tui-host.ts';

type FilePage = { path: string; size: number; version: string | null; encoding: string; text?: string };
type SaveResult = { saved: boolean; changed: boolean | null; version: string | null; outcome: string; recorded: boolean; errorCode?: string };
type SessionView = { events: { kind?: string; source?: string; runId?: string; callId?: string; tool?: string; fileChanges?: Record<string, unknown>[] }[] };

const writable = createPermissionContext('workspace-write', 'policy', {
  filesystemRead: 'full', filesystemWrite: 'full', network: 'full', process: 'full',
});

function codeIs(expected: string) {
  return (error: unknown) => (error as { code?: string }).code === expected;
}

test('trusted UI saves a version-matched file and records the desktop source without a tool or user event', async () => {
  const before = Buffer.from('\uFEFFconst answer = 1;\r\n', 'utf8');
  const after = '\uFEFFconst answer = 42;\r\n';
  await withTuiHost(async ({ client, sessionId, projectDirectory, sessionDirectory, providerRequests }) => {
    const path = join(projectDirectory, 'src', 'answer.ts');
    await mkdir(join(projectDirectory, 'src'), { recursive: true });
    await writeFile(path, before);
    const initial = await client.request('session.read', { sessionId }) as SessionView;
    const current = await client.request('project.file.read', { sessionId, path: 'src/answer.ts' }) as FilePage;
    assert.equal(current.version, versionOf(before));

    const saved = await client.request('project.file.save', {
      sessionId, path: 'src/answer.ts', expectedVersion: current.version, text: after,
    }) as SaveResult;
    assert.deepEqual(saved, {
      saved: true, changed: true, version: versionOf(Buffer.from(after, 'utf8')),
      outcome: 'written', recorded: true,
    });
    assert.deepEqual(await readFile(path), Buffer.from(after, 'utf8'));

    const history = await client.request('session.read', { sessionId }) as SessionView;
    assert.equal(history.events.length, initial.events.length + 1);
    const event = history.events.at(-1)!;
    assert.equal(event.kind, 'workspaceFileChange');
    assert.equal(event.source, 'desktop');
    assert.equal(event.runId, undefined);
    assert.equal(event.callId, undefined);
    assert.equal(event.tool, undefined);
    assert.equal(event.fileChanges?.length, 1);
    assert.deepEqual(event.fileChanges?.[0], {
      path: 'src/answer.ts',
      operation: 'write',
      outcome: 'written',
      beforeVersion: versionOf(before),
      expectedAfterVersion: versionOf(Buffer.from(after, 'utf8')),
      observedAfterVersion: versionOf(Buffer.from(after, 'utf8')),
      observedAt: event.fileChanges?.[0]?.observedAt,
      baselineStatus: 'available',
      baselineRef: event.fileChanges?.[0]?.baselineRef,
      baselineExists: true,
      baselineVersion: versionOf(before),
      observedStatus: 'available',
      observedExists: true,
      expectedMatchesObserved: true,
      changedFromBaseline: true,
    });
    const reference = event.fileChanges![0]!.baselineRef as { name: string; bytes: number };
    assert.equal(reference.bytes, before.length);
    assert.deepEqual(await readFile(join(sessionDirectory, reference.name)), before);
    assert.equal(history.events.some(record => record.kind === 'tool' || record.kind === 'user'), false,
      'a Desktop save does not appear as an Agent tool result or conversation message');
    assert.equal(providerRequests.length, 0);
  }, { permissionControl: true, permission: writable });
});

test('trusted UI saves through a linked workspace boundary with a relative change record', async () => {
  const config: Record<string, unknown> = {};
  await withTuiHost(async ({ client, directory, projectDirectory, sessionId, config: hostConfig }) => {
    const workspaceLink = join(directory, 'project-link');
    assert.equal(hostConfig.boundary === workspaceLink, true);
    const file = join(projectDirectory, 'note.txt');
    const before = Buffer.from('before\n');
    const after = 'after\n';
    await writeFile(file, before);
    const initial = await client.request('project.file.read', { sessionId, path: 'note.txt' }) as FilePage;
    const saved = await client.request('project.file.save', {
      sessionId, path: 'note.txt', expectedVersion: initial.version, text: after,
    }) as SaveResult;
    assert.deepEqual(saved, {
      saved: true, changed: true, version: versionOf(Buffer.from(after)), outcome: 'written', recorded: true,
    });
    assert.equal(await readFile(file, 'utf8'), after);
    const history = await client.request('session.read', { sessionId }) as SessionView;
    const change = history.events.at(-1)?.fileChanges?.[0];
    assert.equal(history.events.at(-1)?.kind, 'workspaceFileChange');
    assert.equal(change?.path, 'note.txt');
    assert.equal(change?.operation, 'write');
    assert.equal(change?.outcome, 'written');
  }, {
    setup: async ({ directory, projectDirectory }) => {
      const workspaceLink = join(directory, 'project-link');
      await symlink(projectDirectory, workspaceLink, process.platform === 'win32' ? 'junction' : 'dir');
      config.boundary = workspaceLink;
      config.workspaceRoot = workspaceLink;
    },
    config,
    permissionControl: true,
    permission: writable,
  });
});

test('external edits and read-only Permission prevent a Desktop save from overwriting the file', async () => {
  const before = Buffer.from('original\n');
  const external = Buffer.from('external change\n');
  await withTuiHost(async ({ client, sessionId, projectDirectory }) => {
    const path = join(projectDirectory, 'note.txt');
    await writeFile(path, before);
    const read = await client.request('project.file.read', { sessionId, path: 'note.txt' }) as FilePage;
    await writeFile(path, external);
    await assert.rejects(client.request('project.file.save', {
      sessionId, path: 'note.txt', expectedVersion: read.version, text: 'stale overwrite\n',
    }), codeIs('project_file_conflict'));
    assert.deepEqual(await readFile(path), external);
  }, { permissionControl: true, permission: writable });

  const readOnly = createPermissionContext('read-only', 'policy', {
    filesystemRead: 'full', filesystemWrite: 'full', network: 'full', process: 'full',
  });
  await withTuiHost(async ({ client, sessionId, projectDirectory }) => {
    const path = join(projectDirectory, 'note.txt');
    await writeFile(path, before);
    const read = await client.request('project.file.read', { sessionId, path: 'note.txt' }) as FilePage;
    await assert.rejects(client.request('project.file.save', {
      sessionId, path: 'note.txt', expectedVersion: read.version, text: 'forbidden overwrite\n',
    }), codeIs('permission_read_only'));
    assert.deepEqual(await readFile(path), before);
  }, { permissionControl: true, permission: readOnly });
});

test('a non-UI Host client cannot save a workspace file even with filesystem write Permission', async () => {
  const before = Buffer.from('trusted UI only\n');
  await withTuiHost(async ({ client, sessionId, projectDirectory }) => {
    const path = join(projectDirectory, 'note.txt');
    await writeFile(path, before);
    await assert.rejects(client.request('project.file.save', {
      sessionId, path: 'note.txt', expectedVersion: versionOf(before), text: 'unauthorized write\n',
    }), codeIs('project_files_control_unavailable'));
    assert.deepEqual(await readFile(path), before);
  }, { permission: writable });
});

test('parallel Desktop saves from separate Sessions share the Host file write queue', async () => {
  const before = Buffer.from('starting content\n');
  const content = ['first save\n', 'second save\n', 'third save\n'];
  await withTuiHost(async ({ client, sessionId, projectDirectory }) => {
    const path = join(projectDirectory, 'shared.txt');
    await writeFile(path, before);
    const sessions = [sessionId];
    for (let index = 0; index < content.length - 1; index += 1) {
      sessions.push((await client.request('session.create', { projectRoot: projectDirectory }) as { sessionId: string }).sessionId);
    }
    const versions = await Promise.all(sessions.map(async id => (await client.request('project.file.read', {
      sessionId: id, path: 'shared.txt',
    }) as FilePage).version));
    assert.ok(versions.every(version => version === versionOf(before)));

    const results = await Promise.allSettled(sessions.map((id, index) => client.request('project.file.save', {
      sessionId: id, path: 'shared.txt', expectedVersion: versions[index], text: content[index],
    }) as Promise<SaveResult>));
    const saved = results.filter((result): result is PromiseFulfilledResult<SaveResult> => result.status === 'fulfilled');
    const conflicts = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    assert.equal(saved.length, 1);
    assert.equal(conflicts.length, content.length - 1);
    assert.ok(conflicts.every(result => codeIs('project_file_conflict')(result.reason)));
    assert.ok(content.includes((await readFile(path, 'utf8'))));
  }, { permissionControl: true, permission: writable });
});
