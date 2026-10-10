// 桌面壳的自包含运行时（D34）：安装包要能装到没有这份仓库的机器上就跑起来，
// 所以随包带两样东西——一份钉住版本的 Node，和 ligule 自己的运行时树（构建出来的 dist 加它需要的依赖）。
// 与 `scripts/build-rg-packages.js` 同一种做法：版本与校验和写在 pin 文件里，下载后先核对再放进目录。
// 目标按 `<platform>-<arch>` 选，四个目标各自的档名与摘要钉在同一份文件里；一份运行树只带它自己那一个平台的原生绑定。
// 用法：node desktop/fetch-runtime.mjs [--force]
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  const scratchRoot = join(root, 'testplace');
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

// 生产依赖的目录名：从 package.json 的 dependencies 出发，按锁文件里已经装好的那份递归收。
// 可选依赖里只有这份清单进树；koffi 在 Windows 上供 Job Object 那条绑定用，在别的系统上装不上也不进树。
const RUNTIME_OPTIONAL = ['koffi'];

function productionPackages() {
  const manifest = JSON.parse(readFileSyncSync(join(root, 'package.json')));
  const wanted = new Set(Object.keys(manifest.dependencies ?? {}));
  const modules = join(root, 'node_modules');
  const found = new Set();
  for (const name of RUNTIME_OPTIONAL) {
    if (!existsSync(join(modules, name))) {
      if (process.platform === 'win32') throw new Error(`${name} is missing but win32 needs it at runtime`);
      continue;
    }
    wanted.add(name);
  }
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

// 一份运行树只带本目标那一个平台的原生块（见文件头那句）：`prebuilds/<平台>-<架构>` 与 koffi 的
// libc 目录里只留与目标相符的那一份，gyp 的中间物目录 `obj.target` 也不进树。
// AppImage 的 linuxdeploy 对 AppDir 里每个 ELF 跑 patchelf 并解析依赖，撞上 musl 那份 koffi 绑定
// （找不到 libc.musl-x86_64.so.1）整包失败；中间物里的 `.o` 连 patchelf 都过不去。
const NATIVE_DIR = /^(linux|musl|darwin|win32|freebsd|android)[-_](x64|arm64|ia32|armhf|armv7l)$/;
const nativeDir = target.replace('-', '_');
function keepNative(name) {
  if (name === 'obj.target') return false;
  const normalized = name.replaceAll('-', '_');
  return NATIVE_DIR.test(normalized) ? normalized === nativeDir : true;
}

async function copyTree(from, to, keep = () => true) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) {
      if (!keep(entry.name)) continue;
      await copyTree(source, target, keep);
    } else await copyFile(source, target);
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
    await copyTree(join(root, 'node_modules', name), join(app, 'node_modules', name), keepNative);
  }
  const foreign = await listForeignNative(app);
  if (foreign.length > 0) {
    throw new Error(`the runtime tree still carries native dirs for another target: ${foreign.slice(0, 5).join(', ')}`);
  }
  const files = await countFiles(app);
  console.log(`vendored the runtime tree -> ${app} (${files} files, native for ${nativeDir})`);
}

// 复制过后的复核：谓词换掉或漏传时这里当场死，不把多出来的原生块交给 linuxdeploy 才发现。
async function listForeignNative(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(directory, entry.name);
    if (!keepNative(entry.name)) found.push(path);
    else found.push(...(await listForeignNative(path)));
  }
  return found;
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
