import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { changelogSection, releaseNotesForTag } from '../scripts/release-notes.js';
import { createDesktopReleaseManifest, verifyDesktopReleaseManifests } from '../scripts/desktop-release-manifest.js';
import { prepareRelease, requestedVersionAtRoot, resolveVersion } from '../scripts/release-version.js';

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

async function writeJson(path, value) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function fixture() {
  const parent = join(process.cwd(), 'testplace', 'tmp');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'release-automation-'));
  const version = '0.0.1';
  const desktopVersion = '2.4.1';
  const packageManifest = { name: 'ligule', version, dependencies: { '@vscode/ripgrep': '1.18.0' }, optionalDependencies: {} };
  await writeJson(join(directory, 'package.json'), packageManifest);
  await writeJson(join(directory, 'desktop', 'package.json'), { name: 'ligule-desktop', version: desktopVersion });
  await writeJson(join(directory, 'desktop', 'frontend', 'package.json'), { name: 'ligule-desktop-frontend', private: true, version: '7.6.5' });
  const lock = "lockfileVersion: '9.0'\n\nimporters:\n  .: {}\n  desktop: {}\n  desktop/frontend: {}\n";
  await writeFile(join(directory, 'pnpm-lock.yaml'), lock, 'utf8');
  await mkdir(join(directory, 'src'), { recursive: true });
  await writeFile(join(directory, 'src', 'version.ts'), `// Keep this comment.\nexport const VERSION = '${version}';\n`, 'utf8');
  await writeFile(join(directory, 'CHANGELOG.md'), CHANGELOG, 'utf8');
  await writeFile(join(directory, 'desktop', 'CHANGELOG.md'), CHANGELOG.replace('0.0.1', desktopVersion), 'utf8');
  return directory;
}

test('version requests resolve supported bump types and reject invalid or older versions', () => {
  assert.equal(resolveVersion('0.0.2', 'patch'), '0.0.3');
  assert.equal(resolveVersion('0.0.2', 'minor'), '0.1.0');
  assert.equal(resolveVersion('0.0.2', 'major'), '1.0.0');
  assert.throws(() => resolveVersion('0.0.2', '0.0.2'), /must be newer than current/);
  assert.throws(() => resolveVersion('0.0.2', '0.0.1'), /must be newer than current/);
  assert.throws(() => resolveVersion('0.0.2', 'v0.0.3'), /stable X\.Y\.Z/);
});

test('CLI preparation changes only CLI files and leaves Desktop files byte-for-byte unchanged', async () => {
  const directory = await fixture();
  try {
    const desktopFiles = ['desktop/package.json', 'desktop/frontend/package.json', 'desktop/CHANGELOG.md'];
    const before = await Promise.all(desktopFiles.map(async (path) => [path, await readFile(join(directory, path))]));
    const result = prepareRelease(directory, 'cli', 'patch');
    assert.equal(result.version, '0.0.2');
    assert.equal(result.tag, 'cli-v0.0.2');
    assert.deepEqual(result.files.map((path) => path.replaceAll('\\', '/')), ['CHANGELOG.md', 'package.json', 'src/version.ts']);
    for (const [path, contents] of before) assert.deepEqual(await readFile(join(directory, path)), contents, path);
    assert.equal(JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')).version, '0.0.2');
    assert.equal(await readFile(join(directory, 'pnpm-lock.yaml'), 'utf8'), "lockfileVersion: '9.0'\n\nimporters:\n  .: {}\n  desktop: {}\n  desktop/frontend: {}\n");
    assert.match(await readFile(join(directory, 'src/version.ts'), 'utf8'), /Keep this comment/);
    assert.match(await readFile(join(directory, 'src/version.ts'), 'utf8'), /VERSION = '0\.0\.2'/);
    assert.match(await readFile(join(directory, 'CHANGELOG.md'), 'utf8'), /修复待发布的缺陷/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Desktop preparation changes only Desktop installer metadata and its changelog', async () => {
  const directory = await fixture();
  try {
    const cliFiles = ['package.json', 'src/version.ts', 'CHANGELOG.md', 'desktop/frontend/package.json'];
    const before = await Promise.all(cliFiles.map(async (path) => [path, await readFile(join(directory, path))]));
    const lock = await readFile(join(directory, 'pnpm-lock.yaml'));
    const result = prepareRelease(directory, 'desktop', 'patch');
    assert.equal(result.version, '2.4.2');
    assert.equal(result.tag, 'desktop-v2.4.2');
    assert.deepEqual(result.files.map((path) => path.replaceAll('\\', '/')), ['desktop/CHANGELOG.md', 'desktop/package.json']);
    for (const [path, contents] of before) assert.deepEqual(await readFile(join(directory, path)), contents, path);
    assert.deepEqual(await readFile(join(directory, 'pnpm-lock.yaml')), lock);
    assert.equal(JSON.parse(await readFile(join(directory, 'desktop/package.json'), 'utf8')).version, '2.4.2');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('release preparation rejects an incomplete bilingual entry before writing version files', async () => {
  const directory = await fixture();
  try {
    await writeFile(join(directory, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n\n### 简体中文\n\n只有中文。\n', 'utf8');
    await assert.rejects(async () => prepareRelease(directory, 'cli', 'patch'), /needs content under ### English/);
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    assert.equal(manifest.version, '0.0.1');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('release notes select each product changelog and matching bilingual version section', async () => {
  const directory = await fixture();
  try {
    const cliNotes = releaseNotesForTag(directory, 'cli-v0.0.1');
    assert.match(cliNotes, /初始公开版本/);
    assert.match(cliNotes, /Initial public release/);
    assert.doesNotMatch(cliNotes, /下载|Downloads/);
    assert.match(releaseNotesForTag(directory, 'desktop-v2.4.1'), /SHA-256/);
    assert.throws(() => requestedVersionAtRoot(directory, 'unknown', 'patch'), /product must be cli or desktop/);
    assert.throws(() => requestedVersionAtRoot(directory, '__proto__', 'patch'), /product must be cli or desktop/);
    assert.throws(() => changelogSection(CHANGELOG, '0.0.2'), /exactly one/);
    assert.throws(() => releaseNotesForTag(directory, 'v0.0.1'), /cli-vX\.Y\.Z/);
    await writeFile(join(directory, 'desktop', 'CHANGELOG.md'), CHANGELOG, 'utf8');
    assert.throws(() => releaseNotesForTag(directory, 'desktop-v2.4.1'), /exactly one/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('desktop artifact manifests bind installer hashes to version, target, source commit, and run', async () => {
  const directory = await fixture();
  const output = join(directory, 'artifacts');
  const commit = 'a'.repeat(40);
  const runId = '12345';
  try {
    await mkdir(output, { recursive: true });
    for (const [target, names] of Object.entries({
      'windows-x64': ['Ligule Setup 2.4.2.exe'],
      'linux-x64': ['Ligule-2.4.2.AppImage', 'ligule_2.4.2_amd64.deb'],
      'macos-arm64': ['Ligule-2.4.2.dmg'],
      'macos-x64': ['Ligule-2.4.2.dmg'],
    })) {
      const targetDirectory = join(output, target);
      await mkdir(targetDirectory);
      const sourceDirectory = join(targetDirectory, 'source');
      await mkdir(sourceDirectory);
      for (const name of names) await writeFile(join(sourceDirectory, name), `${target}:${name}`);
      createDesktopReleaseManifest({ directory: sourceDirectory, outputDirectory: targetDirectory, version: '2.4.2', target, commit, runId });
    }
    const result = verifyDesktopReleaseManifests({ directory: output, version: '2.4.2', commit, runId });
    assert.deepEqual(result.targets, ['linux-x64', 'macos-arm64', 'macos-x64', 'windows-x64']);
    assert.equal(result.assets.length, 5);
    const stableManifestPath = join(output, 'desktop-release-manifest.json');
    const stableManifest = await readFile(stableManifestPath);
    assert.doesNotMatch(stableManifest.toString(), /workflowRunId/);

    const incompleteLinux = join(output, 'incomplete-linux');
    await mkdir(incompleteLinux);
    await writeFile(join(incompleteLinux, 'ligule_2.4.2_amd64.deb'), 'first Debian package');
    await writeFile(join(incompleteLinux, 'ligule_2.4.2_arm64.deb'), 'second Debian package');
    assert.throws(() => createDesktopReleaseManifest({ directory: incompleteLinux, version: '2.4.2', target: 'linux-x64', commit, runId }), /exactly one \.AppImage installer; found 0/);

    for (const target of result.targets) {
      createDesktopReleaseManifest({
        directory: join(output, target, 'source'),
        outputDirectory: join(output, target),
        version: '2.4.2',
        target,
        commit,
        runId: '67890',
      });
    }
    verifyDesktopReleaseManifests({ directory: output, version: '2.4.2', commit, runId: '67890' });
    assert.deepEqual(await readFile(stableManifestPath), stableManifest,
      'rebuilding identical installers in a different workflow run must keep the public manifest byte-for-byte stable');

    const linuxManifestPath = join(output, 'linux-x64', 'desktop-release-manifest-linux-x64.json');
    const linuxManifestBytes = await readFile(linuxManifestPath);
    const malformedLinux = JSON.parse(linuxManifestBytes);
    malformedLinux.assets[0].name = malformedLinux.assets[1].name;
    await writeFile(linuxManifestPath, `${JSON.stringify(malformedLinux, null, 2)}\n`);
    assert.throws(() => verifyDesktopReleaseManifests({ directory: output, version: '2.4.2', commit, runId: '67890' }), /exactly one \.AppImage installer/);
    await writeFile(linuxManifestPath, linuxManifestBytes);

    const manifest = JSON.parse(await readFile(join(output, 'macos-x64', 'desktop-release-manifest-macos-x64.json'), 'utf8'));
    await writeFile(join(output, 'macos-x64', manifest.assets[0].name), 'altered installer');
    assert.throws(() => verifyDesktopReleaseManifests({ directory: output, version: '2.4.2', commit, runId: '67890' }), /checksum mismatch/);
    assert.throws(() => verifyDesktopReleaseManifests({ directory: output, version: '2.4.2', commit: 'b'.repeat(40), runId: '67890' }), /does not match/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('release workflows isolate CLI publication from Desktop draft releases and build process tests after compilation', () => {
  const workflow = (name) => parseYaml(readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));
  const tag = workflow('tag');
  const publish = workflow('publish');
  const release = workflow('release');
  const ci = workflow('ci');

  assert.deepEqual(tag.on.workflow_dispatch.inputs.action.options, ['prepare', 'tag']);
  assert.deepEqual(tag.on.workflow_dispatch.inputs.product.options, ['cli', 'desktop']);
  const prepare = tag.jobs.prepare.steps.map((step) => step.run ?? '').join('\n');
  const createTag = tag.jobs['create-tag'].steps.map((step) => step.run ?? '').join('\n');
  assert.match(prepare, /release-version\.js resolve "\$PRODUCT"/);
  assert.match(prepare, /release-version\.js prepare "\$PRODUCT"/);
  assert.match(prepare, /if \[ "\$PRODUCT" = cli \]; then[\s\S]*desktop\/CHANGELOG\.md/);
  assert.match(createTag, /\$\{PRODUCT\}-v\$\{VERSION\}/);
  assert.match(createTag, /gh run list --workflow ci\.yml --branch main --event push --commit/);
  assert.match(createTag, /git merge-base --is-ancestor|main_head/);
  assert.match(createTag, /git ls-remote --exit-code --tags/);

  assert.ok(publish.on.workflow_dispatch);
  assert.equal(publish.on.push, undefined);
  assert.equal(publish.jobs['release-notes'], undefined);
  assert.match(JSON.stringify(publish.jobs.preflight), /npm-publish must have at least one required reviewer/);
  assert.match(JSON.stringify(publish.jobs.preflight), /required_reviewers/);
  assert.equal(publish.jobs.approval.environment, 'npm-publish');
  assert.equal(publish.jobs.npm.permissions['id-token'], 'write');
  assert.doesNotMatch(JSON.stringify(publish.jobs.npm), /NPM_TOKEN|NODE_AUTH_TOKEN/);
  assert.match(JSON.stringify(publish.jobs.preflight), /cli-v/);
  assert.ok(JSON.stringify(publish).includes('pnpm install --frozen-lockfile'));
  assert.ok(JSON.stringify(publish.jobs.npm).includes('npm publish --provenance --access public'));
  assert.ok(publish.jobs.checks.steps.some((step) => step.run?.includes('pnpm --filter ligule run pack-release dist-tarball')));
  assert.ok(publish.jobs.verify.steps.some((step) => step.run?.startsWith('pnpm --filter ligule run verify-install ')));
  assert.doesNotMatch(JSON.stringify(publish.jobs.npm), /pnpm|registry-version/,
    'the OIDC publication job consumes the already checked registry result and does not depend on an uninstalled helper');
  assert.equal(publish.jobs.npm.needs.includes('registry-check'), true);
  const registrySteps = publish.jobs['registry-check'].steps;
  const registryCommand = registrySteps.find((step) => step.name === 'compare the package tarball with the registry').run;
  assert.match(registryCommand, /pnpm --filter ligule run --silent registry-version "ligule@/);
  assert.doesNotMatch(registryCommand, /registry-version --/);
  assert.ok(registrySteps.some((step) => step.run === 'pnpm install --frozen-lockfile'));
  assert.ok(registrySteps.findIndex((step) => step.uses === 'pnpm/action-setup@v4')
    < registrySteps.findIndex((step) => step.uses === 'actions/setup-node@v5'),
  'pnpm must exist before setup-node configures pnpm caching');

  assert.ok(release.on.workflow_dispatch);
  assert.equal(release.on.workflow_call, undefined);
  assert.equal(release.on.push, undefined);
  assert.match(JSON.stringify(release.jobs.preflight), /desktop-v/);
  assert.match(JSON.stringify(release.jobs.preflight), /git merge-base --is-ancestor/);
  assert.equal(release.jobs.build.steps[0].with.ref, '${{ needs.preflight.outputs.commit }}');
  assert.deepEqual(release.jobs.build.strategy.matrix.include.map(({ target }) => target), [
    'windows-x64', 'linux-x64', 'macos-arm64', 'macos-x64',
  ]);
  const draft = release.jobs.draft.steps.map((step) => step.run ?? '').join('\n');
  assert.match(draft, /desktop-release-manifest\.js verify/);
  assert.match(draft, /gh release create "\$TAG" --verify-tag[^\n]*--draft/);
  assert.match(draft, /refusing to modify published Release/);
  assert.match(draft, /gh release upload "\$TAG"/);
  assert.match(draft, /comm -13/);
  assert.match(draft, /draft Release contains assets outside the verified set/);
  assert.doesNotMatch(draft, /--clobber|gh release edit/);

  const desktopSteps = ci.jobs.desktop.steps;
  const installerBuild = desktopSteps.findIndex((step) => step.name === 'build the Electron installer');
  const windowsTree = desktopSteps.findIndex((step) => step.name === 'test Windows Host Job Object process-tree cleanup');
  const posixTree = desktopSteps.findIndex((step) => step.name === 'test POSIX Host process-group cleanup and orphan watchdog');
  assert.ok(installerBuild >= 0 && windowsTree > installerBuild && posixTree > installerBuild,
    'process-tree tests require compiled Host runtime output from the installer build');
});
