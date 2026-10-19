import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPermissionContext } from '../dist/kernel/permission.js';
import { withTuiHost } from './helpers/tui-host.js';

const fullPermission = createPermissionContext('full-access', 'unrestricted', {
  filesystemRead: 'unavailable', filesystemWrite: 'unavailable', network: 'unavailable', process: 'unavailable',
});
const permissionWithOwnedProcesses = createPermissionContext('read-only', 'policy', {
  filesystemRead: 'unavailable', filesystemWrite: 'unavailable', network: 'unavailable', process: 'full',
});

test('a Host without trusted permission controls cannot change a session profile', async () => {
  await withTuiHost(async ({ client, sessionId }) => {
    await assert.rejects(
      client.request('permission.set', {
        sessionId, permissionProfile: 'full-access', confirmFullAccess: true,
      }),
      { code: 'permission_control_unavailable' },
    );
    assert.equal((await client.request('status.get', { sessionId })).permission.profile, 'read-only');
  });
});

test('a loaded in-process extension prevents an immediate permission downgrade', async () => {
  const extensionPath = fileURLToPath(new URL('./fixtures/noop-extension.mjs', import.meta.url));
  await withTuiHost(async ({ client, sessionId }) => {
    const status = await client.request('status.get', { sessionId });
    assert.equal(status.permission.profile, 'full-access');
    assert.equal(status.permission.network, 'unrestricted');
    assert.equal(status.permission.changeAllowed, false);
    assert.equal(status.permission.changeReason, 'permission_extension_restart_required');
    await assert.rejects(
      client.request('permission.set', { sessionId, permissionProfile: 'read-only' }),
      { code: 'permission_extension_restart_required' },
    );
    assert.equal((await client.request('status.get', { sessionId })).permission.profile, 'full-access');
  }, {
    permissionControl: true,
    permission: fullPermission,
    extensions: { paths: [extensionPath], ignored: [] },
  });
});

test('trusted permission changes require separate confirmations and survive reopening', async () => {
  await withTuiHost(async ({ client, sessionId }) => {
    const initial = await client.request('status.get', { sessionId });
    assert.equal(initial.permission.profile, 'read-only');
    assert.equal(initial.permission.network, 'policy');
    assert.equal(initial.permission.changeAllowed, true);

    await assert.rejects(
      client.request('permission.set', { sessionId, permissionProfile: 'full-access' }),
      { code: 'permission_full_access_confirmation_required' },
    );
    await assert.rejects(
      client.request('permission.set', {
        sessionId, permissionProfile: 'read-only', permissionNetwork: 'unrestricted',
      }),
      { code: 'permission_network_confirmation_required' },
    );

    const [changed, policy] = await Promise.all([
      client.request('permission.set', {
        sessionId, permissionProfile: 'full-access', confirmFullAccess: true,
      }),
      client.request('policy.set', { sessionId, mode: 'auto' }),
    ]);
    assert.equal(changed.permission.profile, 'full-access');
    assert.equal(policy.policy, 'auto');
    const profileStatus = await client.request('status.get', { sessionId });
    assert.equal(profileStatus.permission.profile, 'full-access');
    assert.equal(profileStatus.permission.network, 'policy');
    assert.equal(profileStatus.permission.execution.available, false);
    assert.equal(profileStatus.policy, 'auto');

    await assert.rejects(
      client.request('permission.set', {
        sessionId, permissionProfile: 'full-access', permissionNetwork: 'unrestricted',
      }),
      { code: 'permission_network_confirmation_required' },
    );
    const unrestricted = await client.request('permission.set', {
      sessionId,
      permissionProfile: 'full-access',
      permissionNetwork: 'unrestricted',
      confirmNetwork: true,
    });
    assert.equal(unrestricted.permission.network, 'unrestricted');
    assert.equal(unrestricted.permission.execution.available, true);

    await client.request('session.close', { sessionId });
    await client.request('session.open', { sessionId });
    const reopened = await client.request('status.get', { sessionId });
    assert.equal(reopened.permission.profile, 'full-access');
    assert.equal(reopened.permission.network, 'unrestricted');
    const records = await client.request('session.read', { sessionId });
    const changes = records.events.filter((event) => event.kind === 'sessionPermission');
    assert.equal(changes[0].source, 'host-default');
    assert.equal(changes.at(-1).source, 'trusted-ui');
    assert.equal(changes.at(-1).confirmedNetwork, true);
    assert.equal(changes.some((event) => event.profile === 'full-access' && event.confirmedFullAccess === true), true);
  }, { permissionControl: true, permission: permissionWithOwnedProcesses });
});

test('new sessions accept elevated permission only from a confirmed trusted UI request', async () => {
  await withTuiHost(async ({ client }) => {
    await assert.rejects(
      client.request('session.create', {
        initialPermissionProfile: 'full-access', initialPermissionNetwork: 'unrestricted',
        confirmInitialFullAccess: true, confirmInitialNetwork: true,
      }),
      { code: 'permission_control_unavailable' },
    );
  });

  await withTuiHost(async ({ client }) => {
    const request = {
      initialMode: 'minimal', initialPolicy: 'auto',
      initialPermissionProfile: 'full-access', initialPermissionNetwork: 'unrestricted',
      confirmInitialFullAccess: true,
    };
    await assert.rejects(client.request('session.create', request), { code: 'permission_network_confirmation_required' });

    const created = await client.request('session.create', { ...request, confirmInitialNetwork: true });
    const status = await client.request('status.get', { sessionId: created.sessionId });
    assert.equal(status.permission.profile, 'full-access');
    assert.equal(status.permission.network, 'unrestricted');
    assert.equal(status.mode, 'minimal');
    assert.equal(status.policy, 'auto');
    const records = await client.request('session.read', { sessionId: created.sessionId });
    const permission = records.events.find((event) => event.kind === 'sessionPermission');
    assert.equal(permission.source, 'trusted-ui');
    assert.equal(permission.confirmedFullAccess, true);
    assert.equal(permission.confirmedNetwork, true);
    await client.request('session.close', { sessionId: created.sessionId });

    const workspaceWrite = await client.request('session.create', {
      initialPermissionProfile: 'workspace-write', initialPermissionNetwork: 'policy',
      confirmInitialFullAccess: true, confirmInitialNetwork: true,
    });
    const workspaceRecords = await client.request('session.read', { sessionId: workspaceWrite.sessionId });
    const workspacePermission = workspaceRecords.events.find((event) => event.kind === 'sessionPermission');
    assert.equal(workspacePermission.source, 'trusted-ui');
    assert.equal(workspacePermission.profile, 'workspace-write');
    assert.equal(workspacePermission.confirmedFullAccess, false);
    assert.equal(workspacePermission.confirmedNetwork, false);
    await client.request('session.close', { sessionId: workspaceWrite.sessionId });
  }, { permissionControl: true, permission: permissionWithOwnedProcesses });
});

test('permission events record only confirmations required by the change', async () => {
  await withTuiHost(async ({ client, sessionId }) => {
    await client.request('permission.set', {
      sessionId, permissionProfile: 'workspace-write', confirmFullAccess: true, confirmNetwork: true,
    });
    const records = await client.request('session.read', { sessionId });
    const permission = records.events.filter((event) => event.kind === 'sessionPermission').at(-1);
    assert.equal(permission.profile, 'workspace-write');
    assert.equal(permission.confirmedFullAccess, false);
    assert.equal(permission.confirmedNetwork, false);
  }, { permissionControl: true, permission: permissionWithOwnedProcesses });
});

test('changing permission preserves the session policy override across reopening', async () => {
  await withTuiHost(async ({ client, sessionId }) => {
    await client.request('policy.set', { sessionId, mode: 'ask' });
    const before = await client.request('status.get', { sessionId });
    assert.equal(before.policy, 'ask');
    assert.deepEqual(before.denials, { consecutive: 0, total: 0 });
    await client.request('permission.set', { sessionId, permissionProfile: 'workspace-write' });
    const after = await client.request('status.get', { sessionId });
    assert.equal(after.policy, 'ask');
    assert.deepEqual(after.denials, before.denials);
    await client.request('session.close', { sessionId });
    await client.request('session.open', { sessionId });
    const reopened = await client.request('status.get', { sessionId });
    assert.equal(reopened.policy, 'ask');
    assert.deepEqual(reopened.denials, before.denials);
  }, {
    permissionControl: true,
    config: { policy: { mode: 'auto' } },
  });
});

test('forced ask and denial counters survive a session reopen', async () => {
  await withTuiHost(async ({ client, sessionId, projectDirectory }) => {
    client.onRequest((message) => message.method === 'approval.request' ? { decision: 'deny' } : undefined);
    await client.request('policy.set', { sessionId, mode: 'ask' });
    await writeFile(join(projectDirectory, 'notes.md'), 'contents');
    for (let index = 0; index < 3; index += 1) {
      await client.request('run.start', {
        sessionId,
        input: JSON.stringify({ tool: 'read', args: { path: 'notes.md' } }),
      });
    }
    await client.request('policy.set', { sessionId, mode: 'auto' });
    const before = await client.request('status.get', { sessionId });
    assert.equal(before.policy, 'ask');
    assert.equal(before.denials.total, 3);
    await client.request('session.close', { sessionId });
    await client.request('session.open', { sessionId });
    const after = await client.request('status.get', { sessionId });
    assert.equal(after.policy, 'ask');
    assert.deepEqual(after.denials, before.denials);
  }, {
    permission: createPermissionContext('full-access', 'unrestricted', {
      filesystemRead: 'unavailable', filesystemWrite: 'unavailable', network: 'unavailable', process: 'unavailable',
    }),
    config: { policy: { mode: 'ask' } },
  });
});

test('legacy sessions reject permission changes before appending an unsupported event', async () => {
  await withTuiHost(async ({ client, sessionId, sessionDirectory }) => {
    await client.request('session.close', { sessionId });
    const path = join(sessionDirectory, `${sessionId}.jsonl`);
    const before = (await readFile(path, 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line));
    const header = { ...before[0], formatVersion: 1 };
    const legacyEvents = before.slice(1).filter((event) => event.kind !== 'sessionPermission');
    const legacy = `${[header, ...legacyEvents].map((event) => JSON.stringify(event)).join('\n')}\n`;
    await writeFile(path, legacy);
    await client.request('session.open', { sessionId });
    const openedBytes = await readFile(path, 'utf8');
    const openedEvents = (await client.request('session.read', { sessionId })).events.length;
    await assert.rejects(client.request('permission.set', { sessionId, permissionProfile: 'workspace-write' }), {
      code: 'session_permission_format_unsupported',
    });
    await assert.rejects(client.request('policy.set', { sessionId, mode: 'ask' }), {
      code: 'session_policy_format_unsupported',
    });
    assert.equal(await readFile(path, 'utf8'), openedBytes);
    const record = await client.request('session.read', { sessionId });
    assert.equal(record.events.length, legacyEvents.length);
  }, { permissionControl: true });
});

test('headerless v0 sessions reject permission and policy changes without changing their record', async () => {
  await withTuiHost(async ({ client, sessionId, sessionDirectory }) => {
    await client.request('session.close', { sessionId });
    const path = join(sessionDirectory, `${sessionId}.jsonl`);
    const legacy = '{"seq":0,"kind":"user","text":"legacy input"}\n';
    await writeFile(path, legacy);
    await client.request('session.open', { sessionId });
    const openedBytes = await readFile(path, 'utf8');
    const openedEvents = (await client.request('session.read', { sessionId })).events.length;
    await assert.rejects(client.request('permission.set', { sessionId, permissionProfile: 'workspace-write' }), {
      code: 'session_permission_format_unsupported',
    });
    await assert.rejects(client.request('policy.set', { sessionId, mode: 'ask' }), {
      code: 'session_policy_format_unsupported',
    });
    assert.equal(await readFile(path, 'utf8'), openedBytes);
    assert.equal((await client.request('session.read', { sessionId })).events.length, openedEvents);
  }, { permissionControl: true });
});

test('Host approval requests expose the script binding to connected requesters', async () => {
  const permission = createPermissionContext('full-access', 'unrestricted', {
    filesystemRead: 'full', filesystemWrite: 'full', network: 'full', process: 'full',
  });
  const approvals = [];
  await withTuiHost(async ({ client, sessionId, projectDirectory }) => {
    const marker = join(projectDirectory, 'marker.txt');
    const script = join(projectDirectory, 'approved.js');
    const source = `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ran');\n`;
    await writeFile(script, source);
    client.onRequest((message) => {
      if (message.method !== 'approval.request') return undefined;
      approvals.push(message.params);
      return { decision: 'allow' };
    });
    const command = `node "${script.replaceAll('\\', '/')}"`;
    await client.request('run.start', { sessionId, input: JSON.stringify({ tool: 'exec', args: { command } }) });
    assert.equal(await readFile(marker, 'utf8'), 'ran');
    assert.equal(approvals.length, 1);
    const binding = approvals[0].scriptBinding;
    assert.ok(binding);
    assert.equal(binding.path, await realpath(script));
    assert.equal(binding.sha256, createHash('sha256').update(source).digest('hex'));
    assert.match(binding.interpreter, /node(?:\.exe)?$/iu);
    assert.equal(binding.workspaceRoot, await realpath(projectDirectory));
    assert.deepEqual(binding.permission, { profile: 'full-access', network: 'unrestricted', capabilities: permission.capabilities });
  }, { permission });
});
