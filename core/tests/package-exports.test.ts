import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
  exports?: Record<string, unknown>;
};

const supported = [
  '.',
  './tui.js',
  './host/control.js',
  './host/mcp-server.js',
  './kernel/result.js',
  './kernel/workspace-trust.js',
  './session/atif.js',
  './modes/*',
  './package.json',
];

function importTarget(value: unknown): string {
  assert.ok(typeof value === 'object' && value !== null, 'every conditional export is an object');
  const target = (value as { import?: unknown }).import;
  assert.ok(typeof target === 'string', 'every conditional export names an import target');
  return target;
}

test('the package exposes only paths that have a known consumer', () => {
  assert.ok(manifest.exports !== undefined, 'the package declares exports');
  assert.deepEqual(Object.keys(manifest.exports).sort(), [...supported].sort());
  for (const key of Object.keys(manifest.exports)) {
    if (key === './modes/*') continue;
    assert.doesNotMatch(key, /[*]/u, `${key} is an explicit path, not a wildcard module family`);
  }
});

test('every conditional export maps to a source module', () => {
  for (const key of supported) {
    if (key === './modes/*' || key === './package.json') continue;
    const target = importTarget(manifest.exports?.[key]);
    assert.match(target, /^\.\/dist\/.+[.]js$/u, `${key} publishes a built module`);
    const source = target.replace(/^\.\/dist\//u, '').replace(/[.]js$/u, '.ts');
    const absolute = join(packageRoot, 'src', source);
    assert.ok(existsSync(absolute), `${key} maps to ${relative(packageRoot, absolute)}`);
  }
});

test('the mode files stay reachable through their glob', () => {
  assert.ok(existsSync(join(packageRoot, 'modes', 'minimal.toml')), 'the shipped minimal mode is present');
});
