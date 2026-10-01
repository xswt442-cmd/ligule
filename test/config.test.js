import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfig, KernelError } from '../src/index.js';

test('a key written in two layers is taken from the higher-precedence one', () => {
  const config = createConfig({
    user: { mode: 'user', keep: 1 },
    managed: { mode: 'managed' },
  });
  assert.deepEqual(config, { mode: 'managed', keep: 1 });
});

test('the five layers fold in the order user, project, local, flag, managed', () => {
  const config = createConfig({
    user: { mode: 1 },
    project: { mode: 2 },
    local: { mode: 3 },
    flag: { mode: 4 },
    managed: { mode: 5 },
  });
  assert.equal(config.mode, 5);
});

test('nested objects merge key by key while arrays replace the whole list', () => {
  const config = createConfig({
    user: { sandbox: { network: 'on', paths: ['a', 'b'] }, allow: ['read'] },
    project: { sandbox: { network: 'off' } },
    local: { allow: ['read', 'write'] },
  });
  assert.deepEqual(config.sandbox, { network: 'off', paths: ['a', 'b'] });
  assert.deepEqual(config.allow, ['read', 'write']);
});

test('the snapshot is read all the way down', () => {
  const config = createConfig({ user: { sandbox: { network: 'on' } }, project: { allow: ['read'] } });
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config.sandbox));
  assert.ok(Object.isFrozen(config.allow));
  assert.throws(() => {
    config.sandbox = {};
  }, TypeError);
});

test('the snapshot does not share references with the layer objects', () => {
  const layer = { sandbox: { network: 'on' }, allow: ['read'] };
  const config = createConfig({ user: layer });
  layer.sandbox.network = 'off';
  layer.allow.push('write');
  assert.deepEqual(config.sandbox, { network: 'on' });
  assert.deepEqual(config.allow, ['read']);
});

test('an unknown layer name or a layer that is not an object fails at once', () => {
  assert.throws(
    () => createConfig({ managd: { mode: 1 } }),
    (error) => error instanceof KernelError && error.code === 'config_layer_unknown',
  );
  assert.throws(
    () => createConfig({ user: ['mode', 'x'] }),
    (error) => error.code === 'config_layer_must_be_object',
  );
  assert.throws(() => createConfig('user'), (error) => error.code === 'config_layers_must_be_object');
});
