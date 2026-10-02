// 造出两个平台包的内容：按 scripts/ripgrep-pin.json 写明的版本下载 ripgrep 的发布产物，
// 逐个校验大小与 sha256，把可执行文件与它自带的三份许可文本解到 packages/<平台>/ 下。
// 二进制不进版本控制，也不由 npm 在安装期拉取：发布工作流跑一次这个脚本，再按依赖顺序发三个包。
// 本地想用外部搜索后端也跑它：npm run build-rg。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const pin = JSON.parse(readFileSync(join(repo, 'scripts', 'ripgrep-pin.json'), 'utf8'));
const work = join(repo, 'testplace', 'rg-build');

function run(command, args, label) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${command} ${args.join(' ')}\n${result.stderr || result.stdout || result.error?.message}`);
  }
  return result;
}

function download(url, destination) {
  // 用 curl 而不是 fetch：这台机器的代理设置在环境变量里，Node 的 fetch 不读它们。
  // 重试三次是本地实测需要的：GitHub 的发布产物走重定向，第一次连接偶发被重置。
  run('curl', ['--fail', '--silent', '--show-error', '--retry', '3', '--location', '--output', destination, url], 'download');
}

function extract(archive, format, staging) {
  mkdirSync(staging, { recursive: true });
  if (format === 'tar.gz') return run('tar', ['-xzf', archive, '-C', staging], 'extract');
  // zip：Windows 上是 powershell 的 Expand-Archive，其余平台用 unzip。
  // Git Bash 里的 tar 是 GNU tar，读不了 zip，所以不能统一走 tar。
  if (process.platform === 'win32') {
    const script = 'Expand-Archive -LiteralPath $env:LIGULE_RG_ARCHIVE -DestinationPath $env:LIGULE_RG_STAGING -Force';
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, LIGULE_RG_ARCHIVE: archive, LIGULE_RG_STAGING: staging },
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.status !== 0) throw new Error(`extract failed: ${result.stderr || result.stdout}`);
    return result;
  }
  return run('unzip', ['-q', archive, '-d', staging], 'extract');
}

function verify(target, bytes) {
  const digest = createHash('sha256').update(bytes).digest('hex');
  const problems = [];
  if (bytes.length !== target.size) problems.push(`size is ${bytes.length}, pinned ${target.size}`);
  if (digest !== target.sha256) problems.push(`sha256 is ${digest}, pinned ${target.sha256}`);
  if (problems.length > 0) throw new Error(`${target.package}: ${problems.join('; ')}`);
}

rmSync(work, { recursive: true, force: true });
for (const [triple, target] of Object.entries(pin.targets)) {
  const asset = `ripgrep-${pin.version}-${target.triple}.${target.format}`;
  const archive = join(work, asset);
  mkdirSync(work, { recursive: true });
  download(`${pin.download}/${pin.version}/${asset}`, archive);
  const bytes = readFileSync(archive);
  verify(target, bytes);

  const staging = join(work, `${target.package}-extract`);
  extract(archive, target.format, staging);
  const source = join(staging, `ripgrep-${pin.version}-${target.triple}`);
  const destination = join(repo, 'packages', target.directory);
  mkdirSync(destination, { recursive: true });
  for (const file of [target.binary, ...pin.licenseFiles]) {
    const from = join(source, file);
    if (!statSync(from, { throwIfNoEntry: false })?.isFile()) throw new Error(`${asset} does not contain ${file}`);
    copyFileSync(from, join(destination, file));
  }
  // 从 zip 里解出来的文件不带可执行位，POSIX 上要自己补上。
  if (process.platform !== 'win32') chmodSync(join(destination, target.binary), 0o755);
  writeFileSync(join(destination, 'RIPGREP-VERSION'), `${target.package} ships ripgrep ${pin.version} for ${target.triple} (pinned in scripts/ripgrep-pin.json)\n`, 'utf8');
  console.log(`${triple}: ripgrep ${pin.version} -> packages/${target.directory}/${target.binary} (${bytes.length} bytes, sha256 ok)`);
}
rmSync(work, { recursive: true, force: true });
