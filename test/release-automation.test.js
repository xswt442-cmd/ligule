import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { parse as parseYaml } from 'yaml';
import { changelogSection, releaseNotesForTag } from '../scripts/release-notes.js';
import { prepareRelease, resolveVersion } from '../scripts/release-version.js';

const CHANGELOG = `# 更新记录 / Changelog

## [Unreleased]

### 简体中文

#### 修复

- 修复待发布的缺陷。

### English

#### Fixed

- Fixed an unreleased bug.

## [0.0.1] - 2026-09-29

### 简体中文

初始公开版本。

### English

Initial public release.
`;

function lockfile(name, version) {
  return { name, version, lockfileVersion: 3, packages: { '': { name, version } } };
}

async function writeJson(path, value) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function fixture() {
  const directory = await mkdtemp(join(process.cwd(), 'testplace', 'tmp', 'release-automation-'));
  const version = '0.0.1';
  const packageManifest = { name: 'ligule', version, optionalDependencies: {} };
  await writeJson(join(directory, 'package.json'), packageManifest);
  await writeJson(join(directory, 'package-lock.json'), lockfile('ligule', version));
  await writeJson(join(directory, 'desktop', 'package.json'), { name: 'ligule-desktop', version });
  await writeJson(join(directory, 'desktop', 'package-lock.json'), lockfile('ligule-desktop', version));
  await writeJson(join(directory, 'desktop', 'frontend', 'package.json'), { name: 'ligule-desktop-frontend', version });
  await writeJson(join(directory, 'desktop', 'frontend', 'package-lock.json'), lockfile('ligule-desktop-frontend', version));
  await writeJson(join(directory, 'desktop', 'src-tauri', 'tauri.conf.json'), { version });
  await writeJson(join(directory, 'packages', 'rg-win', 'package.json'), { name: 'ligule-rg-win32-x64', version });
  await writeJson(join(directory, 'scripts', 'ripgrep-pin.json'), { targets: { 'win32-x64': { directory: 'rg-win' } } });
  await mkdir(join(directory, 'src'), { recursive: true });
  await writeFile(join(directory, 'src', 'version.js'), `// Keep this comment.\nexport const VERSION = '${version}';\n`, 'utf8');
  await mkdir(join(directory, 'desktop', 'src-tauri'), { recursive: true });
  await writeFile(join(directory, 'desktop', 'src-tauri', 'Cargo.toml'), `[package]\nname = "ligule-desktop"\nversion = "${version}"\nedition = "2021"\n\n[dependencies]\n# Keep dependency notes.\n`, 'utf8');
  await writeFile(join(directory, 'desktop', 'src-tauri', 'Cargo.lock'), `version = 4\n\n[[package]]\nname = "ligule-desktop"\nversion = "${version}"\n\n[[package]]\nname = "other"\nversion = "1.0.0"\n`, 'utf8');
  await writeFile(join(directory, 'CHANGELOG.md'), CHANGELOG, 'utf8');
  return directory;
}

test('version requests resolve supported bump types and reject invalid or older versions', () => {
  assert.equal(resolveVersion('0.0.2', 'patch'), '0.0.3');
  assert.equal(resolveVersion('0.0.2', 'minor'), '0.1.0');
  assert.equal(resolveVersion('0.0.2', 'major'), '1.0.0');
  assert.equal(resolveVersion('0.0.2', '0.0.2'), '0.0.2');
  assert.throws(() => resolveVersion('0.0.2', '0.0.1'), /older than current/);
  assert.throws(() => resolveVersion('0.0.2', 'v0.0.3'), /stable X\.Y\.Z/);
});

test('release preparation updates package, lock, Tauri, Cargo, and runtime versions while preserving unrelated data', async () => {
  const directory = await fixture();
  try {
    const result = prepareRelease(directory, 'patch');
    assert.equal(result.version, '0.0.2');
    assert.ok(result.files.some((path) => path.endsWith('Cargo.lock')));
    const rootLock = JSON.parse(await readFile(join(directory, 'package-lock.json'), 'utf8'));
    assert.equal(rootLock.version, '0.0.2');
    assert.equal(rootLock.packages[''].version, '0.0.2');
    const shellConfig = JSON.parse(await readFile(join(directory, 'desktop/src-tauri/tauri.conf.json'), 'utf8'));
    assert.equal(shellConfig.version, '0.0.2');
    const cargoToml = parse(await readFile(join(directory, 'desktop/src-tauri/Cargo.toml'), 'utf8'));
    assert.equal(cargoToml.package.version, '0.0.2');
    assert.match(await readFile(join(directory, 'desktop/src-tauri/Cargo.toml'), 'utf8'), /# Keep dependency notes\./);
    const cargoLock = parse(await readFile(join(directory, 'desktop/src-tauri/Cargo.lock'), 'utf8'));
    assert.equal(cargoLock.package[0].version, '0.0.2');
    assert.equal(cargoLock.package[1].version, '1.0.0');
    assert.match(await readFile(join(directory, 'src/version.js'), 'utf8'), /Keep this comment/);
    assert.match(await readFile(join(directory, 'src/version.js'), 'utf8'), /VERSION = '0\.0\.2'/);
    const changelog = await readFile(join(directory, 'CHANGELOG.md'), 'utf8');
    assert.match(changelog, /^## \[Unreleased\]\n\n### 简体中文[\s\S]*?## \[0\.0\.2\]/m);
    assert.match(changelog, /^## \[0\.0\.2\] - \d{4}-\d{2}-\d{2}$/m);
    assert.match(changelog, /修复待发布的缺陷/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('release preparation rejects an incomplete bilingual entry before writing version files', async () => {
  const directory = await fixture();
  try {
    await writeFile(join(directory, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n\n### 简体中文\n\n只有中文。\n', 'utf8');
    await assert.rejects(async () => prepareRelease(directory, 'patch'), /needs content under ### English/);
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    assert.equal(manifest.version, '0.0.1');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('release notes use only the matching bilingual version section and add asset guidance', () => {
  const notes = releaseNotesForTag(CHANGELOG, 'v0.0.1');
  assert.match(notes, /初始公开版本/);
  assert.match(notes, /Initial public release/);
  assert.match(notes, /SHA-256/);
  assert.doesNotMatch(notes, /待发布的缺陷/);
  assert.throws(() => changelogSection(CHANGELOG, '0.0.2'), /exactly one/);
  assert.throws(() => releaseNotesForTag(CHANGELOG, '0.0.1'), /vX\.Y\.Z/);
});

test('release workflows separate version PRs, tag creation, npm publication, and draft notes', () => {
  const workflow = (name) => parseYaml(readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));
  const tagWorkflow = workflow('tag');
  const publishWorkflow = workflow('publish');
  const releaseWorkflow = workflow('release');
  const tagInputs = tagWorkflow.on.workflow_dispatch.inputs;

  assert.deepEqual(tagInputs.action.options, ['prepare', 'tag']);
  for (const platform of ['windows_x64', 'linux_x64', 'macos_arm64', 'macos_x64']) {
    assert.equal(tagInputs[platform].default, false, `${platform} must require an explicit validation confirmation`);
  }
  const prepareCommands = tagWorkflow.jobs.prepare.steps.map((step) => step.run ?? '').join('\n');
  const tagCommands = tagWorkflow.jobs['create-tag'].steps.map((step) => step.run ?? '').join('\n');
  assert.match(prepareCommands, /gh pr create --base main/);
  assert.doesNotMatch(prepareCommands, /npm test|npm run check-pack/);
  assert.match(tagCommands, /gh run list --workflow ci\.yml --branch main --event push --commit/);
  assert.doesNotMatch(tagCommands, /gh workflow run ci\.yml/);
  assert.match(tagCommands, /main_head.*COMMIT/s);
  assert.match(tagCommands, /git push origin "v\$\{VERSION\}"/);
  assert.ok(publishWorkflow.on.workflow_dispatch, 'npm publishing must be manually dispatched');
  assert.equal(publishWorkflow.on.push, undefined, 'a tag push must not publish npm packages');
  assert.equal(publishWorkflow.jobs.approval.environment, 'npm-publish');
  assert.ok(publishWorkflow.jobs.platforms.needs.includes('approval'), 'platform packages must wait for approval');
  assert.ok(publishWorkflow.jobs.npm.needs.includes('approval'), 'the main package must wait for approval');
  assert.ok(publishWorkflow.jobs['release-notes'].needs.includes('npm'));
  assert.equal(publishWorkflow.jobs['release-notes'].uses, './.github/workflows/release.yml');
  assert.ok(releaseWorkflow.on.workflow_call, 'publish.yml must be able to call the release workflow');
  assert.ok(releaseWorkflow.on.workflow_dispatch, 'draft recovery must be manually available');
  const releaseCommands = releaseWorkflow.jobs.draft.steps.map((step) => step.run ?? '').join('\n');
  assert.match(releaseCommands, /--notes-file/);
  assert.match(releaseCommands, /preserving its title, body, and assets/);
  assert.doesNotMatch(releaseCommands, /gh release edit/);
  assert.doesNotMatch(releaseCommands, /--generate-notes/);
});
