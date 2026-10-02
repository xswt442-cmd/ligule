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

test('the ripgrep platform packages move with the release and ship what the build script writes', () => {
  const pkg = JSON.parse(read('../package.json'));
  const pin = JSON.parse(read('../scripts/ripgrep-pin.json'));
  for (const target of Object.values(pin.targets)) {
    const manifest = JSON.parse(read(`../packages/${target.directory}/package.json`));
    assert.equal(manifest.name, target.package, `packages/${target.directory} is named ${manifest.name}`);
    assert.equal(manifest.version, pkg.version, `${target.package} does not move with the release version`);
    assert.equal(pkg.optionalDependencies[target.package], pkg.version, `${target.package} is not pinned to this release`);
    assert.deepEqual(manifest.files, [target.binary, ...pin.licenseFiles, 'RIPGREP-VERSION'], `${target.package} ships a different file list`);
  }
});

test('workflows take the Node version from their own env instead of repeating it', () => {
  for (const file of workflows) {
    assert.doesNotMatch(read(`../.github/workflows/${file}`), /node-version:\s*['"]?\d/, `${file} hardcodes a Node version`);
  }
});

// 桌面壳的安装包与 npm 包同版本发布：三处版本号写在一起，不一致就在这儿失败（D34）。
test('the desktop shell carries the same version as the package', () => {
  const pkg = JSON.parse(read('../package.json'));
  const shell = JSON.parse(read('../desktop/package.json'));
  const config = JSON.parse(read('../desktop/src-tauri/tauri.conf.json'));
  assert.equal(shell.version, pkg.version, 'desktop/package.json and package.json disagree');
  assert.equal(config.version, pkg.version, 'tauri.conf.json and package.json disagree');
});
