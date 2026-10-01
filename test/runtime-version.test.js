import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

function firstGroup(text, pattern, label) {
  const match = pattern.exec(text);
  assert.ok(match, `no ${pattern} match in ${label}`);
  return match[1];
}

const workflows = ['ci.yml', 'publish.yml'];

test('the runtime floor is one value across package metadata, README and workflows', () => {
  const pkg = JSON.parse(read('../package.json'));
  const engines = firstGroup(pkg.engines.node, /^>=(\d+)$/, 'package.json engines.node');
  const badge = firstGroup(read('../README.md'), /message=%3E%3D(\d+)/, 'README badge');

  assert.equal(badge, engines, 'the README badge and engines.node disagree');
  for (const file of workflows) {
    const declared = firstGroup(read(`../.github/workflows/${file}`), /PRIMARY_NODE_VERSION: '(\d+)'/, file);
    assert.equal(declared, engines, `${file} and engines.node disagree`);
  }
});

test('the package description carries both languages', () => {
  const description = JSON.parse(read('../package.json')).description;
  assert.match(description, /[\u4e00-\u9fff]/, 'the Chinese part of the description is missing');
  assert.match(description, /[A-Za-z]{4,}\s+[A-Za-z]{4,}/, 'the English part of the description is missing');
});

test('workflows take the Node version from their own env instead of repeating it', () => {
  for (const file of workflows) {
    assert.doesNotMatch(read(`../.github/workflows/${file}`), /node-version:\s*['"]?\d/, `${file} hardcodes a Node version`);
  }
});
