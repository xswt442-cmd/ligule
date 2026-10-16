// 准备桌面安装包的独立 Node 和由 workspace lockfile 部署的 Ligule 生产运行树。
// 用法：pnpm run prepare-runtime
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import spawn from 'cross-spawn';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSymlinksInside, pruneForeignNativeDirectories } from '../scripts/runtime-tree.js';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const vendor = join(root, 'desktop', 'vendor');
const force = process.argv.includes('--force');

const pin = JSON.parse(await readFile(join(root, 'desktop', 'node-pin.json'), 'utf8'));
// 目标默认就是本机这一个：运行树里的原生绑定（tree-sitter 与 koffi 的 `.node`）只能来自真正跑着它们的那个平台。
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

// Node 的可执行文件：位置、目标与版本三样都对上才跳过下载。只按「文件在不在」判断，
// 一台机器上换平台准备时会把上一个平台的Node 当成已经备好的那一份。
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
      // 归档里可执行文件在 `bin/` 下面，而壳找的是随包目录里的 `node/<可执行文件名>`：取掉两层前缀落下来，
      // 再把可执行位补上——解包工具的属主规则不是我们要依赖的东西。许可跟着 Node 本体一起进包。
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
  await rm(app, { recursive: true, force: true });
  const packageManager = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).packageManager;
  const expectedVersion = /^pnpm@(\d+\.\d+\.\d+)$/.exec(packageManager ?? '')?.[1];
  const userAgent = process.env.npm_config_user_agent ?? '';
  const runningVersion = /^pnpm\/(\d+\.\d+\.\d+)/.exec(userAgent)?.[1];
  const pnpmCli = process.env.npm_execpath;
  if (expectedVersion === undefined || runningVersion !== expectedVersion || pnpmCli === undefined || !basename(pnpmCli).toLowerCase().includes('pnpm')) {
    throw new Error(`run this script through the pinned ${packageManager ?? 'pnpm workspace'} command`);
  }
  const args = ['--filter=ligule-desktop', '--prod', 'deploy', app];
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
  await writeFile(join(app, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  for (const metadataPath of [
    join(app, 'pnpm-lock.yaml'),
    join(app, 'pnpm-workspace.yaml'),
    join(app, 'node_modules', '.modules.yaml'),
    join(app, 'node_modules', '.pnpm-workspace-state-v1.json'),
    join(app, 'node_modules', '.pnpm', 'lock.yaml'),
  ]) {
    await rm(metadataPath, { force: true });
  }
  await pruneForeignNativeDirectories(join(app, 'node_modules'), target);
  await assertSymlinksInside(app);
  console.log(`deployed the locked production runtime -> ${app} (${target})`);
}

await fetchNode();
await fetchAppTree();
console.log(`node: ${basename(nodeExe)}`);
