import test from 'node:test';
import assert from 'node:assert/strict';
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
