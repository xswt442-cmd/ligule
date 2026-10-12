// 用随包的 Node 检查桌面运行树中的命令行、原生模块与搜索后端。
import { createRequire } from 'node:module';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { releaseManifest } from '../scripts/pack-release.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vendor = join(root, 'desktop', 'vendor');
const target = `${process.platform}-${process.arch}`;
const nodePin = JSON.parse(await readFile(join(root, 'desktop', 'node-pin.json'), 'utf8'));
const packageJson = releaseManifest();
const nodePath = resolve(process.env.LIGULE_RUNTIME_NODE_PATH ?? join(vendor, 'node', process.platform === 'win32' ? 'node.exe' : 'node'));
const app = resolve(process.env.LIGULE_RUNTIME_APP_DIR ?? join(vendor, 'app'));
const appModules = join(app, 'node_modules');
const providerPackage = `@vscode/ripgrep-${target}`;
delete process.env.NODE_PATH;
delete process.env.NODE_OPTIONS;
delete process.env.NAPI_RS_NATIVE_LIBRARY_PATH;
process.env.PATH = '';

if (nodePin.version !== process.version) {
  throw new Error(`the checker must run with Node ${nodePin.version}; received ${process.version}`);
}
const vendoredPackage = JSON.parse(await readFile(join(app, 'package.json'), 'utf8'));
if (vendoredPackage.name !== packageJson.name || vendoredPackage.version !== packageJson.version
  || JSON.stringify(vendoredPackage.dependencies) !== JSON.stringify(packageJson.dependencies)
  || JSON.stringify(vendoredPackage.optionalDependencies) !== JSON.stringify(packageJson.optionalDependencies)) {
  throw new Error('the vendored app package manifest does not match the generated release manifest');
}

const cli = join(app, 'dist', 'cli.js');
const commandEnv = { ...process.env, NODE_PATH: '' };
const version = execFileSync(nodePath, [cli, '--version'], { cwd: app, env: commandEnv, encoding: 'utf8' }).trim();
if (version !== packageJson.version) throw new Error(`the vendored CLI reported ${version}, expected ${packageJson.version}`);
const tools = execFileSync(nodePath, [cli, 'tools'], { cwd: app, env: commandEnv, encoding: 'utf8' }).trim();
if (tools.split(/\r?\n/u).filter(Boolean).length !== 9) throw new Error('the vendored CLI must expose the nine bundled tools');

const library = await import(pathToFileURL(join(app, 'dist', 'index.js')).href);
const requireFromApp = createRequire(join(app, 'package.json'));
const insideAppModules = async (name) => {
  const modulePath = await realpath(requireFromApp.resolve(name));
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
await insideAppModules(keyringBinding);
const keyring = requireFromApp('@napi-rs/keyring');
if (typeof keyring.AsyncEntry !== 'function') throw new Error('the vendored keyring native module did not load');

const backend = await library.resolveRipgrep({});
if (typeof backend?.executable !== 'string' || !isAbsolute(backend.executable)) {
  throw new Error(`the vendored search backend is unavailable: ${JSON.stringify(backend)}`);
}
const backendPath = await realpath(backend.executable);
const provider = await import(pathToFileURL(requireFromApp.resolve('@vscode/ripgrep')).href);
if (await realpath(provider.rgPath) !== backendPath) throw new Error('@vscode/ripgrep and the Ligule host resolved different search binaries');
const expectedPackage = await realpath(join(appModules, providerPackage));
const relativeBackend = relative(expectedPackage, backendPath);
if (relativeBackend === '..' || relativeBackend.startsWith(`..${sep}`) || isAbsolute(relativeBackend)) {
  throw new Error(`the search backend is outside ${expectedPackage}: ${backendPath}`);
}

const temporary = await mkdtemp(join(tmpdir(), 'ligule-runtime-check-'));
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
  await rm(temporary, { recursive: true, force: true });
}

console.log(`runtime check passed: Node ${process.version}; ligule ${version}; tools; bash and PowerShell grammars; keyring; ${providerPackage} search`);
