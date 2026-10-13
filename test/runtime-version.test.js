import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { releaseManifest } from '../scripts/pack-release.js';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

function firstGroup(text, pattern, label) {
  const match = pattern.exec(text);
  assert.ok(match, `no ${pattern} match in ${label}`);
  return match[1];
}

const workflows = ['ci.yml', 'tag.yml', 'publish.yml', 'release.yml'];

test('the runtime floor is one value across package metadata, README and workflows', () => {
  const pkg = JSON.parse(read('../package.json'));
  const engines = firstGroup(pkg.engines.node, /^>=(\d+)$/, 'package.json engines.node');
  const badge = firstGroup(read('../README.md'), /message=%3E%3D(\d+)/, 'README badge');

  assert.equal(badge, engines, 'the README badge and engines.node disagree');
  for (const file of workflows) {
    const declared = firstGroup(read(`../.github/workflows/${file}`), /PRIMARY_NODE_VERSION: '(\d+)'/, file);
    assert.equal(declared, engines, `${file} and engines.node disagree`);
  }
  // 类型描述的是另一个大版本的运行时时，新写的 TypeScript 模块会用上这一档 Node 没有的接口，本机测试也照样绿。
  const types = firstGroup(pkg.devDependencies['@types/node'], /^\^?(\d+)\./, 'devDependencies @types/node');
  assert.equal(types, engines, '@types/node describes a different Node major version than engines.node');
});

test('the package description carries both languages', () => {
  const description = JSON.parse(read('../package.json')).description;
  assert.match(description, /[\u4e00-\u9fff]/, 'the Chinese part of the description is missing');
  assert.match(description, /[A-Za-z]{4,}\s+[A-Za-z]{4,}/, 'the English part of the description is missing');
});

test('the ripgrep runtime uses the upstream platform-selecting dependency', () => {
  const pkg = JSON.parse(read('../package.json'));
  const release = releaseManifest();
  const provider = JSON.parse(read('../node_modules/@vscode/ripgrep/package.json'));
  assert.equal(pkg.dependencies['@vscode/ripgrep'], '1.18.0');
  assert.equal(release.dependencies['@vscode/ripgrep'], '1.18.0');
  assert.deepEqual(
    ['win32-x64', 'linux-x64', 'darwin-arm64', 'darwin-x64'].map((target) => provider.optionalDependencies[`@vscode/ripgrep-${target}`]),
    ['1.18.0', '1.18.0', '1.18.0', '1.18.0'],
  );
  assert.equal(Object.keys(release.optionalDependencies).some((name) => name.startsWith('ligule-rg-')), false);
});

test('workflows take the Node version from their own env instead of repeating it', () => {
  for (const file of workflows) {
    assert.doesNotMatch(read(`../.github/workflows/${file}`), /node-version:\s*['"]?\d/, `${file} hardcodes a Node version`);
  }
});

test('each npm package manifest agrees with its lockfile', () => {
  for (const [manifestPath, lockPath] of [
    ['../package.json', '../package-lock.json'],
    ['../desktop/package.json', '../desktop/package-lock.json'],
    ['../desktop/frontend/package.json', '../desktop/frontend/package-lock.json'],
  ]) {
    const manifest = JSON.parse(read(manifestPath));
    const lock = JSON.parse(read(lockPath));
    assert.equal(lock.name, manifest.name, `${lockPath} package name disagrees with ${manifestPath}`);
    assert.equal(lock.version, manifest.version, `${lockPath} version disagrees with ${manifestPath}`);
    assert.equal(lock.packages[''].name, manifest.name, `${lockPath} root package name disagrees with ${manifestPath}`);
    assert.equal(lock.packages[''].version, manifest.version, `${lockPath} root package version disagrees with ${manifestPath}`);
  }
});

// 随包 Node 的那四行钉在 `desktop/node-pin.json`，发行清单里也是同样四行：两处说的是同一批字节，抄错一个字符就装不出或装错。
test('the four vendored Node targets match the release checklist', () => {
  const pin = JSON.parse(read('../desktop/node-pin.json'));
  const checklist = read('../docs/development/RELEASE.zh-cn.md');
  const englishChecklist = read('../docs/development/RELEASE.en.md');
  const suffixes = { 'win32-x64': 'zip', 'linux-x64': 'tar.xz', 'darwin-arm64': 'tar.gz', 'darwin-x64': 'tar.gz' };
  assert.deepEqual(Object.keys(pin.targets).sort(), ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64']);
  for (const [target, archived] of Object.entries(pin.targets)) {
    const expected = `node-${pin.version}-${target.replace('win32', 'win')}.${suffixes[target]}`;
    assert.equal(archived.file, expected, `${target} pins ${archived.file}, upstream calls it ${expected}`);
    assert.match(archived.sha256, /^[0-9a-f]{64}$/, `${target} sha256 is not a lowercase hex digest`);
    // 发行清单那一行是给人读的那一份，两处写了同一个文件与同一个摘要才算同一批字节。
    assert.ok(checklist.includes(archived.file), `docs/development/RELEASE.zh-cn.md does not name ${archived.file}`);
    assert.ok(checklist.includes(archived.sha256), `docs/development/RELEASE.zh-cn.md does not carry the ${target} sha256`);
    assert.ok(englishChecklist.includes(archived.file), `docs/development/RELEASE.en.md does not name ${archived.file}`);
    assert.ok(englishChecklist.includes(archived.sha256), `docs/development/RELEASE.en.md does not carry the ${target} sha256`);
  }
});
