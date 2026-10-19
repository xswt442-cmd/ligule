import test from 'node:test';
import assert from 'node:assert/strict';
import { createKernel, createPermissionContext, KernelError, loadAssembly, minimalPlugin } from '../dist/index.js';

const manifestPermission = createPermissionContext('workspace-write', 'policy', {
  filesystemRead: 'unavailable', filesystemWrite: 'full', network: 'full', process: 'full',
});

function tool(name) {
  return {
    name,
    description: `the ${name} tool`,
    access: name === 'exec' ? 'exec' : 'read',
    parameters: { type: 'object', properties: {} },
    run: async () => 'ok',
  };
}

function plugin(name, registered, disposed) {
  return {
    name,
    setup(kernel) {
      const disposers = registered.map((toolName) => kernel.register(tool(toolName)));
      return () => {
        for (const dispose of disposers.reverse()) dispose();
        disposed.push(name);
      };
    },
  };
}

test('an empty manifest leaves the kernel with nothing and the assembly list empty', () => {
  const instance = createKernel();
  const assembly = loadAssembly(instance, []);
  assert.deepEqual(assembly.list(), []);
  assert.deepEqual(instance.list(), []);
});

test('the manifest reads back which plugins this run installed', () => {
  const instance = createKernel();
  const disposed = [];
  const assembly = loadAssembly(instance, [
    plugin('files', ['read'], disposed),
    plugin('shell', ['exec'], disposed),
  ]);
  assert.deepEqual(assembly.list(), ['files', 'shell']);
  assert.deepEqual(instance.list(), ['exec', 'read']);
  assembly.dispose();
  assert.deepEqual(assembly.list(), []);
  assert.deepEqual(instance.list(), []);
  assert.deepEqual(disposed, ['shell', 'files']);
});

test('two plugins declaring the same tool name fail the whole load and leave nothing installed', () => {
  const instance = createKernel();
  const disposed = [];
  assert.throws(
    () => loadAssembly(instance, [
      plugin('files', ['read'], disposed),
      plugin('archive', ['read'], disposed),
    ]),
    (error) => error instanceof KernelError && error.code === 'tool_already_registered',
  );
  assert.deepEqual(instance.list(), []);
  assert.deepEqual(disposed, ['files']);
});

test('a plugin that does not hand back a dispose action is rejected and the earlier ones are unwound', () => {
  const instance = createKernel();
  const disposed = [];
  assert.throws(
    () => loadAssembly(instance, [
      plugin('files', ['read'], disposed),
      { name: 'forgetful', setup: () => undefined },
    ]),
    (error) => error.code === 'plugin_dispose_required',
  );
  assert.deepEqual(instance.list(), []);
  assert.deepEqual(disposed, ['files']);
});

test('a plugin whose setup throws is unwound the same way', () => {
  const instance = createKernel();
  const disposed = [];
  assert.throws(
    () => loadAssembly(instance, [
      plugin('files', ['read'], disposed),
      {
        name: 'broken',
        setup: () => {
          throw new Error('boom');
        },
      },
    ]),
    (error) => error.message === 'boom',
  );
  assert.deepEqual(instance.list(), []);
  assert.deepEqual(disposed, ['files']);
});

test('the minimal manifest is exactly the eight tools decided in D3 and unloads completely', () => {
  const instance = createKernel({ permission: manifestPermission });
  const assembly = loadAssembly(instance, [minimalPlugin]);
  assert.deepEqual(assembly.list(), ['ligule-minimal']);
  assert.deepEqual(instance.list(), ['create', 'delete', 'edit', 'exec', 'find', 'read', 'search', 'write']);
  assert.deepEqual(instance.manifest().map((entry) => entry.name), instance.list());
  assembly.dispose();
  assert.deepEqual(assembly.list(), []);
  assert.deepEqual(instance.manifest(), []);
});

test('the manifest rejects a duplicate plugin name and a malformed entry', () => {
  const instance = createKernel();
  const disposed = [];
  assert.throws(
    () => loadAssembly(instance, [plugin('files', ['read'], disposed), plugin('files', ['search'], disposed)]),
    (error) => error.code === 'plugin_name_duplicate',
  );
  assert.throws(() => loadAssembly(instance, [{ setup: () => () => {} }]), (error) => error.code === 'plugin_name_required');
  assert.throws(() => loadAssembly(instance, [{ name: 'x' }]), (error) => error.code === 'plugin_setup_required');
  assert.throws(() => loadAssembly(instance, 'files'), (error) => error.code === 'assembly_manifest_must_be_array');
  assert.deepEqual(instance.list(), []);
});
