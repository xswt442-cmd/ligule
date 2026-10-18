import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canChangePermission,
  changePermissionAndRefresh,
  permissionConfirmations,
  permissionOf,
} from '../../frontend/src/permission-control.ts';

const capabilities = {
  filesystemRead: 'full',
  filesystemWrite: 'full',
  network: 'full',
  process: 'full',
};

function status(permission = {}, extra = {}) {
  return {
    sessionId: 'session-1',
    running: false,
    permission: {
      profile: 'workspace-write',
      network: 'policy',
      capabilities,
      execution: { available: true, code: null, reason: null },
      changeAllowed: true,
      ...permission,
    },
    ...extra,
  };
}

test('missing status uses read-only and unavailable capability defaults', () => {
  const permission = permissionOf(null);
  assert.equal(permission.profile, 'read-only');
  assert.equal(permission.network, 'policy');
  assert.deepEqual(permission.capabilities, {
    filesystemRead: 'unavailable',
    filesystemWrite: 'unavailable',
    network: 'unavailable',
    process: 'unavailable',
  });
  assert.equal(permission.execution.available, false);
  assert.equal(permission.changeAllowed, false);
  assert.equal(canChangePermission(null, false), false);
  assert.equal(canChangePermission({ sessionId: 'session-1', running: false }, false), false);
  assert.equal(permissionOf({ sessionId: 'session-1', running: false, permission: { profile: 'full-access', changeAllowed: true } }).profile, 'read-only');
});

test('each elevated permission has its own confirmation requirement', () => {
  const current = permissionOf(status());
  assert.deepEqual(permissionConfirmations(current, { profile: 'full-access', network: 'policy' }), ['full-access']);
  assert.deepEqual(permissionConfirmations(current, { profile: 'workspace-write', network: 'unrestricted' }), ['unrestricted-network']);
  assert.deepEqual(permissionConfirmations(current, { profile: 'full-access', network: 'unrestricted' }), ['full-access', 'unrestricted-network']);
});

test('permission.set is never called before each required confirmation', async () => {
  const calls = [];
  const client = { call: async (method) => { calls.push(method); return {}; } };
  await assert.rejects(changePermissionAndRefresh(
    client,
    status(),
    { profile: 'full-access', network: 'unrestricted' },
    { fullAccess: true, network: false },
    false,
  ), /permission_network_confirmation_required/);
  assert.deepEqual(calls, []);
});

test('permission changes are unavailable while the Host disallows them or the session runs', async () => {
  const calls = [];
  const client = { call: async (...args) => { calls.push(args); return {}; } };
  const target = { profile: 'full-access', network: 'policy' };
  await assert.rejects(changePermissionAndRefresh(client, status({ changeAllowed: false }), target, { fullAccess: true, network: false }, false), /permission_change_unavailable/);
  await assert.rejects(changePermissionAndRefresh(client, status(), target, { fullAccess: true, network: false }, true), /permission_change_unavailable/);
  await assert.rejects(changePermissionAndRefresh(client, status({}, { running: true }), target, { fullAccess: true, network: false }, false), /permission_change_unavailable/);
  assert.equal(calls.length, 0);
  assert.equal(canChangePermission(status(), false, true), false);
});

test('both confirmations are required before permission.set and status.get refreshes the view', async () => {
  const calls = [];
  const updated = status({ profile: 'full-access', network: 'unrestricted' });
  const client = {
    call: async (method, params) => {
      calls.push({ method, params });
      return method === 'status.get' ? updated : { applies: 'now' };
    },
  };
  const next = await changePermissionAndRefresh(
    client,
    status(),
    { profile: 'full-access', network: 'unrestricted' },
    { fullAccess: true, network: true },
    false,
  );
  assert.deepEqual(calls.map((call) => call.method), ['permission.set', 'status.get']);
  assert.deepEqual(calls[0].params, {
    sessionId: 'session-1',
    permissionProfile: 'full-access',
    permissionNetwork: 'unrestricted',
    confirmFullAccess: true,
    confirmNetwork: true,
  });
  assert.deepEqual(calls[1].params, { sessionId: 'session-1' });
  assert.equal(next.permission.profile, 'full-access');
});

test('Host confirmation refusal is returned without hiding its error code', async () => {
  const calls = [];
  const client = {
    call: async (method) => {
      calls.push(method);
      const error = new Error('permission_full_access_confirmation_required');
      error.code = 'permission_full_access_confirmation_required';
      throw error;
    },
  };
  await assert.rejects(changePermissionAndRefresh(
    client,
    status(),
    { profile: 'full-access', network: 'policy' },
    { fullAccess: true, network: false },
    false,
  ), { code: 'permission_full_access_confirmation_required' });
  assert.deepEqual(calls, ['permission.set']);
});

test('a status refresh failure is reported after the permission request succeeds', async () => {
  const calls = [];
  const client = {
    call: async (method) => {
      calls.push(method);
      if (method === 'status.get') {
        const error = new Error('host_restarted');
        error.code = 'host_restarted';
        throw error;
      }
      return { applies: 'now' };
    },
  };
  await assert.rejects(changePermissionAndRefresh(
    client,
    status(),
    { profile: 'read-only', network: 'disabled' },
    { fullAccess: false, network: false },
    false,
  ), (error) => error.code === 'permission_status_refresh_failed' && error.causeCode === 'host_restarted');
  assert.deepEqual(calls, ['permission.set', 'status.get']);
});
