// 用随包的 Node 检查桌面运行树中的命令行、原生模块与搜索后端。
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertNoForeignNativeDirectories, assertSymlinksInside } from '../scripts/runtime-tree.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktopRoot = join(root, 'desktop');
const options = parseOptions(process.argv.slice(2));
const runtimeRoot = options.resources ?? options.vendor ?? join(desktopRoot, 'vendor');
const target = `${process.platform}-${process.arch}`;
const nodePin = JSON.parse(await readFile(join(root, 'desktop', 'node-pin.json'), 'utf8'));
const packageJson = JSON.parse(await readFile(join(desktopRoot, 'package.json'), 'utf8'));
packageJson.dependencies['@ligule/core'] = '*';
const nodePath = join(runtimeRoot, 'node', process.platform === 'win32' ? 'node.exe' : 'node');
const app = join(runtimeRoot, 'app');
const appModules = join(app, 'node_modules');
await assertSymlinksInside(app);
await assertNoForeignNativeDirectories(appModules, target);
const providerPackage = `@vscode/ripgrep-${target}`;
delete process.env.NODE_PATH;
delete process.env.NODE_OPTIONS;
delete process.env.NAPI_RS_NATIVE_LIBRARY_PATH;
process.env.PATH = '';

if (nodePin.version !== process.version) {
  throw new Error(`the checker must run with Node ${nodePin.version}; received ${process.version}`);
}
const [checkerNode, runtimeNode] = await Promise.all([realpath(process.execPath), realpath(nodePath)]);
if (checkerNode !== runtimeNode) {
  throw new Error(`run this checker with the selected standalone Node runtime: ${nodePath}`);
}
const vendoredPackage = JSON.parse(await readFile(join(app, 'package.json'), 'utf8'));
if (vendoredPackage.name !== packageJson.name || vendoredPackage.version !== packageJson.version
  || vendoredPackage.packageManager !== undefined
  || vendoredPackage.devDependencies !== undefined
  || vendoredPackage.scripts !== undefined
  || JSON.stringify(vendoredPackage.dependencies) !== JSON.stringify(packageJson.dependencies)
  || JSON.stringify(vendoredPackage.optionalDependencies) !== JSON.stringify(packageJson.optionalDependencies)) {
  throw new Error('the vendored app package manifest does not match the generated release manifest');
}

const coreRoot = join(app, 'node_modules', '@ligule', 'core');
const hostEntry = join(coreRoot, 'dist', 'host', 'desktop-entry.js');
const shippedMode = join(coreRoot, 'modes', 'minimal.toml');
if (!existsSync(hostEntry) || !existsSync(shippedMode)) throw new Error('the Desktop runtime is missing its Core Host entry or shipped modes');
const library = await import(pathToFileURL(join(coreRoot, 'dist', 'index.js')).href);
const requireFromApp = createRequire(join(app, 'package.json'));
const insideAppModules = async (name, resolver = requireFromApp) => {
  const modulePath = await realpath(resolver.resolve(name));
  const relativeModule = relative(appModules, modulePath);
  if (relativeModule === '..' || relativeModule.startsWith(`..${sep}`) || isAbsolute(relativeModule)) {
    throw new Error(`${name} resolved outside the vendored runtime tree: ${modulePath}`);
  }
};
for (const name of ['tree-sitter', 'tree-sitter-bash', 'tree-sitter-pwsh', '@napi-rs/keyring', '@vscode/ripgrep']) {
  await insideAppModules(name);
}
const bash = await library.parseCommand('git status', 'bash');
const powershell = await library.parseCommand('Get-ChildItem', 'powershell');
if (bash.kind !== 'segments' || powershell.kind !== 'segments') {
  throw new Error(`tree-sitter grammars failed: bash=${bash.kind}, powershell=${powershell.kind}`);
}
const keyringBindings = {
  'win32-x64': '@napi-rs/keyring-win32-x64-msvc',
  'linux-x64': '@napi-rs/keyring-linux-x64-gnu',
  'darwin-arm64': '@napi-rs/keyring-darwin-arm64',
  'darwin-x64': '@napi-rs/keyring-darwin-x64',
};
const keyringBinding = keyringBindings[target];
if (keyringBinding === undefined) throw new Error(`no keyring binding is listed for ${target}`);
const keyringRequire = createRequire(requireFromApp.resolve('@napi-rs/keyring'));
await insideAppModules(keyringBinding, keyringRequire);
const keyring = keyringRequire('@napi-rs/keyring');
if (typeof keyring.AsyncEntry !== 'function') throw new Error('the vendored keyring native module did not load');

const backend = await library.resolveRipgrep({});
if (typeof backend?.executable !== 'string' || !isAbsolute(backend.executable)) {
  throw new Error(`the vendored search backend is unavailable: ${JSON.stringify(backend)}`);
}
const backendPath = await realpath(backend.executable);
const ripgrepRequire = createRequire(requireFromApp.resolve('@vscode/ripgrep'));
const provider = await import(pathToFileURL(ripgrepRequire.resolve('@vscode/ripgrep')).href);
if (await realpath(provider.rgPath) !== backendPath) throw new Error('@vscode/ripgrep and the Ligule host resolved different search binaries');
const expectedPackage = await realpath(dirname(ripgrepRequire.resolve(`${providerPackage}/package.json`)));
const relativeBackend = relative(expectedPackage, backendPath);
if (relativeBackend === '..' || relativeBackend.startsWith(`..${sep}`) || isAbsolute(relativeBackend)) {
  throw new Error(`the search backend is outside ${expectedPackage}: ${backendPath}`);
}

const testplaceTmp = join(desktopRoot, 'testplace', 'tmp');
await mkdir(testplaceTmp, { recursive: true });
const temporary = await mkdtemp(join(testplaceTmp, 'runtime-check-'));
assertInsideTestplace(temporary, testplaceTmp);
try {
  await writeFile(join(temporary, 'needle.txt'), 'LIGULE-DESKTOP-RUNTIME-CHECK\n', 'utf8');
  const result = await library.searchWithRipgrep({
    executable: backendPath,
    boundary: temporary,
    target: '.',
    pattern: 'LIGULE-DESKTOP-RUNTIME-CHECK',
    limit: 5,
  });
  if (!result.hits.some((hit) => hit.includes('needle.txt') && hit.includes('LIGULE-DESKTOP-RUNTIME-CHECK'))) {
    throw new Error(`the vendored search backend did not find its temporary file: ${JSON.stringify(result)}`);
  }
} finally {
  assertInsideTestplace(temporary, testplaceTmp);
  await rm(temporary, { recursive: true, force: true });
}

console.log(`runtime check passed: Node ${process.version}; @ligule/core Host; modes; bash and PowerShell grammars; keyring; ${providerPackage} search; ${options.resources === undefined ? 'vendor' : 'resources'}=${runtimeRoot}`);

function parseOptions(args) {
  const parsed = { resources: undefined, vendor: undefined };
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option !== '--resources' && option !== '--vendor') {
      throw new Error(`unknown runtime checker argument: ${option}`);
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${option} requires a directory path`);
    }
    if (parsed[option.slice(2)] !== undefined) {
      throw new Error(`${option} may be provided only once`);
    }
    parsed[option.slice(2)] = resolve(value);
    index += 1;
  }
  if (parsed.resources !== undefined && parsed.vendor !== undefined) {
    throw new Error('use either --resources or --vendor, not both');
  }
  return parsed;
}

function assertInsideTestplace(path, directory) {
  const relativePath = relative(resolve(directory), resolve(path));
  if (relativePath === '' || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`temporary runtime check path must be inside desktop/testplace/tmp: ${path}`);
  }
}
