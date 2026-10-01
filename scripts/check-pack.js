// 发布物检查：跑一次 npm pack，解开打出来的那个包，按 package.json 声明的入口逐个查文件在不在，
// 再把解出来的目录当成一个已经安装好的 ligule，从一个空的消费者目录里 import 一次。
// npm test 发现不了这两类问题：测试直接从 src/ 导入，绕过了 files 白名单和 exports。
//
// 跑法：npm run check-pack
//
// npm 自己启动的是 npm.cmd 那个批处理包装，而 Windows 上的 Node 不允许不经 shell 直接启动
// .cmd 文件（spawnSync 报 EINVAL）。npm 在子进程环境里放了 npm_execpath，指向它真正的入口
// JavaScript 文件，所以这里用 node.exe 加那个文件来跑 npm。tar 与 node.exe 都是真正的可执行文件。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const repo = fileURLToPath(new URL('..', import.meta.url));
const packDir = join(repo, 'testplace', 'pack');
const work = join(packDir, 'check');
const npmCli = process.env.npm_execpath;
if (!npmCli) {
  throw new Error('run it as `npm run check-pack` - only npm itself can tell Node which file to launch on Windows');
}

// exports 可以写成字符串，也可以写成带条件的对象，这里把所有字符串取值收齐。
function collectTargets(value, found = []) {
  if (typeof value === 'string') found.push(value);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) collectTargets(item, found);
  return found;
}

rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

try {
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  const tarball = `${pkg.name}-${pkg.version}.tgz`;
  mkdirSync(packDir, { recursive: true });
  execFileSync(process.execPath, [npmCli, 'pack', '--pack-destination', 'testplace/pack'], { cwd: repo, stdio: 'inherit' });
  if (!existsSync(join(packDir, tarball))) {
    throw new Error(`npm pack did not produce testplace/pack/${tarball}`);
  }
  // GNU tar 把带冒号的路径当成远程设备（`E:\...` 会被理解成去连主机 `E`），
  // 所以传给 tar 的只有相对仓库根、用斜杠分开的路径。
  execFileSync('tar', ['-xzf', `testplace/pack/${tarball}`, '-C', 'testplace/pack/check'], { cwd: repo, stdio: 'inherit' });

  const shipped = join(work, 'package');
  const manifest = JSON.parse(readFileSync(join(shipped, 'package.json'), 'utf8'));
  const declared = [
    ...collectTargets(manifest.exports),
    ...collectTargets(manifest.bin),
  ];
  if (declared.length === 0) throw new Error('package.json declares neither exports nor bin, nothing to check');
  for (const target of declared) {
    if (!existsSync(join(shipped, target))) {
      throw new Error(`${tarball} is missing ${target}, which package.json points at`);
    }
  }

  const consumer = join(work, 'consumer');
  mkdirSync(join(consumer, 'node_modules'), { recursive: true });
  renameSync(shipped, join(consumer, 'node_modules', 'ligule'));
  writeFileSync(join(consumer, 'package.json'), `${JSON.stringify({ name: 'ligule-consumer', version: '0.0.0', private: true }, null, 2)}\n`);
  writeFileSync(
    join(consumer, 'probe.mjs'),
    [
      "import { createKernel, KernelError } from 'ligule';",
      "if (typeof KernelError !== 'function') throw new Error('KernelError is missing from the installed package');",
      "const kernel = createKernel();",
      "if (kernel.manifest().length !== 0) throw new Error('the installed kernel ships tools');",
      "const dispose = kernel.register({",
      "  name: 'smoke',",
      "  description: 'installed package smoke test',",
      "  parameters: { type: 'object', properties: {} },",
      "  run: async () => 'ok',",
      "});",
      "const [tool] = kernel.manifest();",
      "if (!tool || tool.name !== 'smoke' || Object.keys(tool).length !== 3) {",
      "  throw new Error(`unexpected manifest entry: ${JSON.stringify(tool)}`);",
      "}",
      "dispose();",
      "if (kernel.manifest().length !== 0) throw new Error('dispose did not remove the tool');",
      "console.log('installed package works');",
    ].join('\n'),
  );
  execFileSync(process.execPath, ['probe.mjs'], { cwd: consumer, stdio: 'inherit' });
  console.log(`pack check ok: ${tarball}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
