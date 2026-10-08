// 桌面壳的自包含运行时（D34）：安装包要能装到没有这份仓库的机器上就跑起来，
// 所以随包带两样东西——一份钉住版本的 Node，和 ligule 自己的运行时树（构建出来的 dist 加它需要的依赖）。
// 与 `scripts/build-rg-packages.js` 同一种做法：版本与校验和写在 pin 文件里，下载后先核对再放进目录。
// 用法：node desktop/fetch-runtime.mjs [--force]
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
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
  const scratchRoot = join(root, 'testplace');
  await mkdir(scratchRoot, { recursive: true });
  const temporary = await mkdtemp(join(scratchRoot, 'node-runtime-'));
  try {
    const download = await sha256Checked(join(temporary, archive));
    const outDir = join(vendor, 'node');
    await rm(outDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });
    // Windows 自带的 bsdtar 支持 zip 与带盘符的路径。
    const inner = `${archive.replace('.zip', '')}/`;
    if (process.platform === 'win32') {
      const bsdtar = join(process.env.SystemRoot ?? 'C:\\WINDOWS', 'System32', 'tar.exe');
      execFileSync(bsdtar, ['-xf', download, '--strip-components=1', '-C', outDir, `${inner}node.exe`]);
    } else {
      execFileSync('tar', ['-xf', download, '--strip-components=1', '-C', outDir, `${inner}node.exe`]);
    }
    console.log(`vendored ${pin.version} -> ${nodeExe}`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
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
      throw new Error(`${name} is a required runtime dependency but is not installed`);
    }
    found.add(name);
    const pkg = JSON.parse(readFileSyncSync(join(directory, 'package.json')));
    for (const dependency of Object.keys(pkg.dependencies ?? {})) collect(dependency);
    for (const dependency of Object.keys(pkg.optionalDependencies ?? {})) {
      if (existsSync(join(modules, dependency))) collect(dependency);
    }
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
  // 运行时树是构建产物：没有就先构建，不要交出一份装得上、起不来的安装包。
  if (!existsSync(join(root, 'dist', 'cli.js'))) {
    throw new Error('dist/cli.js is missing; run npm run build before vendoring the runtime tree');
  }
  await rm(app, { recursive: true, force: true });
  await mkdir(join(app, 'node_modules'), { recursive: true });
  await copyTree(join(root, 'dist'), join(app, 'dist'));
  await copyTree(join(root, 'modes'), join(app, 'modes'));
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

await fetchNode();
await fetchAppTree();
console.log(`node: ${basename(nodeExe)}`);
