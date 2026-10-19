import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createInteractivePermissionContext,
  detectPermissionCapabilities,
} from '../dist/capability/permission-capabilities.js';
import { permissionDenial } from '../dist/kernel/permission.js';

test('a successful Linux isolation and process ownership probe reports measured features and known limits', async () => {
  let probes = 0;
  const snapshot = await detectPermissionCapabilities({
    platform: 'linux',
    probeLinux: async () => {
      probes += 1;
      return { available: true };
    },
    probeLinuxProcessOwnership: async () => true,
  });

  assert.equal(probes, 1);
  assert.equal(snapshot.backend, 'bubblewrap');
  assert.deepEqual(snapshot.capabilities, {
    filesystemRead: 'partial',
    filesystemWrite: 'partial',
    network: 'full',
    process: 'full',
  });
  assert.ok(snapshot.limitations.some((limitation) => limitation.includes('host operating-system files')));
  assert.ok(snapshot.limitations.some((limitation) => limitation.includes('hard-link checks')));
  assert.ok(snapshot.limitations.some((limitation) => limitation.includes('destination-based network allowlists')));
  assert.ok(snapshot.limitations.some((limitation) => limitation.includes('CPU, memory, or process-count limits')));
});

test('a failed Linux isolation probe reports restrictions unavailable while retaining measured process ownership', async () => {
  const snapshot = await detectPermissionCapabilities({
    platform: 'linux',
    probeLinux: async () => ({ available: false, reason: 'user namespaces are disabled' }),
    probeLinuxProcessOwnership: async () => true,
  });

  assert.equal(snapshot.backend, 'unavailable');
  assert.equal(snapshot.reason, 'user namespaces are disabled');
  assert.deepEqual(snapshot.capabilities, {
    filesystemRead: 'unavailable',
    filesystemWrite: 'unavailable',
    network: 'unavailable',
    process: 'full',
  });
});

test('Windows reports Job Object ownership only when its runtime probe succeeds', async () => {
  let probes = 0;
  const snapshot = await detectPermissionCapabilities({
    platform: 'win32',
    probeWindowsProcessOwnership: async () => {
      probes += 1;
      return true;
    },
  });

  assert.equal(probes, 1);
  assert.equal(snapshot.backend, 'unavailable');
  assert.match(snapshot.reason, /no OS sandbox backend is available for win32/u);
  assert.deepEqual(snapshot.capabilities, {
    filesystemRead: 'unavailable', filesystemWrite: 'unavailable', network: 'unavailable', process: 'full',
  });
});

test('failed or throwing process ownership probes fail closed', async () => {
  const linux = await detectPermissionCapabilities({
    platform: 'linux',
    probeLinux: async () => ({ available: true }),
    probeLinuxProcessOwnership: async () => { throw new Error('koffi unavailable'); },
  });
  const windows = await detectPermissionCapabilities({
    platform: 'win32',
    probeWindowsProcessOwnership: async () => false,
  });

  assert.equal(linux.capabilities.process, 'unavailable');
  assert.equal(windows.capabilities.process, 'unavailable');
});

test('Linux detects process ownership through the real subreaper probe', {
  skip: process.platform === 'linux' ? false : 'requires Linux',
}, async () => {
  const snapshot = await detectPermissionCapabilities({
    platform: 'linux',
    probeLinux: async () => ({ available: false, reason: 'sandbox probe is not under test' }),
  });

  assert.equal(snapshot.capabilities.process, 'full');
});

test('interactive Host permission starts read-only and carries the detected capability snapshot', async () => {
  const permission = await createInteractivePermissionContext({
    platform: 'linux',
    probeLinux: async () => ({ available: true }),
    probeLinuxProcessOwnership: async () => true,
  });

  assert.equal(permission.profile, 'read-only');
  assert.equal(permission.network, 'policy');
  assert.deepEqual(permission.capabilities, {
    filesystemRead: 'partial',
    filesystemWrite: 'partial',
    network: 'full',
    process: 'full',
  });
  assert.equal(Object.isFrozen(permission), true);
  assert.equal(Object.isFrozen(permission.capabilities), true);
});

test('interactive permission remains read-only and denies exec when platform isolation is unavailable', async () => {
  const permission = await createInteractivePermissionContext({
    platform: 'win32',
    probeWindowsProcessOwnership: async () => false,
  });

  assert.equal(permission.profile, 'read-only');
  assert.equal(permission.capabilities.process, 'unavailable');
  assert.equal(permissionDenial(permission, 'exec')?.code, 'permission_sandbox_unavailable');
});
