import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

async function writeJson(path, value) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function fixture() {
  const parent = join(process.cwd(), 'testplace', 'tmp');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'release-automation-'));
  const version = '0.0.1';
  const packageManifest = { name: 'ligule', version, dependencies: { '@vscode/ripgrep': '1.18.0' }, optionalDependencies: {} };
  await writeJson(join(directory, 'package.json'), packageManifest);
  await writeJson(join(directory, 'desktop', 'package.json'), { name: 'ligule-desktop', version });
  await writeJson(join(directory, 'desktop', 'frontend', 'package.json'), { name: 'ligule-desktop-frontend', version });
  const lock = "lockfileVersion: '9.0'\n\nimporters:\n  .: {}\n  desktop: {}\n  desktop/frontend: {}\n";
  await writeFile(join(directory, 'pnpm-lock.yaml'), lock, 'utf8');
  await mkdir(join(directory, 'src'), { recursive: true });
  await writeFile(join(directory, 'src', 'version.ts'), `// Keep this comment.\nexport const VERSION = '${version}';\n`, 'utf8');
  await mkdir(join(directory, 'docs', 'development'), { recursive: true });
  for (const path of ['RELEASE.zh-cn.md', 'RELEASE.en.md']) {
    await writeFile(join(directory, 'docs', 'development', path), `| \`ligule\` | package | \`${version}\` |\n`, 'utf8');
  }
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

test('release preparation updates workspace manifests and runtime version without rewriting the shared lock', async () => {
  const directory = await fixture();
  try {
    const result = prepareRelease(directory, 'patch');
    assert.equal(result.version, '0.0.2');
    const paths = result.files.map((path) => path.replaceAll('\\', '/'));
    assert.ok(!paths.some((path) => path.endsWith('package-lock.json')));
    assert.ok(!paths.includes('pnpm-lock.yaml'));
    for (const path of ['desktop/package.json', 'desktop/frontend/package.json']) {
      const manifest = JSON.parse(await readFile(join(directory, path), 'utf8'));
      assert.equal(manifest.version, '0.0.2', path);
    }
    assert.equal(await readFile(join(directory, 'pnpm-lock.yaml'), 'utf8'), "lockfileVersion: '9.0'\n\nimporters:\n  .: {}\n  desktop: {}\n  desktop/frontend: {}\n");
    for (const path of ['RELEASE.zh-cn.md', 'RELEASE.en.md']) {
      assert.match(await readFile(join(directory, 'docs/development', path), 'utf8'), /\| `ligule` \| package \| `0\.0\.2` \|/);
    }
    assert.match(await readFile(join(directory, 'src/version.ts'), 'utf8'), /Keep this comment/);
    assert.match(await readFile(join(directory, 'src/version.ts'), 'utf8'), /VERSION = '0\.0\.2'/);
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
  const ciWorkflow = workflow('ci');
  const tagInputs = tagWorkflow.on.workflow_dispatch.inputs;

  assert.deepEqual(tagInputs.action.options, ['prepare', 'tag']);
  assert.deepEqual(Object.keys(tagInputs).sort(), ['action', 'version']);
  const prepareCommands = tagWorkflow.jobs.prepare.steps.map((step) => step.run ?? '').join('\n');
  const tagCommands = tagWorkflow.jobs['create-tag'].steps.map((step) => step.run ?? '').join('\n');
  assert.match(prepareCommands, /gh pr create --base main/);
  assert.match(prepareCommands, /Updates the main package, desktop manifests, and bilingual release checklist/);
  assert.match(prepareCommands, /installs or extracts each desktop artifact and runs the bundled search-backend check/);
  assert.match(prepareCommands, /Verify first launch, tray, and notifications on each desktop platform before publishing/);
  assert.doesNotMatch(prepareCommands, /platform package versions/);
  assert.match(prepareCommands, /git add[^\n]*docs\/development\/RELEASE\.zh-cn\.md[^\n]*docs\/development\/RELEASE\.en\.md/);
  assert.doesNotMatch(prepareCommands, /npm test|npm run check-pack/);
  const tagGate = tagWorkflow.jobs['create-tag'].steps.find((step) => step.name === 'require the default branch');
  assert.match(tagGate.run, /test "\$GITHUB_REF" = refs\/heads\/main/);
  assert.doesNotMatch(tagCommands, /WINDOWS_X64|LINUX_X64|MACOS_ARM64|MACOS_X64|all four platform validations/);
  assert.match(tagCommands, /gh run list --workflow ci\.yml --branch main --event push --commit/);
  assert.doesNotMatch(tagCommands, /gh workflow run ci\.yml/);
  assert.match(tagCommands, /main_head.*COMMIT/s);
  assert.match(tagCommands, /git push origin "v\$\{VERSION\}"/);
  assert.ok(publishWorkflow.on.workflow_dispatch, 'npm publishing must be manually dispatched');
  assert.equal(publishWorkflow.on.push, undefined, 'a tag push must not publish npm packages');
  assert.equal(publishWorkflow.jobs.approval.environment, 'npm-publish');
  assert.equal(publishWorkflow.jobs.platforms, undefined, 'platform binaries are supplied by @vscode/ripgrep');
  assert.ok(publishWorkflow.jobs.verify.steps.some((step) => step.run === 'npm run build'),
    'the tarball verifier needs the tagged host entry points in its clean checkout');
  const syntaxCheck = publishWorkflow.jobs.checks.steps.find((step) => step.name === 'syntax check compiled modules and checks');
  assert.match(syntaxCheck.run, /find dist -type f -name '\*\.js'/,
    'release checks must syntax-check the emitted JavaScript after the TypeScript build');
  assert.doesNotMatch(syntaxCheck.run, /src\/\*\.js/,
    'release checks must not require TypeScript source to have JavaScript filenames');
  assert.ok(publishWorkflow.jobs.npm.needs.includes('approval'), 'the main package must wait for approval');
  const publishJob = publishWorkflow.jobs.npm;
  const tarballIdentity = publishJob.steps.find((step) => step.name === 'verify tarball identity');
  assert.match(tarballIdentity.run, /echo "path=\.\/\$file"/,
    'npm must receive the tarball as a relative file path, not a GitHub shorthand');
  assert.match(publishJob.steps.find((step) => step.name === 'publish with trusted publishing').run,
    /npm publish .*\$\{\{ steps\.tarball\.outputs\.path \}\}/);
  assert.equal(publishJob.permissions['id-token'], 'write', 'the publish job must authenticate with npm through OIDC');
  assert.equal(publishJob.env, undefined, 'the publish job must not receive a long-lived npm token');
  const setupNode = publishJob.steps.find((step) => step.uses?.startsWith('actions/setup-node@'));
  assert.equal(setupNode.with['node-version'], '${{ env.PRIMARY_NODE_VERSION }}');
  assert.equal(setupNode.with['registry-url'], 'https://registry.npmjs.org');
  assert.ok(publishJob.steps.some((step) => step.run?.includes('npm install --global npm@11.5.1')),
    'the publish job must install the minimum npm version required for trusted publishing');
  assert.doesNotMatch(JSON.stringify(publishJob), /NPM_TOKEN|NODE_AUTH_TOKEN/,
    'the publish job must not use npm token authentication');
  assert.ok(publishWorkflow.jobs['release-notes'].needs.includes('npm'));
  assert.equal(publishWorkflow.jobs['release-notes'].uses, './.github/workflows/release.yml');
  assert.ok(releaseWorkflow.on.workflow_call, 'publish.yml must be able to call the release workflow');
  assert.ok(releaseWorkflow.on.workflow_dispatch, 'draft recovery must be manually available');
  const releaseCommands = releaseWorkflow.jobs.draft.steps.map((step) => step.run ?? '').join('\n');
  assert.match(releaseCommands, /--notes-file/);
  assert.match(releaseCommands, /preserving its title, body, and assets/);
  assert.doesNotMatch(releaseCommands, /gh release edit/);
  assert.doesNotMatch(releaseCommands, /--generate-notes/);

  const ciText = JSON.stringify(ciWorkflow);
  assert.doesNotMatch(ciText, /build-rg|local-search/, 'CI must use the upstream dependency for clean installs');
  assert.doesNotMatch(ciText, /src-tauri|cargo|rust-toolchain|rust-cache/i, 'desktop CI must use the Electron build pipeline');
  assert.deepEqual(ciWorkflow.on.push.branches, ['main', 'dev'], 'feature branch checks should run from the pull request event only');
  assert.ok(Object.hasOwn(ciWorkflow.on, 'pull_request'), 'pull requests must keep the full cross-platform CI matrix');
  const desktopPackage = JSON.parse(readFileSync(new URL('../desktop/package.json', import.meta.url), 'utf8'));
  assert.equal(desktopPackage.scripts.build, 'node ./build.mjs', 'desktop builds must use the repository packaging entry');
  assert.ok(ciWorkflow.jobs['cli-package'].steps.some((step) => step.run === 'pnpm --filter ligule run check-pack'));
  assert.ok(ciWorkflow.jobs['cli-package'].steps.some((step) => step.run === 'pnpm --filter ligule run verify-install'));
  const desktopJob = ciWorkflow.jobs.desktop;
  assert.deepEqual(desktopJob.strategy.matrix.include.map(({ id }) => id), [
    'windows-x64', 'linux-x64', 'macos-arm64', 'macos-x64',
  ]);
  assert.deepEqual(desktopJob.strategy.matrix.include.map(({ build }) => build), [
    'build:win', 'build:linux', 'build:mac', 'build:mac',
  ], 'each desktop matrix entry must select its platform build script');
  const desktopSteps = desktopJob.steps;
  const runtimeCheckIndex = desktopSteps.findIndex((step) => step.run?.includes('desktop/check-runtime.mjs --vendor desktop/vendor'));
  const installerBuildIndex = desktopSteps.findIndex((step) => step.run?.includes('pnpm --filter ligule-desktop run ${{ matrix.build }}'));
  assert.ok(installerBuildIndex >= 0 && !desktopSteps[installerBuildIndex].run.includes('--verbose'),
    'installer builds must invoke the matrix-selected platform script without unsupported flags');
  assert.ok(runtimeCheckIndex >= 0 && runtimeCheckIndex < installerBuildIndex,
    'each native desktop target must execute its bundled runtime check before building an installer');
  assert.ok(desktopSteps.some((step) => step.run?.includes('desktop/electron/test/host.test.ts')
    && step.run.includes('desktop/electron/test/security.test.ts')));
  assert.ok(desktopSteps.some((step) => step.run?.includes('pnpm --filter ligule-desktop-frontend run check')
    && step.run.includes('pnpm --filter ligule-desktop-frontend run build')));
  const windowsProcessTree = desktopSteps.find((step) => step.if === "runner.os == 'Windows'"
    && step.run?.includes('desktop/electron/test/process-tree.test.ts'));
  const posixProcessTree = desktopSteps.find((step) => step.if === "runner.os != 'Windows'"
    && step.run?.includes('desktop/electron/test/posix-process-tree.test.ts'));
  assert.ok(windowsProcessTree && posixProcessTree, 'each platform family must test its Host process cleanup');
  const windowsBundleCheck = desktopSteps.find((step) => step.if === "runner.os == 'Windows'"
    && step.run?.includes('run-installer-smoke.ps1'));
  const linuxBundleCheck = desktopSteps.find((step) => step.if === "runner.os == 'Linux'"
    && step.run?.includes('dpkg-deb --extract') && step.run.includes('desktop/check-runtime.mjs --resources'));
  const macBundleCheck = desktopSteps.find((step) => step.if === "runner.os == 'macOS'"
    && step.run?.includes('hdiutil verify') && step.run.includes('desktop/check-runtime.mjs --resources'));
  assert.ok(windowsBundleCheck && linuxBundleCheck && macBundleCheck,
    'every desktop OS must inspect its actual installer after bundling');
  assert.match(windowsBundleCheck.run, /run-installer-smoke\.ps1/);
  assert.match(linuxBundleCheck.run, /desktop\/check-runtime\.mjs/);
  assert.match(macBundleCheck.run, /desktop\/check-runtime\.mjs/);
  assert.ok(desktopSteps.indexOf(windowsBundleCheck) > installerBuildIndex);
  assert.ok(desktopSteps.indexOf(linuxBundleCheck) > installerBuildIndex);
  assert.ok(desktopSteps.indexOf(macBundleCheck) > installerBuildIndex);
  assert.match(ciText, /ligule-desktop-v\$\{\{ steps\.desktop-version\.outputs\.value \}\}-\$\{\{ matrix\.id \}\}-\$\{\{ github\.sha \}\}/);
});
