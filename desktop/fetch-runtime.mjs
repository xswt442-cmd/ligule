// 桌面壳的自包含运行时（D34）：安装包要能装到没有这份仓库的机器上就跑起来，
// 所以随包带两样东西——一份钉住版本的 Node，和 ligule 自己的运行时树（src 加它需要的依赖）。
// 与 `scripts/build-rg.js` 同一种做法：版本与校验和写在 pin 文件里，下载后先核对再落地。
// 用法：node desktop/fetch-runtime.mjs [--force]
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const vendor = join(root, 'desktop', 'vendor');
const force = process.argv.includes('--force');

const pin = JSON.parse(await readFile(join(root, 'desktop', 'node-pin.json'), 'utf8'));
const archive = `node-${pin.version}-win-x64.zip`;

async function sha256(path) {
  const hash = createHash('sha256');
  hash.update(await readFile(path));
  return hash.digest('hex');
}

// Node 的可执行文件：已经存在且版本对得上就跳过下载。
const nodeExe = join(vendor, 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node');
async function fetchNode() {
  if (!force && existsSync(nodeExe)) {
    const printed = execFileSync(nodeExe, ['--version'], { encoding: 'utf8' }).trim();
    if (printed === pin.version) return console.log(`node ${printed} already vendored`);
  }
  const download = await sha256Checked(join(await mkdtemp(join(tmpdir(), 'ligule-node-')), archive));
  const outDir = join(vendor, 'node');
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  // 解包用系统自带的那一份 bsdtar（认 zip、能只抽一个成员）。要按全路径调用：
  // Git Bash 的 PATH 上前面的 tar 是 GNU tar，它既读不了 zip 也把「C:\…」的冒号当成远程主机
  // （本机 2026-10-02 实测两条）。bsdtar 没有 --force-local 这个选项，也不需要。
  const inner = `${archive.replace('.zip', '')}/`;
  if (process.platform === 'win32') {
    const bsdtar = join(process.env.SystemRoot ?? 'C:\\WINDOWS', 'System32', 'tar.exe');
    execFileSync(bsdtar, ['-xf', download, '--strip-components=1', '-C', outDir, `${inner}node.exe`]);
  } else {
    execFileSync('tar', ['-xf', download, '--strip-components=1', '-C', outDir, `${inner}node.exe`]);
  }
  await rm(join(download, '..'), { recursive: true, force: true });
  console.log(`vendored ${pin.version} -> ${nodeExe}`);
}

async function sha256Checked(target) {
  const url = `https://nodejs.org/dist/${pin.version}/${archive}`;
  console.log(`downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`the Node download failed with ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== pin.sha256) throw new Error(`${archive} checksum mismatch: got ${actual}`);
  await writeFile(target, bytes);
  return target;
}

// 生产依赖的目录名：从 package.json 的 dependencies 出发，按锁文件里已经装好的那份递归收。
function productionPackages() {
  const manifest = JSON.parse(readFileSyncSync(join(root, 'package.json')));
  const wanted = new Set(Object.keys(manifest.dependencies ?? {}));
  const modules = join(root, 'node_modules');
  const found = new Set();
  for (const name of wanted) collect(name);
  function collect(name) {
    if (found.has(name)) return;
    const directory = join(modules, name);
    if (!existsSync(directory)) {
      // 原生模块装不上时（CI 的 allowScripts、跨平台）跳过它：内核那一侧本来就有降级路径。
      console.log(`skipped ${name}: not installed`);
      return;
    }
    found.add(name);
    const pkg = JSON.parse(readFileSyncSync(join(directory, 'package.json')));
    for (const dependency of Object.keys(pkg.dependencies ?? {})) collect(dependency);
  }
  return [...found].sort();
}

function readFileSyncSync(path) {
  // 同步读：依赖树只有几十次读，写成异步反而要把整段收集改成 await 链。
  return readFileSync(path, 'utf8');
}

async function copyTree(from, to) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) await copyTree(source, target);
    else await copyFile(source, target);
  }
}

async function fetchAppTree() {
  const app = join(vendor, 'app');
  await rm(app, { recursive: true, force: true });
  await mkdir(join(app, 'node_modules'), { recursive: true });
  await copyTree(join(root, 'src'), join(app, 'src'));
  await copyFile(join(root, 'package.json'), join(app, 'package.json'));
  await copyFile(join(root, 'LICENSE'), join(app, 'LICENSE'));
  for (const name of productionPackages()) {
    await copyTree(join(root, 'node_modules', name), join(app, 'node_modules', name));
  }
  const files = await countFiles(app);
  console.log(`vendored the runtime tree -> ${app} (${files} files)`);
}

async function countFiles(directory) {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    total += entry.isDirectory() ? await countFiles(join(directory, entry.name)) : 1;
  }
  return total;
}

const existing = await stat(join(vendor, 'app', 'src', 'cli.js')).catch(() => null);
if (existing !== null && !force && Date.now() - existing.mtimeMs < 4 * 60 * 60 * 1000) {
  console.log('runtime tree already vendored (use --force to redo)');
} else {
  await fetchNode();
  await fetchAppTree();
}
console.log(`node: ${basename(nodeExe)}`);
