import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, readdirSync } from 'node:fs';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

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

// dependency-cruiser 无法解析 workspace 的 `@ligule/core/tui.js`（exports + 符号链接），
// 这条边会以 unknown/couldNotResolve 出现，npm-dev 规则看不到它。这里用 TypeScript AST
// 直接检查 renderer 源码：import/export/动态导入只要是运行时绑定，或指向 core/src、core/dist，
// 都算违规；非静态的动态导入无法证明不是 Core，直接拒绝。
function importIsTypeOnly(node) {
  const clause = node.importClause;
  if (clause === undefined) return false; // 副作用导入是运行时依赖
  if (clause.isTypeOnly) return true;
  if (clause.name !== undefined) return false; // default 绑定是值
  const bindings = clause.namedBindings;
  if (bindings === undefined) return false;
  if (ts.isNamespaceImport(bindings)) return false;
  return bindings.elements.length > 0 && bindings.elements.every(element => element.isTypeOnly);
}

function exportIsTypeOnly(node) {
  if (node.isTypeOnly) return true;
  const clause = node.exportClause;
  if (clause === undefined) return false; // export * 是运行时依赖
  if (ts.isNamespaceExport(clause)) return false;
  return clause.elements.length > 0 && clause.elements.every(element => element.isTypeOnly);
}

function staticModuleText(node) {
  if (node === undefined) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

function scanRendererCoreRuntimeImports(root) {
  const sourceRoot = join(root, 'desktop', 'frontend', 'src');
  if (!existsSync(sourceRoot)) return [];
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(?:ts|tsx|mts|cts)$/.test(entry.name)) files.push(path);
    }
  };
  walk(sourceRoot);
  const isCoreSpecifier = (path, specifier) => {
    if (!specifier.startsWith('.')) return /^@ligule\/core(?:\/|$)/.test(specifier);
    const target = resolve(dirname(path), specifier);
    const normalized = target.split(sep).join('/');
    return /\/core\/(?:src|dist)(?:\/|$)/.test(normalized);
  };
  const violations = [];
  for (const path of files) {
    const text = readFileSync(path, 'utf8');
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true,
      path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (node) => {
      if (ts.isImportDeclaration(node)) {
        const specifier = staticModuleText(node.moduleSpecifier);
        if (specifier !== null && specifier !== undefined && isCoreSpecifier(path, specifier) && !importIsTypeOnly(node)) {
          violations.push(`${path}: ${specifier}`);
        }
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
        const specifier = staticModuleText(node.moduleSpecifier);
        if (specifier !== null && specifier !== undefined && isCoreSpecifier(path, specifier) && !exportIsTypeOnly(node)) {
          violations.push(`${path}: ${specifier}`);
        }
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const specifier = staticModuleText(node.arguments[0]);
        if (specifier === null) violations.push(`${path}: computed dynamic import`);
        else if (specifier !== undefined && isCoreSpecifier(path, specifier)) violations.push(`${path}: ${specifier} (dynamic)`);
      } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        const specifier = staticModuleText(node.arguments[0]);
        if (specifier === null) violations.push(`${path}: computed require`);
        else if (specifier !== undefined && isCoreSpecifier(path, specifier)) violations.push(`${path}: ${specifier} (require)`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return violations;
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

  await writeFixture(fixtureRoot, 'core/src/session/session.ts', 'export const createSessionLog = (): void => {};\n');
  await writeFixture(fixtureRoot, 'tui/src/deep.ts', "import { createSessionLog } from '../../core/src/session/session.js';\nexport const read = createSessionLog;\n");
  const clientDeepImport = dependencyCruiser([
    '--config', config,
    '--output-type', 'err',
    'tui/src/deep.ts',
  ], fixtureRoot);
  assertStatus(clientDeepImport, 1, 'client_deep_core_import_negative_fixture', 'clients-use-core-entry');

  await writeFixture(fixtureRoot, 'node_modules/@ligule/core/package.json', '{"name":"@ligule/core","version":"0.0.0","type":"module","exports":{".":"./index.js"}}\n');
  await writeFixture(fixtureRoot, 'node_modules/@ligule/core/index.js', 'export const createSessionLog = () => {};\n');
  await writeFixture(fixtureRoot, 'tui/src/public.ts', "import { createSessionLog } from '@ligule/core';\nexport const read = createSessionLog;\n");
  const clientPublicImport = dependencyCruiser([
    '--config', config,
    '--output-type', 'err',
    'tui/src/public.ts',
  ], fixtureRoot);
  assertStatus(clientPublicImport, 0, 'client_public_core_entry_positive_fixture');

  await writeFixture(fixtureRoot, 'core/src/host/host.ts', 'export const createHost = (): void => {};\n');
  await writeFixture(fixtureRoot, 'core/src/session/leak.ts', "import { createHost } from '../host/host.js';\nexport const build = createHost;\n");
  const sessionIntoHost = dependencyCruiser([
    '--config', config,
    '--output-type', 'err',
    'core/src/session/leak.ts',
  ], fixtureRoot);
  assertStatus(sessionIntoHost, 1, 'core_internal_host_import_negative_fixture', 'core-entry-owns-host');

  await writeFixture(fixtureRoot, 'core/src/index.ts', "import { createHost } from './host/host.js';\nexport const host = createHost;\n");
  const entryIntoHost = dependencyCruiser([
    '--config', config,
    '--output-type', 'err',
    'core/src/index.ts',
  ], fixtureRoot);
  assertStatus(entryIntoHost, 0, 'core_entry_host_import_positive_fixture');

  await writeFixture(fixtureRoot, 'core/src/kernel/leak.ts', "import { host } from '../index.js';\nexport const leaked = host;\n");
  const domainIntoEntry = dependencyCruiser([
    '--config', config,
    '--output-type', 'err',
    'core/src/kernel/leak.ts',
  ], fixtureRoot);
  assertStatus(domainIntoEntry, 1, 'core_domain_entry_import_negative_fixture', 'core-domains-avoid-entry-imports');

  await writeFixture(fixtureRoot, 'core/src/capability/component.ts', 'export const capability = (): void => {};\n');
  await writeFixture(fixtureRoot, 'core/src/wire.ts', "import { capability } from './capability/component.js';\nexport type Wired = typeof capability;\n");
  const wireIntoAssembly = dependencyCruiser([
    '--config', config,
    '--output-type', 'err',
    'core/src/wire.ts',
  ], fixtureRoot);
  assertStatus(wireIntoAssembly, 1, 'wire_product_assembly_negative_fixture', 'wire-entry-avoids-product-assembly');

  await writeFixture(fixtureRoot, 'core/src/wire.ts', "import type { capability } from './capability/component.js';\nexport type Wired = typeof capability;\n");
  const wireTypesOnly = dependencyCruiser([
    '--config', config,
    '--output-type', 'err',
    'core/src/wire.ts',
  ], fixtureRoot);
  assertStatus(wireTypesOnly, 1, 'wire_type_import_negative_fixture', 'wire-entry-avoids-product-assembly');

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

  // Renderer 只允许从 Core 取类型。dependency-cruiser 解析不了 workspace 的 Core 入口，
  // 因此这里用 TypeScript AST 验证：值导入、混合 type/value、副作用导入、动态导入、
  // 相对 core/src 与 core/dist 都必须被判违规；纯类型形式必须通过。
  await writeFixture(fixtureRoot, 'desktop/frontend/src/core-runtime.ts', "import { createHost } from '@ligule/core/tui.js';\nexport const host = createHost;\n");
  await writeFixture(fixtureRoot, 'desktop/frontend/src/core-deep.ts', "export { createHost } from '../../../core/src/host/host.js';\n");
  await writeFixture(fixtureRoot, 'desktop/frontend/src/core-mixed.ts', [
    "import { type SessionSummary, createHost } from '@ligule/core/tui.js';",
    "export { type Host as HostType, createHost as buildHost } from '../../../core/src/host/host.js';",
    '',
  ].join('\n'));
  await writeFixture(fixtureRoot, 'desktop/frontend/src/core-side-effect.ts', "import '@ligule/core/tui.js';\n");
  await writeFixture(fixtureRoot, 'desktop/frontend/src/core-dynamic.ts', [
    "void import('@ligule/core/tui.js');",
    "const name = '@ligule/core/tui.js';",
    'void import(name);',
    '',
  ].join('\n'));
  const fixtureRuntime = scanRendererCoreRuntimeImports(fixtureRoot);
  if (fixtureRuntime.length !== 7) {
    throw new Error(`renderer_core_runtime_fixture: expected 7 violations, got ${JSON.stringify(fixtureRuntime)}`);
  }
  await writeFixture(fixtureRoot, 'desktop/frontend/src/core-runtime.ts', "import type { SessionSummary } from '@ligule/core/tui.js';\nexport type Summary = SessionSummary;\n");
  await writeFixture(fixtureRoot, 'desktop/frontend/src/core-deep.ts', "import type { Host } from '../../../core/src/host/host.js';\nexport type H = Host;\n");
  await writeFixture(fixtureRoot, 'desktop/frontend/src/core-mixed.ts', [
    "import { type SessionSummary } from '@ligule/core/tui.js';",
    "export { type Host as HostType } from '../../../core/src/host/host.js';",
    "export type Dynamic = import('@ligule/core/tui.js').SessionSummary;",
    '',
  ].join('\n'));
  await writeFixture(fixtureRoot, 'desktop/frontend/src/core-side-effect.ts', "export type { SessionSummary } from '@ligule/core/tui.js';\n");
  await writeFixture(fixtureRoot, 'desktop/frontend/src/core-dynamic.ts', "export type Dynamic = import('@ligule/core/tui.js').SessionSummary;\n");
  const fixtureTypeOnly = scanRendererCoreRuntimeImports(fixtureRoot);
  if (fixtureTypeOnly.length !== 0) {
    throw new Error(`renderer_core_type_only_fixture: expected 0 violations, got ${JSON.stringify(fixtureTypeOnly)}`);
  }

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

  await writeFixture(fixtureRoot, 'core/src/type-cycle/left.ts', "import type { Right } from './right.js';\nexport interface Left { right: Right }\n");
  await writeFixture(fixtureRoot, 'core/src/type-cycle/right.ts', "import type { Left } from './left.js';\nexport interface Right { left: Left }\n");
  const coreTypeCycle = dependencyCruiser([
    '--config', config,
    '--output-type', 'err',
    'core/src/type-cycle',
  ], fixtureRoot);
  assertStatus(coreTypeCycle, 1, 'core_type_cycle_negative_fixture', 'core-no-cycles');

  await writeFixture(fixtureRoot, 'core/src/kernel/capability-fixture.ts', "export const fixture = 1;\nexport type Fixture = number;\n");
  await writeFixture(fixtureRoot, 'core/src/capability/kernel-runtime.ts', "export { fixture } from '../kernel/capability-fixture.js';\n");
  await writeFixture(fixtureRoot, 'core/src/capability/kernel-type.ts', "export type { Fixture } from '../kernel/capability-fixture.js';\n");
  const capabilityRuntime = dependencyCruiser([
    '--config', config, '--output-type', 'err', 'core/src/capability/kernel-runtime.ts',
  ], fixtureRoot);
  assertStatus(capabilityRuntime, 1, 'capability_kernel_runtime_negative_fixture', 'capability-no-kernel-or-session-runtime-imports');
  const capabilityType = dependencyCruiser([
    '--config', config, '--output-type', 'err', 'core/src/capability/kernel-type.ts',
  ], fixtureRoot);
  assertStatus(capabilityType, 0, 'capability_kernel_type_positive_fixture');
  await writeFixture(fixtureRoot, 'core/src/session/capability-fixture.ts', "export const fixture = 1;\n");
  await writeFixture(fixtureRoot, 'core/src/capability/session-runtime.ts', "export { fixture } from '../session/capability-fixture.js';\n");
  const sessionRuntime = dependencyCruiser([
    '--config', config, '--output-type', 'err', 'core/src/capability/session-runtime.ts',
  ], fixtureRoot);
  assertStatus(sessionRuntime, 1, 'capability_session_runtime_negative_fixture', 'capability-no-kernel-or-session-runtime-imports');

  process.stdout.write('dependency guard fixtures passed: Core -> TUI, Core/TUI/Desktop runtime npm-dev, renderer runtime Core imports via TypeScript AST (value, mixed, side-effect, dynamic, computed, relative core/src and core/dist), client deep core imports, internal host imports, domain imports of an assembly entry, wire imports of product assembly, runtime cycles and Core type cycles rejected; Electron host API, Core entry -> host, the @ligule/core entry, renderer type-only imports of @ligule/core, type-only npm-dev imports/references and non-Core type cycles allowed\n');
} finally {
  const currentTempRoot = await realpath(tempRoot);
  const currentFixtureRoot = await realpath(fixtureRoot);
  if (currentTempRoot !== canonicalTempRoot) throw new Error('dependency_fixture_temp_root_changed');
  assertInsideTemp(currentFixtureRoot, currentTempRoot);
  await rm(currentFixtureRoot, { recursive: true, force: true });
}

const repositoryCoreRuntimeImports = scanRendererCoreRuntimeImports(repositoryRoot);
if (repositoryCoreRuntimeImports.length > 0) {
  throw new Error(`renderer_runtime_core_import: ${repositoryCoreRuntimeImports.join('; ')}`);
}

const normal = dependencyCruiser([
  '--config', config,
  '--output-type', 'err',
  'core/src', 'tui/src', 'desktop/electron', 'desktop/frontend/src',
]);
assertStatus(normal, 0, 'normal_source_scan');
process.stdout.write(normal.output);
