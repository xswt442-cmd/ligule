import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfig, KernelError } from '../dist/index.js';

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

// 项目层那一份文件可以出自别人写的仓库。TOML 里一段 `["__proto__"]` 解析出来是对象自己的一个键，
// 直接赋下去会把值挂到所有对象的原型上，后面每一次判定都读得到它。
test('a __proto__ key in a layer is refused instead of polluting every object', () => {
  const hostile = JSON.parse('{"__proto__": {"polluted": 1}}');
  assert.throws(() => createConfig({ user: hostile }), (error) => error.code === 'config_key_unsafe');
  assert.equal({}.polluted, undefined, 'nothing reached Object.prototype');
});

// TOML 的日期时间折出来是一个类实例而不是一张表：按表递归合下去，它没有自己的键，上层那一份就没了。
test('a datetime in a higher layer replaces the lower one instead of merging away', () => {
  const snapshot = createConfig({
    user: { when: new Date('1979-05-27T07:32:00Z'), keep: new Date('2000-01-01T00:00:00Z') },
    project: { when: new Date('2026-10-01T00:00:00Z') },
  });
  assert.equal(snapshot.when.toISOString(), '2026-10-01T00:00:00.000Z');
  assert.equal(snapshot.keep.toISOString(), '2000-01-01T00:00:00.000Z', 'a lower layer value still survives on its own');
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
