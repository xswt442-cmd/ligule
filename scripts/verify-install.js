// 全新安装验证：打一份 tarball，在一个空目录里让 npm 真的装一次，再按发布验收那几件事读一遍。
// `check-pack` 那一格把开发树的依赖复制给消费者，它证明的是「文件带齐了」；这一格证明的是「声明装得出来」。
// 依赖从 tarball 里的 package.json 解析、下载并安装，一个字节都不从本仓库的 `node_modules` 复制，所以要网络。
//
// 跑法：npm run verify-install
// 带一个 tarball 路径时用它，不再自己打：发布流水线要在同一批字节上先验后发，那一份身份就是 artifact 里的那一个文件。
import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const repo = fileURLToPath(new URL('..', import.meta.url));
const packDir = join(repo, 'testplace', 'pack');
const consumer = join(packDir, 'install', 'consumer');
const given = process.argv[2];
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('run it as `npm run verify-install` - only npm itself can tell Node which file to launch on Windows');
if (!existsSync(join(repo, 'dist', 'index.js'))) {
  throw new Error('dist/index.js is missing; run `npm run build` before verifying a fresh install');
}

const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
const tarball = given === undefined ? join(packDir, `${pkg.name}-${pkg.version}.tgz`) : resolve(given);
rmSync(join(packDir, 'install'), { recursive: true, force: true });
mkdirSync(consumer, { recursive: true });
// 消费者自己的清单：空目录里只写这一份，装进去的依赖全部来自 tarball 的声明。
// 那四件带原生绑定的依赖要在安装时跑自己的脚本；把「允许哪些依赖跑脚本」写成包内的一格，是收得紧的 npm 唯一收的形式
// （命令行与用户级配置里的白名单在项目范围内的安装里都不算）。普通 npm 不读这一格，装出来完全一样。
writeFileSync(join(consumer, 'package.json'), `${JSON.stringify({
  name: 'ligule-consumer',
  version: '0.0.0',
  private: true,
  allowScripts: { koffi: true, 'tree-sitter': true, 'tree-sitter-bash': true, 'tree-sitter-pwsh': true },
}, null, 2)}\n`, 'utf8');
execFileSync(process.execPath, [npmCli, 'pack', '--pack-destination', 'testplace/pack'], { cwd: repo, stdio: 'inherit' });
if (!existsSync(tarball)) throw new Error(`npm pack did not produce ${tarball}`);

// 一次真实安装：解析、下载与安装脚本都按声明走，装不出来就是声明本身有问题。
try {
  execFileSync(process.execPath, [npmCli, 'install', tarball, '--no-audit', '--no-fund'], {
    cwd: consumer,
    encoding: 'utf8',
    timeout: 900_000,
  });
} catch (error) {
  const text = `${error.stdout ?? ''}${error.stderr ?? ''}${(error.output ?? []).join('')}${error.message ?? ''}`;
  process.stdout.write(text.split(/\r?\n/).filter((line) => line.trim() !== '').slice(-12).join('\n'));
  // 收得紧的 npm 会把「哪些依赖可以跑安装脚本」当成项目范围内必须显式批准的策略；这一格要说清去哪儿改，别留一个裸的退出码。
  if (text.includes('EALLOWSCRIPTS')) {
    throw new Error('npm 拒绝了这一次安装里依赖自带的安装脚本（EALLOWSCRIPTS）。它只认包内那一格白名单（消费者 package.json 的 allowScripts）或项目 .npmrc，'
      + '这一份脚本已经写了那一格仍然被拒，说明这台机器上的 npm 收得比声明更紧。普通 npm 环境（发布流水线那一条）不受这一条影响。');
  }
  throw error;
}

const installed = JSON.parse(readFileSync(join(consumer, 'node_modules', pkg.name, 'package.json'), 'utf8'));
if (installed.version !== pkg.version) throw new Error(`the consumer got ${installed.version}, package.json says ${pkg.version}`);
if (existsSync(join(consumer, 'node_modules', 'typescript'))) throw new Error('devDependencies came along into the consumer');

// 走用户实际用的那一条路：`.bin` 里的包装脚本，Windows 上是那一个 .cmd。
const env = {
  ...process.env,
  PATH: `${join(consumer, 'node_modules', '.bin')}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
};
const run = (args) => spawnSync(pkg.name, args, { env, cwd: consumer, shell: true, encoding: 'utf8', timeout: 60_000 });
const readings = [];

const version = run(['--version']);
if (version.status !== 0 || version.stdout.trim() !== pkg.version) {
  throw new Error(`${pkg.name} --version inside the consumer said "${version.stdout?.trim()}" with status ${version.status}`);
}
readings.push(`--version: ${version.stdout.trim()}`);

const tools = run(['tools']);
const counted = tools.stdout.split('\n').filter((line) => line.trim() !== '').length;
if (tools.status !== 0 || counted !== 9) throw new Error(`${pkg.name} tools listed ${counted}, expected 9`);
readings.push(`tools: ${counted}`);

// TUI 那一格在非交互终端里必须明确拒绝并给出稳定码：这一条同时证明入口链上的模块都装齐了。
const tui = run(['tui']);
if (!`${tui.stdout}${tui.stderr}`.includes('tui_terminal_required')) {
  throw new Error(`${pkg.name} tui on a non-interactive terminal did not report tui_terminal_required: ${(tui.stdout + tui.stderr).slice(0, 200)}`);
}
readings.push('tui: refuses with tui_terminal_required on a non-interactive terminal');

// 两种命令语法与搜索后端都从装好的那一份里跑：原生语法插件或搜索二进制没带上来时，这一段就断。
writeFileSync(join(consumer, 'probe.mjs'), `
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { parseCommand, resolveRipgrep, searchWithRipgrep } from 'ligule';

const bash = await parseCommand('git status');
const pwsh = await parseCommand('Get-ChildItem -Recurse | Select-Object -First 3');
if (bash.kind !== 'segments' || pwsh.kind !== 'segments') {
  throw new Error(\`grammar did not load: bash \${bash.kind}, pwsh \${pwsh.kind}\`);
}
console.log(\`grammar: bash \${bash.segments.length} segments, pwsh \${pwsh.segments.length} segments\`);

const backend = await resolveRipgrep({});
const found = typeof backend?.executable === 'string' && existsSync(backend.executable);
if (!found) {
  console.log(\`search backend: none here (\${JSON.stringify(backend)})\`);
} else {
  mkdirSync('fixture', { recursive: true });
  writeFileSync('fixture/needle.txt', 'LIGULE-INSTALL-NEEDLE\\n');
  const hits = await searchWithRipgrep({ executable: backend.executable, boundary: process.cwd(), target: 'fixture', pattern: 'LIGULE-INSTALL-NEEDLE', limit: 5 });
  console.log(\`search backend: \${backend.executable}; hits \${JSON.stringify(hits).slice(0, 200)}\`);
  if (JSON.stringify(hits).includes('LIGULE-INSTALL-NEEDLE') === false) throw new Error('the packaged search backend ran but did not find the needle');
}
`, 'utf8');

const probe = spawnSync(process.execPath, ['probe.mjs'], { cwd: consumer, env, encoding: 'utf8' });
if (probe.status !== 0) throw new Error(`the installed package failed its own probe: ${(probe.stderr ?? '').slice(0, 500)}`);
for (const line of probe.stdout.trim().split('\n')) readings.push(line);

for (const line of readings) process.stdout.write(`${line}\n`);
process.stdout.write(`fresh install ok: ${pkg.name}-${pkg.version}.tgz\n`);
