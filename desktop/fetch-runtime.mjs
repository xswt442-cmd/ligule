// 准备桌面安装包的独立 Node 和由 workspace lockfile 部署的 Ligule 生产运行树。
// 用法：pnpm run prepare-runtime
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import spawn from 'cross-spawn';
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSymlinksInside, pruneForeignNativeDirectories } from '../scripts/runtime-tree.js';
import { assertCoreRuntimeMatches } from '../scripts/core-runtime.js';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const vendor = join(root, 'desktop', 'vendor');
const force = process.argv.includes('--force');

const pin = JSON.parse(await readFile(join(root, 'desktop', 'node-pin.json'), 'utf8'));
// 默认目标是当前平台；运行树中的原生绑定（tree-sitter 和 koffi 的 `.node`）必须与目标平台一致。
const target = `${process.platform}-${process.arch}`;
const archived = pin.targets[target];
if (archived === undefined) {
  throw new Error(`desktop/node-pin.json has no "${target}" target; it lists ${Object.keys(pin.targets).join(', ')}`);
}
const archive = archived.file;

async function sha256(path) {
  const hash = createHash('sha256');
  hash.update(await readFile(path));
  return hash.digest('hex');
}

// 只有可执行文件的位置、目标平台和版本都匹配时才跳过下载，避免把其他平台的 Node 误认为可用。
const nodeExe = join(vendor, 'node', target.startsWith('win32') ? 'node.exe' : 'node');
const stamp = join(vendor, 'node', '.vendored');
async function fetchNode() {
  const wanted = `${target}:${pin.version}`;
  if (!force && existsSync(nodeExe) && existsSync(stamp) && (await readFile(stamp, 'utf8')).trim() === wanted) {
    const printed = execFileSync(nodeExe, ['--version'], { encoding: 'utf8' }).trim();
    if (printed === pin.version) return console.log(`node ${printed} already vendored for ${target}`);
  }
  const scratchRoot = join(root, 'desktop', 'testplace', 'tmp');
  await mkdir(scratchRoot, { recursive: true });
  const temporary = await mkdtemp(join(scratchRoot, 'node-runtime-'));
  try {
    const download = await sha256Checked(join(temporary, archive));
    const outDir = join(vendor, 'node');
    await rm(outDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });
    const inner = `${archive.replace(/\.(zip|tar\.gz|tar\.xz)$/, '')}/`;
    if (target.startsWith('win32')) {
      // Windows 自带的 bsdtar 支持 zip 与带盘符的路径。
      const bsdtar = join(process.env.SystemRoot ?? 'C:\\WINDOWS', 'System32', 'tar.exe');
      execFileSync(bsdtar, ['-xf', download, '--strip-components=1', '-C', outDir, `${inner}node.exe`, `${inner}LICENSE`]);
    } else {
      // 将归档中 `bin/` 下的可执行文件放到运行树的 `node/` 目录，并显式添加执行权限。
      // 同时把 Node 的许可证文件放入发行包。
      execFileSync('tar', ['-xf', download, '--strip-components=2', '-C', outDir, `${inner}bin/node`]);
      execFileSync('tar', ['-xf', download, '--strip-components=1', '-C', outDir, `${inner}LICENSE`]);
      await chmod(nodeExe, 0o755);
    }
    await writeFile(stamp, `${wanted}\n`, 'utf8');
    console.log(`vendored ${pin.version} for ${target} -> ${nodeExe}`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function sha256Checked(target2) {
  const url = `https://nodejs.org/dist/${pin.version}/${archive}`;
  console.log(`downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`the Node download failed with ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== archived.sha256) throw new Error(`${archive} checksum mismatch: got ${actual}`);
  await writeFile(target2, bytes);
  return target2;
}

async function fetchAppTree() {
  const app = join(vendor, 'app');
  if (!existsSync(join(root, 'core', 'dist', 'host', 'desktop-entry.js'))) {
    throw new Error('Core Host entry is missing; run `pnpm run build:core` before preparing the runtime tree');
  }
  const scratchRoot = join(root, 'desktop', 'testplace', 'tmp');
  await mkdir(scratchRoot, { recursive: true });
  const stagingRoot = await mkdtemp(join(scratchRoot, 'desktop-runtime-'));
  const stagedApp = join(stagingRoot, 'package');
  const projectedApp = join(stagingRoot, 'runtime-app');
  try {
    const packageManager = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).packageManager;
    const expectedVersion = /^pnpm@(\d+\.\d+\.\d+)$/.exec(packageManager ?? '')?.[1];
    const userAgent = process.env.npm_config_user_agent ?? '';
    const runningVersion = /^pnpm\/(\d+\.\d+\.\d+)/.exec(userAgent)?.[1];
    const pnpmCli = process.env.npm_execpath;
    if (expectedVersion === undefined || runningVersion !== expectedVersion || pnpmCli === undefined || !basename(pnpmCli).toLowerCase().includes('pnpm')) {
      throw new Error(`run this script through the pinned ${packageManager ?? 'pnpm workspace'} command`);
    }
    const args = ['--filter=ligule-desktop', '--prod', 'deploy', stagedApp];
    const isJavaScriptCli = /\.(?:cjs|mjs|js)$/i.test(pnpmCli);
    const result = spawn.sync(isJavaScriptCli ? process.execPath : pnpmCli, isJavaScriptCli ? [pnpmCli, ...args] : args, {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, PNPM_CONFIG_NODE_LINKER: 'hoisted' },
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`pnpm deploy exited with status ${result.status ?? 'unknown'}`);
    const manifest = JSON.parse(await readFile(join(root, 'desktop', 'package.json'), 'utf8'));
    manifest.dependencies['@ligule/core'] = '*';
    delete manifest.devDependencies;
    delete manifest.scripts;
    await writeFile(join(stagedApp, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    for (const metadataPath of [
      join(stagedApp, 'pnpm-lock.yaml'),
      join(stagedApp, 'pnpm-workspace.yaml'),
      join(stagedApp, 'node_modules', '.modules.yaml'),
      join(stagedApp, 'node_modules', '.pnpm-workspace-state-v1.json'),
      join(stagedApp, 'node_modules', '.pnpm', 'lock.yaml'),
    ]) {
      await rm(metadataPath, { force: true });
    }
    await assertDeploySourceShape(stagedApp);
    await assertSymlinksInside(stagedApp);
    await mkdir(projectedApp);
    await rename(join(stagedApp, 'package.json'), join(projectedApp, 'package.json'));
    await rename(join(stagedApp, 'node_modules'), join(projectedApp, 'node_modules'));
    await assertRuntimeAppContents(projectedApp);
    await pruneForeignNativeDirectories(join(projectedApp, 'node_modules'), target);
    await assertSymlinksInside(projectedApp);
    await assertRuntimeAppContents(projectedApp);
    await assertCoreRuntimeMatches(join(root, 'core'), join(projectedApp, 'node_modules', '@ligule', 'core'));

    await rm(app, { recursive: true, force: true });
    await rename(projectedApp, app);
    await assertRuntimeAppContents(app);
    await assertSymlinksInside(app);
    console.log(`deployed the locked production runtime -> ${app} (${target})`);
  } finally {
    assertInsideRuntimeStaging(stagingRoot, scratchRoot);
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

async function assertDeploySourceShape(stagedApp) {
  const entries = await readdir(stagedApp, { withFileTypes: true });
  const allowed = new Map([
    ['node_modules', 'directory'],
    ['package.json', 'file'],
    ['README.md', 'file'],
    ['README.en.md', 'file'],
    ['LICENSE', 'file'],
    ['electron', 'directory'],
  ]);
  const unexpected = entries.filter((entry) => {
    const type = allowed.get(entry.name);
    return type === undefined || (type === 'directory' ? !entry.isDirectory() : !entry.isFile());
  }).map((entry) => entry.name);
  const electron = entries.find((entry) => entry.name === 'electron');
  if (electron !== undefined) {
    const electronEntries = await readdir(join(stagedApp, 'electron'), { withFileTypes: true });
    const dist = electronEntries.find((entry) => entry.name === 'dist');
    if (electronEntries.length !== 1 || dist?.isDirectory() !== true) {
      unexpected.push('electron/*');
    } else {
      const distEntries = await readdir(join(stagedApp, 'electron', 'dist'), { withFileTypes: true });
      if (distEntries.length !== 1 || distEntries[0].name !== 'main.js' || !distEntries[0].isFile()) {
        unexpected.push('electron/dist/*');
      }
    }
  }
  const hasPackage = entries.some((entry) => entry.name === 'package.json' && entry.isFile());
  const hasModules = entries.some((entry) => entry.name === 'node_modules' && entry.isDirectory());
  if (!hasPackage || !hasModules || unexpected.length > 0) {
    throw new Error(`pnpm deploy produced unexpected Desktop package files: ${unexpected.join(', ') || 'package.json or node_modules is missing'}`);
  }
}

async function assertRuntimeAppContents(appRoot) {
  const entries = await readdir(appRoot, { withFileTypes: true });
  const allowed = new Map([
    ['node_modules', 'directory'],
    ['package.json', 'file'],
  ]);
  const unexpected = entries.filter((entry) => {
    const type = allowed.get(entry.name);
    return type === undefined || (type === 'directory' ? !entry.isDirectory() : !entry.isFile());
  }).map((entry) => entry.name);
  const hasPackage = entries.some((entry) => entry.name === 'package.json' && entry.isFile());
  const hasModules = entries.some((entry) => entry.name === 'node_modules' && entry.isDirectory());
  if (!hasPackage || !hasModules || unexpected.length > 0) {
    throw new Error(`the Desktop runtime app root has unexpected or missing entries: ${unexpected.join(', ') || 'package.json or node_modules is missing'}`);
  }
}

function assertInsideRuntimeStaging(path, directory) {
  const rootPath = resolve(directory);
  const targetPath = resolve(path);
  const relativePath = relative(rootPath, targetPath);
  if (relativePath === '' || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`temporary Desktop runtime path must remain inside desktop/testplace/tmp: ${path}`);
  }
}

await fetchNode();
await fetchAppTree();
console.log(`node: ${basename(nodeExe)}`);
