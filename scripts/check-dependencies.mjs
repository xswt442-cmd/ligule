import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = join(repositoryRoot, 'dependency-cruiser.cjs');
const tempRoot = join(repositoryRoot, 'testplace', 'tmp');
const analyzerRoot = realpathSync(join(repositoryRoot, 'node_modules', 'dependency-cruiser'));
const analyzerManifest = JSON.parse(readFileSync(join(analyzerRoot, 'package.json'), 'utf8'));
const expectedAnalyzerVersion = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8'))
  .devDependencies?.['dependency-cruiser'];
const analyzerEntry = typeof analyzerManifest.bin === 'string' ? analyzerManifest.bin : analyzerManifest.bin?.depcruise;
if (typeof expectedAnalyzerVersion !== 'string' || analyzerManifest.version !== expectedAnalyzerVersion
  || typeof analyzerEntry !== 'string') {
  throw new Error('dependency_cruiser_install_mismatch: install the locked workspace dev dependencies');
}
const analyzerCli = resolve(analyzerRoot, analyzerEntry);
const relativeAnalyzerCli = relative(analyzerRoot, analyzerCli);
if (relativeAnalyzerCli === '..' || relativeAnalyzerCli.startsWith(`..${sep}`) || isAbsolute(relativeAnalyzerCli)
  || !existsSync(analyzerCli)) {
  throw new Error('dependency_cruiser_cli_not_found: install the locked workspace dev dependencies');
}

function dependencyCruiser(args, cwd = repositoryRoot) {
  const result = spawnSync(process.execPath, [analyzerCli, ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function assertStatus(result, expected, label, expectedText) {
  if (result.status !== expected) {
    throw new Error(`${label}: expected exit ${expected}, got ${result.status}\n${result.output}`);
  }
  if (expectedText !== undefined && !result.output.includes(expectedText)) {
    throw new Error(`${label}: expected diagnostic ${JSON.stringify(expectedText)}\n${result.output}`);
  }
}

function assertInsideTemp(path, root) {
  const relativePath = relative(root, path);
  if (path === root || relativePath === '' || relativePath === '..'
    || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error('dependency_fixture_cleanup_outside_temp_root');
  }
}

async function writeFixture(root, path, source) {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, source, 'utf8');
}

await mkdir(tempRoot, { recursive: true });
const canonicalTestplace = await realpath(join(repositoryRoot, 'testplace'));
const canonicalTempRoot = await realpath(tempRoot);
if (canonicalTempRoot !== join(canonicalTestplace, 'tmp')) {
  throw new Error('dependency_fixture_temp_root_not_testplace_tmp');
}
const fixtureRoot = await mkdtemp(join(canonicalTempRoot, 'dependency-guard-'));
try {
  const canonicalFixtureRoot = await realpath(fixtureRoot);
  assertInsideTemp(canonicalFixtureRoot, canonicalTempRoot);

  await writeFixture(fixtureRoot, 'core/package.json', '{"name":"fixture-core","devDependencies":{"typescript":"5.9.3"}}\n');
  await writeFixture(fixtureRoot, 'core/src/entry.ts', "import '../../tui/src/entry.js';\n");
  await writeFixture(fixtureRoot, 'tui/src/entry.ts', 'export {};\n');
  const reverseDependency = dependencyCruiser([
    '--config', config,
    '--output-type', 'err',
    'core/src', 'tui/src',
  ], fixtureRoot);
  assertStatus(reverseDependency, 1, 'core_to_tui_negative_fixture', 'core-no-client-imports');

  await writeFixture(fixtureRoot, 'core/src/dev-runtime.ts', "import * as ts from 'typescript';\nexport const version = ts.version;\n");
  const developmentRuntime = dependencyCruiser([
    '--config', config,
    '--output-type', 'err',
    'core/src/dev-runtime.ts',
  ], fixtureRoot);
  assertStatus(developmentRuntime, 1, 'runtime_dev_dependency_negative_fixture', 'production-runtime-no-dev-dependencies');

  await writeFixture(fixtureRoot, 'core/src/dev-type-only.ts', "import type { ScriptTarget } from 'typescript';\nexport type Target = ScriptTarget;\n");
  const developmentTypeOnly = dependencyCruiser([
    '--config', config,
    '--output-type', 'err',
    'core/src/dev-type-only.ts',
  ], fixtureRoot);
  assertStatus(developmentTypeOnly, 0, 'type_only_dev_dependency_positive_fixture');

  await writeFixture(fixtureRoot, 'desktop/package.json', '{"name":"fixture-desktop","devDependencies":{"electron":"44.7.0","typescript":"5.9.3"}}\n');
  await writeFixture(fixtureRoot, 'node_modules/electron/package.json', '{"name":"electron","version":"44.7.0","main":"index.js"}\n');
  await writeFixture(fixtureRoot, 'node_modules/electron/index.js', 'export const app = { isReady: () => true };\n');
  await writeFixture(fixtureRoot, 'desktop/electron/main.ts', "import { app } from 'electron';\nexport const ready = app.isReady();\n");
  const electronHostApi = dependencyCruiser([
    '--config', config,
    '--output-type', 'err',
    'desktop/electron/main.ts',
  ], fixtureRoot);
  assertStatus(electronHostApi, 0, 'electron_host_runtime_provider_positive_fixture');

  await writeFixture(fixtureRoot, 'desktop/electron/dev-runtime.ts', "import * as ts from 'typescript';\nexport const version = ts.version;\n");
  const desktopDevelopmentRuntime = dependencyCruiser([
    '--config', config,
    '--output-type', 'err',
    'desktop/electron',
  ], fixtureRoot);
  assertStatus(desktopDevelopmentRuntime, 1, 'desktop_runtime_dev_dependency_negative_fixture', 'desktop-main-no-runtime-dev-dependencies');

  await writeFixture(fixtureRoot, 'desktop/frontend/package.json', '{"name":"fixture-frontend","devDependencies":{"vite":"8.3.2"}}\n');
  await writeFixture(fixtureRoot, 'node_modules/vite/package.json', '{"name":"vite","version":"8.3.2","main":"index.js"}\n');
  await writeFixture(fixtureRoot, 'node_modules/vite/index.js', 'export const defineConfig = config => config;\n');
  await writeFixture(fixtureRoot, 'node_modules/vite/client.d.ts', 'export {};\n');
  await writeFixture(fixtureRoot, 'desktop/frontend/src/global.d.ts', '/// <reference types="vite/client" />\n');
  const rendererTypeReference = dependencyCruiser([
    '--config', config,
    '--output-type', 'err',
    'desktop/frontend/src/global.d.ts',
  ], fixtureRoot);
  assertStatus(rendererTypeReference, 0, 'desktop_renderer_dev_type_reference_positive_fixture');

  await writeFixture(fixtureRoot, 'desktop/frontend/src/dev-runtime.ts', "import { defineConfig } from 'vite';\nexport const config = defineConfig({});\n");
  const rendererDevelopmentRuntime = dependencyCruiser([
    '--config', config,
    '--output-type', 'err',
    'desktop/frontend/src',
  ], fixtureRoot);
  assertStatus(rendererDevelopmentRuntime, 1, 'desktop_renderer_dev_dependency_negative_fixture', 'desktop-renderer-no-runtime-dev-dependencies');

  await writeFixture(fixtureRoot, 'runtime-cycle/left.ts', "import './right.js';\nexport const left = true;\n");
  await writeFixture(fixtureRoot, 'runtime-cycle/right.ts', "import './left.js';\nexport const right = true;\n");
  const runtimeCycle = dependencyCruiser([
    '--config', config,
    '--output-type', 'err',
    'runtime-cycle',
  ], fixtureRoot);
  assertStatus(runtimeCycle, 1, 'runtime_cycle_negative_fixture', 'no-runtime-cycles');

  await writeFixture(fixtureRoot, 'type-cycle/left.ts', "import type { Right } from './right.js';\nexport interface Left { right: Right }\n");
  await writeFixture(fixtureRoot, 'type-cycle/right.ts', "import type { Left } from './left.js';\nexport interface Right { left: Left }\n");
  const typeCycle = dependencyCruiser([
    '--config', config,
    '--output-type', 'err',
    'type-cycle',
  ], fixtureRoot);
  assertStatus(typeCycle, 0, 'type_only_cycle_positive_fixture');

  process.stdout.write('dependency guard fixtures passed: Core → TUI, Core/TUI/Desktop runtime npm-dev, and runtime cycles rejected; Electron host API, type-only npm-dev imports/references and type-only cycles allowed\n');
} finally {
  const currentTempRoot = await realpath(tempRoot);
  const currentFixtureRoot = await realpath(fixtureRoot);
  if (currentTempRoot !== canonicalTempRoot) throw new Error('dependency_fixture_temp_root_changed');
  assertInsideTemp(currentFixtureRoot, currentTempRoot);
  await rm(currentFixtureRoot, { recursive: true, force: true });
}

const normal = dependencyCruiser([
  '--config', config,
  '--output-type', 'err',
  'core/src', 'tui/src', 'desktop/electron', 'desktop/frontend/src',
]);
assertStatus(normal, 0, 'normal_source_scan');
process.stdout.write(normal.output);
