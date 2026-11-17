import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createConfig } from '../dist/kernel/config.js';
import { createPermissionContext } from '../dist/kernel/permission.js';
import { sampleCheckScope } from '../dist/host/checks.js';

test('check scope sampling does not read files when filesystem read is unavailable', async () => {
  const testRoot = join(process.cwd(), 'testplace', 'tmp');
  await mkdir(testRoot, { recursive: true });
  const root = await mkdtemp(join(testRoot, 'check-scope-'));
  try {
    await writeFile(join(root, 'scope.txt'), 'private scoped content\n');
    const config = createConfig({ user: { boundary: root } });
    const permission = createPermissionContext('workspace-write', 'disabled', {
      filesystemRead: 'unavailable', filesystemWrite: 'full', network: 'unavailable', process: 'full',
    });
    const samples = await sampleCheckScope(config, permission, {
      name: 'check', purpose: 'validate permission boundary', expectedExitCodes: [0], scope: ['scope.txt'],
    });
    assert.deepEqual(samples.map(({ status, exists, reason }) => ({ status, exists, reason })), [
      { status: 'unavailable', exists: null, reason: 'read_permission_unavailable' },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('check scope samples a bounded UTF-8 file and reports its existence separately', async () => {
  const testRoot = join(process.cwd(), 'testplace', 'tmp');
  await mkdir(testRoot, { recursive: true });
  const root = await mkdtemp(join(testRoot, 'check-scope-'));
  try {
    await writeFile(join(root, 'scope.txt'), '\uFEFFline\r\n');
    const config = createConfig({ user: { boundary: root } });
    const permission = createPermissionContext('full-access', 'unrestricted', {
      filesystemRead: 'full', filesystemWrite: 'full', network: 'full', process: 'full',
    });
    const declaration = { name: 'check', purpose: 'sample a bounded path', expectedExitCodes: [0], scope: ['scope.txt', 'missing.txt'] };
    const samples = await sampleCheckScope(config, permission, declaration);
    assert.equal(samples[0]?.status, 'available');
    assert.equal(samples[0]?.exists, true);
    assert.match(samples[0]?.version ?? '', /^[a-f0-9]{16}$/u);
    assert.equal(samples[1]?.status, 'available');
    assert.equal(samples[1]?.exists, false);
    assert.equal(samples[1]?.version, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
