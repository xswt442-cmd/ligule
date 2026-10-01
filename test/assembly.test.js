import test from 'node:test';
import assert from 'node:assert/strict';
import { createKernel, KernelError, loadAssembly, minimalPlugin } from '../src/index.js';

function tool(name) {
  return {
    name,
    description: `the ${name} tool`,
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
  const kernel = createKernel();
  const assembly = loadAssembly(kernel, []);
  assert.deepEqual(assembly.list(), []);
  assert.deepEqual(kernel.list(), []);
});

test('the manifest reads back which plugins this run installed', () => {
  const kernel = createKernel();
  const disposed = [];
  const assembly = loadAssembly(kernel, [
    plugin('files', ['read'], disposed),
    plugin('shell', ['exec'], disposed),
  ]);
  assert.deepEqual(assembly.list(), ['files', 'shell']);
  assert.deepEqual(kernel.list(), ['exec', 'read']);
  assembly.dispose();
  assert.deepEqual(assembly.list(), []);
  assert.deepEqual(kernel.list(), []);
  assert.deepEqual(disposed, ['shell', 'files']);
});

test('two plugins declaring the same tool name fail the whole load and leave nothing installed', () => {
  const kernel = createKernel();
  const disposed = [];
  assert.throws(
    () => loadAssembly(kernel, [
      plugin('files', ['read'], disposed),
      plugin('archive', ['read'], disposed),
    ]),
    (error) => error instanceof KernelError && error.code === 'tool_already_registered',
  );
  assert.deepEqual(kernel.list(), []);
  assert.deepEqual(disposed, ['files']);
});

test('a plugin that does not hand back a dispose action is rejected and the earlier ones are unwound', () => {
  const kernel = createKernel();
  const disposed = [];
  assert.throws(
    () => loadAssembly(kernel, [
      plugin('files', ['read'], disposed),
      { name: 'forgetful', setup: () => undefined },
    ]),
    (error) => error.code === 'plugin_dispose_required',
  );
  assert.deepEqual(kernel.list(), []);
  assert.deepEqual(disposed, ['files']);
});

test('a plugin whose setup throws is unwound the same way', () => {
  const kernel = createKernel();
  const disposed = [];
  assert.throws(
    () => loadAssembly(kernel, [
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
  assert.deepEqual(kernel.list(), []);
  assert.deepEqual(disposed, ['files']);
});

test('the minimal manifest is exactly the seven tools decided in D3 and unloads completely', () => {
  const kernel = createKernel();
  const assembly = loadAssembly(kernel, [minimalPlugin]);
  assert.deepEqual(assembly.list(), ['ligule-minimal']);
  assert.deepEqual(kernel.list(), ['create', 'delete', 'edit', 'exec', 'find', 'read', 'search']);
  assert.deepEqual(kernel.manifest().map((entry) => entry.name), kernel.list());
  assembly.dispose();
  assert.deepEqual(assembly.list(), []);
  assert.deepEqual(kernel.manifest(), []);
});

test('the manifest rejects a duplicate plugin name and a malformed entry', () => {
  const kernel = createKernel();
  const disposed = [];
  assert.throws(
    () => loadAssembly(kernel, [plugin('files', ['read'], disposed), plugin('files', ['search'], disposed)]),
    (error) => error.code === 'plugin_name_duplicate',
  );
  assert.throws(() => loadAssembly(kernel, [{ setup: () => () => {} }]), (error) => error.code === 'plugin_name_required');
  assert.throws(() => loadAssembly(kernel, [{ name: 'x' }]), (error) => error.code === 'plugin_setup_required');
  assert.throws(() => loadAssembly(kernel, 'files'), (error) => error.code === 'assembly_manifest_must_be_array');
  assert.deepEqual(kernel.list(), []);
});
