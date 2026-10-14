import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { changelogSection, desktopDownloadTable, releaseNotesForTag } from '../scripts/release-notes.js';
import { createDesktopReleaseManifest, verifyDesktopReleaseManifests } from '../scripts/desktop-release-manifest.js';
import { githubAssetName, verifyDesktopDraft } from '../scripts/verify-desktop-draft.js';
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
    assert.match(cliNotes, /npm install -g ligule@0\.0\.1/);
    assert.match(cliNotes, /npmjs\.com\/package\/ligule\/v\/0\.0\.1/);
    assert.match(cliNotes, /this GitHub Release contains bilingual notes/);
    const desktopPreview = releaseNotesForTag(directory, 'desktop-v2.4.1');
    assert.match(desktopPreview, /SHA-256/);
    assert.match(desktopPreview, /\| Windows x64 \| NSIS/);
    assert.match(desktopPreview, /\| Linux x64 \| AppImage/);
    assert.match(desktopPreview, /\| Linux x64 \| deb/);
    assert.match(desktopPreview, /releases\/tag\/desktop-v2\.4\.1#assets/);
    assert.doesNotMatch(desktopPreview, /draft Release after platform validation|草稿 Release/);
    const commit = 'a'.repeat(40);
    const manifest = {
      schemaVersion: 1,
      product: 'desktop',
      tag: 'desktop-v2.4.1',
      version: '2.4.1',
      sourceCommit: commit,
      assets: [
        { target: 'windows-x64', architecture: 'x64', name: `ligule-desktop-v2.4.1-windows-x64-${commit.slice(0, 12)}-ligule Setup 2.4.1.exe`, sha256: 'b'.repeat(64) },
        { target: 'linux-x64', architecture: 'x64', name: `ligule-desktop-v2.4.1-linux-x64-${commit.slice(0, 12)}-ligule-2.4.1.AppImage`, sha256: 'c'.repeat(64) },
        { target: 'linux-x64', architecture: 'x64', name: `ligule-desktop-v2.4.1-linux-x64-${commit.slice(0, 12)}-ligule-desktop_2.4.1_amd64.deb`, sha256: 'd'.repeat(64) },
      ],
    };
    const downloadableNotes = releaseNotesForTag(directory, 'desktop-v2.4.1', { manifest });
    assert.match(downloadableNotes, /releases\/download\/desktop-v2\.4\.1\/.*-ligule\.Setup\.2\.4\.1\.exe/);
    assert.match(downloadableNotes, /releases\/download\/desktop-v2\.4\.1\/.*\.AppImage/);
    assert.match(downloadableNotes, /releases\/download\/desktop-v2\.4\.1\/.*\.deb/);
    assert.match(downloadableNotes, /desktop-release-manifest\.json/);
    assert.doesNotMatch(downloadableNotes, /%20|草稿 Release/);
    assert.throws(() => desktopDownloadTable('cli-v2.4.1'), /Desktop tag/);
    assert.throws(() => releaseNotesForTag(directory, 'cli-v0.0.1', { manifest }), /do not accept/);
    assert.throws(() => releaseNotesForTag(directory, 'desktop-v2.4.1', { manifest: { ...manifest, tag: 'desktop-v2.4.2' } }), /verified manifest/);
    assert.throws(() => releaseNotesForTag(directory, 'desktop-v2.4.1', {
      manifest: { ...manifest, assets: manifest.assets.slice(0, 2) },
    }), /verified manifest/);
    assert.throws(() => releaseNotesForTag(directory, 'desktop-v2.4.1', {
      manifest: { ...manifest, assets: manifest.assets.map((asset, i) => i === 0 ? { ...asset, name: '../unsafe.exe' } : asset) },
    }), /missing or duplicate Desktop asset|invalid asset identity/);
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

test('Desktop release manifests require Windows and Linux installers and bind them to the tagged source', async () => {
  const directory = await fixture();
  const output = join(directory, 'artifacts');
  const commit = 'a'.repeat(40);
  const runId = '12345';
  try {
    await mkdir(output, { recursive: true });
    for (const [target, names] of Object.entries({
      'windows-x64': ['Ligule Setup 2.4.2.exe'],
      'linux-x64': ['Ligule-2.4.2.AppImage', 'ligule_2.4.2_amd64.deb'],
    })) {
      const targetDirectory = join(output, target);
      await mkdir(targetDirectory);
      const sourceDirectory = join(directory, `${target}-source`);
      await mkdir(sourceDirectory);
      for (const name of names) await writeFile(join(sourceDirectory, name), `${target}:${name}`);
      createDesktopReleaseManifest({ directory: sourceDirectory, outputDirectory: targetDirectory, version: '2.4.2', target, commit, runId });
    }
    const result = verifyDesktopReleaseManifests({ directory: output, version: '2.4.2', commit, runId });
    assert.deepEqual(result.targets, ['linux-x64', 'windows-x64']);
    assert.equal(result.assets.length, 3);
    const stableManifestPath = join(output, 'desktop-release-manifest.json');
    const stableManifest = await readFile(stableManifestPath);
    assert.doesNotMatch(stableManifest.toString(), /workflowRunId/);
    assert.throws(() => createDesktopReleaseManifest({ directory: output, version: '2.4.2', target: 'macos-arm64', commit, runId }), /unsupported desktop target/);

    const incompleteLinux = join(directory, 'incomplete-linux');
    await mkdir(incompleteLinux);
    await writeFile(join(incompleteLinux, 'ligule_2.4.2.AppImage'), 'AppImage');
    await writeFile(join(incompleteLinux, 'ligule_2.4.2_amd64.deb'), 'first Debian package');
    await writeFile(join(incompleteLinux, 'ligule_2.4.2_arm64.deb'), 'second Debian package');
    assert.throws(() => createDesktopReleaseManifest({ directory: incompleteLinux, version: '2.4.2', target: 'linux-x64', commit, runId }), /exactly one \.deb installer; found 2/);
    const missingLinux = join(directory, 'missing-linux');
    await mkdir(missingLinux);
    await writeFile(join(missingLinux, 'ligule_2.4.2.AppImage'), 'AppImage');
    assert.throws(() => createDesktopReleaseManifest({ directory: missingLinux, version: '2.4.2', target: 'linux-x64', commit, runId }), /exactly one \.deb installer; found 0/);

    for (const target of result.targets) {
      createDesktopReleaseManifest({
        directory: join(directory, `${target}-source`),
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

    const optionalMacDirectory = join(output, 'macos-arm64');
    await mkdir(optionalMacDirectory);
    await writeFile(join(optionalMacDirectory, 'Ligule-2.4.2.dmg'), 'optional, unverified DMG');
    assert.throws(() => verifyDesktopReleaseManifests({ directory: output, version: '2.4.2', commit, runId: '67890' }), /unexpected Desktop release target: macos-arm64/);
    await rm(optionalMacDirectory, { recursive: true });

    const unexpectedRootAsset = join(output, 'unexpected.dmg');
    await writeFile(unexpectedRootAsset, 'unverified DMG');
    assert.throws(() => verifyDesktopReleaseManifests({ directory: output, version: '2.4.2', commit, runId: '67890' }), /unexpected file in Desktop release set: unexpected\.dmg/);
    await rm(unexpectedRootAsset);

    const unexpectedTargetAsset = join(output, 'linux-x64', 'unexpected.dmg');
    await writeFile(unexpectedTargetAsset, 'unverified DMG');
    assert.throws(() => verifyDesktopReleaseManifests({ directory: output, version: '2.4.2', commit, runId: '67890' }), /unexpected file for linux-x64: unexpected\.dmg/);
    await rm(unexpectedTargetAsset);

    const windowsManifestPath = join(output, 'windows-x64', 'desktop-release-manifest-windows-x64.json');
    const windowsManifestBytes = await readFile(windowsManifestPath);
    await rm(windowsManifestPath);
    assert.throws(() => verifyDesktopReleaseManifests({ directory: output, version: '2.4.2', commit, runId: '67890' }), /missing or invalid manifest for windows-x64/);
    await writeFile(windowsManifestPath, windowsManifestBytes);

    const linuxManifestPath = join(output, 'linux-x64', 'desktop-release-manifest-linux-x64.json');
    const linuxManifestBytes = await readFile(linuxManifestPath);
    const extraAssetManifest = JSON.parse(linuxManifestBytes);
    extraAssetManifest.assets.push({ name: 'unexpected.dmg', sha256: '0'.repeat(64) });
    await writeFile(linuxManifestPath, `${JSON.stringify(extraAssetManifest, null, 2)}\n`);
    assert.throws(() => verifyDesktopReleaseManifests({ directory: output, version: '2.4.2', commit, runId: '67890' }), /unexpected installer count/);
    await writeFile(linuxManifestPath, linuxManifestBytes);

    const malformedLinux = JSON.parse(linuxManifestBytes);
    malformedLinux.assets[0].name = malformedLinux.assets[1].name;
    await writeFile(linuxManifestPath, `${JSON.stringify(malformedLinux, null, 2)}\n`);
    assert.throws(() => verifyDesktopReleaseManifests({ directory: output, version: '2.4.2', commit, runId: '67890' }), /exactly one \.AppImage installer/);
    await writeFile(linuxManifestPath, linuxManifestBytes);

    const manifest = JSON.parse(await readFile(windowsManifestPath, 'utf8'));
    await writeFile(join(output, 'windows-x64', manifest.assets[0].name), 'altered installer');
    assert.throws(() => verifyDesktopReleaseManifests({ directory: output, version: '2.4.2', commit, runId: '67890' }), /checksum mismatch/);
    assert.throws(() => verifyDesktopReleaseManifests({ directory: output, version: '2.4.2', commit: 'b'.repeat(40), runId: '67890' }), /does not match/);
    assert.throws(() => verifyDesktopReleaseManifests({ directory: output, version: '2.4.2', commit, runId: '99999' }), /does not match/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('published Desktop draft verification accepts GitHub-normalized names but rejects tampering', async () => {
  const directory = await fixture();
  const artifacts = join(directory, 'artifacts');
  const draft = join(directory, 'draft');
  const commit = 'a'.repeat(40);
  const version = '2.4.2';
  const tag = 'desktop-v2.4.2';
  try {
    await mkdir(artifacts, { recursive: true });
    await mkdir(draft);
    for (const [target, names] of Object.entries({
      'windows-x64': ['Ligule Setup 2.4.2.exe'],
      'linux-x64': ['Ligule-2.4.2.AppImage', 'ligule_2.4.2_amd64.deb'],
    })) {
      const source = join(directory, `${target}-source`);
      const output = join(artifacts, target);
      await mkdir(source);
      await mkdir(output);
      for (const name of names) await writeFile(join(source, name), `${target}:${name}`);
      createDesktopReleaseManifest({ directory: source, outputDirectory: output, version, target, commit, runId: '100' });
    }
    verifyDesktopReleaseManifests({ directory: artifacts, version, commit, runId: '100' });
    for (const file of ['SHA256SUMS', 'desktop-release-manifest.json']) {
      await copyFile(join(artifacts, file), join(draft, file));
    }
    const manifest = JSON.parse(await readFile(join(artifacts, 'desktop-release-manifest.json'), 'utf8'));
    for (const asset of manifest.assets) {
      await copyFile(join(artifacts, asset.target, asset.name), join(draft, githubAssetName(asset.name)));
    }

    assert.equal(githubAssetName('Ligule Setup 2.4.2.exe'), 'Ligule.Setup.2.4.2.exe');
    assert.equal(verifyDesktopDraft(draft, tag, commit).assets, 3);
    assert.throws(() => verifyDesktopDraft(draft, tag, 'b'.repeat(40)), /source commit/);

    const win = manifest.assets.find((asset) => asset.target === 'windows-x64');
    const winName = githubAssetName(win.name);
    await writeFile(join(draft, winName), 'tampered installer');
    assert.throws(() => verifyDesktopDraft(draft, tag, commit), /SHA-256 mismatch/);
    await copyFile(join(artifacts, win.target, win.name), join(draft, winName));

    await writeFile(join(draft, 'unverified.dmg'), 'untrusted asset');
    assert.throws(() => verifyDesktopDraft(draft, tag, commit), /missing or unexpected assets/);
    await rm(join(draft, 'unverified.dmg'));

    await writeFile(join(draft, 'SHA256SUMS'), 'incorrect checksums\n');
    assert.throws(() => verifyDesktopDraft(draft, tag, commit), /SHA256SUMS does not match/);
    await copyFile(join(artifacts, 'SHA256SUMS'), join(draft, 'SHA256SUMS'));
    assert.equal(verifyDesktopDraft(draft, tag, commit).assets, 3);
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

  assert.equal(tag.on.workflow_dispatch.inputs.action, undefined,
    'version preparation must be handled in normal development, not by a release-specific PR');
  assert.deepEqual(Object.keys(tag.jobs), ['create-tag']);
  assert.equal(tag.permissions.contents, 'read');
  assert.deepEqual(tag.jobs['create-tag'].permissions, { actions: 'read', contents: 'write' });
  assert.deepEqual(tag.on.workflow_dispatch.inputs.product.options, ['cli', 'desktop']);
  assert.equal(tag.jobs['create-tag'].steps.find((step) => step.uses === 'actions/setup-node@v5').with['package-manager-cache'], false);
  for (const [workflowConfig, jobName] of [[publish, 'npm'], [publish, 'github-notes'], [release, 'preflight'], [release, 'draft'], [release, 'publish']]) {
    const setup = workflowConfig.jobs[jobName].steps.find((step) => step.uses === 'actions/setup-node@v5');
    assert.equal(setup?.with['package-manager-cache'], false,
      `${jobName} must disable pnpm auto-caching when pnpm is not installed`);
  }
  const createTag = tag.jobs['create-tag'].steps.map((step) => step.run ?? '').join('\n');
  assert.doesNotMatch(JSON.stringify(tag), /gh pr create|release\/\$\{tag\}|release\/\$\{TAG\}|pull-requests: write|git push origin "\$BRANCH"/i,
    'Tag workflow must not create product-specific PRs or version branches');
  assert.equal(tag.jobs['create-tag'].steps[0].with.ref, '${{ github.sha }}');
  assert.match(createTag, /test "\$GITHUB_REF" = refs\/heads\/main/);
  assert.match(createTag, /package\.json; else manifest=desktop\/package\.json/);
  assert.match(createTag, /node scripts\/release-notes\.js "\$TAG"/);
  assert.match(createTag, /\$commit" != "\$main_head/);
  assert.match(createTag, /\$\{PRODUCT\}-v\$\{VERSION\}/);
  assert.match(createTag, /gh run list --workflow ci\.yml --branch main --event push --commit/);
  assert.match(createTag, /git merge-base --is-ancestor|main_head/);
  assert.match(createTag, /git ls-remote --exit-code --tags/);

  assert.ok(publish.on.workflow_dispatch);
  assert.equal(publish.on.push, undefined);
  const cliNotesJob = publish.jobs['github-notes'];
  assert.deepEqual(cliNotesJob.needs, ['preflight', 'npm']);
  assert.equal(cliNotesJob.permissions.contents, 'write');
  assert.equal(cliNotesJob.steps[0].with.ref, '${{ needs.preflight.outputs.commit }}');
  const cliNotesScript = cliNotesJob.steps.map((step) => step.run ?? '').join('\n');
  assert.match(cliNotesScript, /npm view "ligule@\$\{VERSION\}" version/);
  assert.match(cliNotesScript, /release-notes\.js "\$TAG"/);
  assert.match(cliNotesScript, /gh release create "\$TAG"/);
  assert.match(cliNotesScript, /--latest=false/);
  assert.match(cliNotesScript, /if existing=\$\(gh release view/);
  assert.match(cliNotesScript, /\[ "\$existing" != false \]/);
  assert.doesNotMatch(cliNotesScript, /npm publish/);
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
  assert.equal(release.on.workflow_dispatch.inputs.publish.default, false);
  assert.match(JSON.stringify(release.jobs.preflight), /desktop-v/);
  assert.match(JSON.stringify(release.jobs.preflight), /git merge-base --is-ancestor/);
  assert.equal(release.jobs.build.steps[0].with.ref, '${{ needs.preflight.outputs.commit }}');
  assert.deepEqual(release.jobs.build.strategy.matrix.include.map(({ target }) => target), [
    'windows-x64', 'linux-x64',
  ]);
  assert.equal(ci.jobs.desktop['continue-on-error'], "${{ startsWith(matrix.id, 'macos-') }}");
  assert.equal(ci.jobs.credentials['continue-on-error'], "${{ startsWith(matrix.os, 'macos-') }}");
  assert.equal(ci.on.workflow_dispatch.inputs.include_macos.default, false);
  const matrixVariants = (expression) => [...expression.matchAll(/'(\[[\s\S]*?\])'/g)].map(([, json]) => JSON.parse(json));
  assert.match(ci.jobs.credentials.strategy.matrix.os, /github\.event_name == 'workflow_dispatch' && inputs\.include_macos/);
  assert.deepEqual(matrixVariants(ci.jobs.credentials.strategy.matrix.os), [
    ['windows-latest', 'ubuntu-22.04', 'macos-15', 'macos-15-intel'],
    ['windows-latest', 'ubuntu-22.04'],
  ]);
  assert.match(ci.jobs.desktop.strategy.matrix.include, /github\.event_name == 'workflow_dispatch' && inputs\.include_macos/);
  assert.deepEqual(matrixVariants(ci.jobs.desktop.strategy.matrix.include).map((matrix) => matrix.map(({ id }) => id)), [
    ['windows-x64', 'linux-x64', 'macos-arm64', 'macos-x64'],
    ['windows-x64', 'linux-x64'],
  ]);
  assert.doesNotMatch(JSON.stringify(release.jobs.draft), /macos|\.dmg/i,
    'unverified macOS installers must not enter the formal Desktop release asset set');
  const draft = release.jobs.draft.steps.map((step) => step.run ?? '').join('\n');
  assert.match(draft, /desktop-release-manifest\.js verify/);
  assert.match(draft, /release-notes\.js "\$TAG" --manifest dist-release\/desktop-release-manifest\.json/);
  assert.match(draft, /gh release create "\$TAG" --verify-tag[^\n]*--draft/);
  assert.match(draft, /refusing to modify published Release/);
  assert.match(draft, /gh release upload "\$TAG"/);
  assert.match(draft, /comm -13/);
  assert.match(draft, /draft Release contains assets outside the verified set/);
  assert.doesNotMatch(draft, /--clobber|gh release edit/);
  assert.equal(release.jobs.publish.environment, 'desktop-publish');
  assert.match(JSON.stringify(release.jobs['publish-preflight']), /desktop-publish must have at least one required reviewer/);
  const publishDesktop = release.jobs.publish.steps.map((step) => step.run ?? '').join('\n');
  assert.match(publishDesktop, /verify-desktop-draft\.js/);
  assert.match(publishDesktop, /gh release download/);
  assert.equal(release.jobs.build.if, '${{ !inputs.publish }}');
  assert.equal(release.jobs.draft.if, '${{ !inputs.publish }}');
  assert.deepEqual(release.jobs.publish.needs, ['preflight', 'publish-preflight']);
  assert.equal(release.jobs.publish.steps[0].with.ref, '${{ github.sha }}');
  assert.doesNotMatch(JSON.stringify(release.jobs.publish), /actions\/download-artifact/);
  assert.match(publishDesktop, /PATCH .*releases\/\$\{release_id\}.*draft=false/);

  const desktopSteps = ci.jobs.desktop.steps;
  const installerBuild = desktopSteps.findIndex((step) => step.name === 'build the Electron installer');
  const windowsTree = desktopSteps.findIndex((step) => step.name === 'test Windows Host Job Object process-tree cleanup');
  const posixTree = desktopSteps.findIndex((step) => step.name === 'test POSIX Host process-group cleanup and orphan watchdog');
  assert.ok(installerBuild >= 0 && windowsTree > installerBuild && posixTree > installerBuild,
    'process-tree tests require compiled Host runtime output from the installer build');
  for (const steps of [desktopSteps, release.jobs.build.steps]) {
    const hostBuild = steps.findIndex((step) => step.name === 'build the Host runtime tree');
    const hostTests = steps.findIndex((step) => step.name === 'test Electron Host and security contracts');
    assert.ok(hostBuild >= 0 && hostTests > hostBuild,
      'real Host tests require dist/cli.js from the root build in a fresh checkout');
  }
});
