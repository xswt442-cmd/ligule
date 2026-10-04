// `exec` 用哪一个解释器由 Host 定（D59）：模型侧仍然只有一件 `exec`，配置 `exec.shell` 取 `auto`、`bash`、`powershell`，
// `auto` 按平台探测挑一份。选择要进会话记录（种类 + 实际解析出来的可执行文件），因为判定链读的是那一种语法下的解析结果。
// 探测不动用进程：已知位置直接 stat，其余按 PATH 逐目录 stat（顺序照 pi，`pi/packages/coding-agent/src/utils/shell.ts:76-119`）。
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { KernelError } from '../kernel/error.js';

export type ShellKind = 'bash' | 'powershell';

export interface ShellSelection {
  kind: ShellKind;
  // 实际起起来的那一个可执行文件：记录里要看得见它，不接受「大概是系统默认 shell」这种含糊。
  executable: string;
  // 解释器自己的参数，命令文本作为最后一个参数交进去。
  prefix: string[];
  // 跟在命令文本后面的一段固定文本，只在能证明这一条是原生命令时才补（`withNativeExitCode`）。
  tail: string;
}

interface ShellProbe {
  platform?: NodeJS.Platform;
  environment?: Record<string, string | undefined>;
  locateExecutable?: (name: string, environment: Record<string, string | undefined>) => string | undefined;
}

const CHOICES = ['auto', 'bash', 'powershell'];

// `-NoProfile` 不加载使用者的 profile（那里面装着别人的函数与别名，同一条文本会跑出另一回事），
// `-NonInteractive` 让它不等人。pi 还带 `-ExecutionPolicy Bypass`（同文件 `:122`）：那一条绕过的是脚本文件那一档，
// 这里递进去的是一段命令文本，策略管不到它，所以不替使用者改动机器的执行策略。
const POWERSHELL_PREFIX = ['-NoProfile', '-NonInteractive', '-Command'];
const BASH_PREFIX = ['-c'];

// Windows PowerShell 5.1 在 `-Command` 下把失败的原生命令一律交回 1，命令真正的退出码留在 `$LASTEXITCODE` 里
// （本机 2026-10-03 实测：`node` 里 `process.exit(7)`，交回来的是 1，补上这一段之后交回来的是 7）。
// 这一段不能对所有 PowerShell 命令统一补：cmdlet 失败不改 `$LASTEXITCODE`，补上去就把一次失败读成上一条原生命令的退出码，
// 常常是 0，也就是成功。所以只补在能证明「这一条是原生命令」的那一次调用上（`withNativeExitCode`）。
const POWERSHELL_TAIL = '; exit $LASTEXITCODE';

function known(directory: string | undefined, ...parts: string[]): string | undefined {
  return directory === undefined || directory === '' ? undefined : join(directory, ...parts);
}

// 名字里带路径分隔符的当成一个位置直接看，其余按 PATH 逐目录找。
function locate(name: string, environment: Record<string, string | undefined>): string | undefined {
  if (name.includes('/') || name.includes('\\')) return existsSync(name) ? name : undefined;
  for (const directory of (environment.PATH ?? environment.Path ?? '').split(delimiter)) {
    if (directory === '') continue;
    const candidate = join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

// Windows 上按名字调用时可省略的后缀来自 PATHEXT：PATH 上真实存在的是 `git.exe`，`git` 这个文件不存在。
// 只试 PATHEXT 里那几个，不试 `.ps1`——一个模块脚本不是一条原生命令，补退出码尾巴对它没有意义。
function windowsExtensions(environment: Record<string, string | undefined>): string[] {
  return (environment.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter((entry) => entry !== '');
}

function firstFound(
  names: (string | undefined)[],
  environment: Record<string, string | undefined>,
  locateExecutable: (name: string, environment: Record<string, string | undefined>) => string | undefined,
): { executable: string | undefined; searched: string[] } {
  const searched = names.filter((name): name is string => name !== undefined);
  for (const name of searched) {
    const found = locateExecutable(name, environment);
    if (found !== undefined) return { executable: found, searched };
  }
  return { executable: undefined, searched };
}

function bashCandidates(platform: NodeJS.Platform, environment: Record<string, string | undefined>): (string | undefined)[] {
  // POSIX 上先要 /bin/bash，再退到 PATH 上的 bash，最后是 sh（pi 的次序）。
  if (platform !== 'win32') return ['/bin/bash', 'bash', 'sh'];
  // Windows 上没有系统自带的 bash，找的是 Git for Windows 装的那一份。
  return [
    known(environment.ProgramFiles, 'Git', 'bin', 'bash.exe'),
    known(environment['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'),
    'bash.exe',
    'bash',
  ];
}

function powershellCandidates(platform: NodeJS.Platform): string[] {
  // PowerShell 7 在 PATH 上叫 pwsh，Windows 自带的那一份叫 powershell；先要新的一份。
  return platform === 'win32' ? ['pwsh.exe', 'powershell.exe'] : ['pwsh', 'powershell'];
}

// 交回这一具 Host 该用哪一个解释器。`auto` 在 Windows 上先看 PowerShell 再看 Git Bash，在别的平台上用 bash；
// 显式写了哪一种就只要那一种——拿不到时报稳定码而不是悄悄换成另一份，因为换掉的那一种正是判定链读过的语法。
export function resolveShell(
  config: { exec?: { shell?: unknown } },
  { platform = process.platform, environment = process.env, locateExecutable = locate }: ShellProbe = {},
): ShellSelection {
  const requested = config.exec?.shell ?? 'auto';
  if (typeof requested !== 'string' || !CHOICES.includes(requested)) {
    throw new KernelError('exec_shell_unknown', { detail: `exec.shell is ${JSON.stringify(requested)}, expected one of ${CHOICES.join(', ')}` });
  }
  const kinds: ShellKind[] = requested === 'auto' ? (platform === 'win32' ? ['powershell', 'bash'] : ['bash']) : [requested as ShellKind];
  const failures: string[] = [];
  for (const kind of kinds) {
    const names = kind === 'bash' ? bashCandidates(platform, environment) : powershellCandidates(platform);
    const { executable, searched } = firstFound(names, environment, locateExecutable);
    if (executable !== undefined) {
      return { kind, executable, prefix: kind === 'bash' ? BASH_PREFIX : POWERSHELL_PREFIX, tail: '' };
    }
    failures.push(`${kind}: ${searched.join(', ')}`);
  }
  const looked = failures.join('; ');
  if (requested === 'auto') throw new KernelError('exec_shell_unavailable', { detail: `no shell backend was found (looked for ${looked})` });
  throw new KernelError('exec_shell_unavailable', { detail: `exec.shell="${requested}" but nothing matched ${looked}` });
}

// 判定链把这条文本读成「一条简单命令」之后才来问这一句：命令名在这台机器上是一个可执行文件，才补那段退出码尾巴。
// 名字落在 PATH 之外（cmdlet、函数、别名）时不补——宁可交回 PowerShell 自己的那一个 1，也不交回上一条原生命令留下的旧值。
// 只给一条命令补：分号与 `&&` 串起来的那几种，`$LASTEXITCODE` 说的是最后那一条，前几条的失败会被盖掉。
export function withNativeExitCode(
  shell: ShellSelection,
  command: string | undefined,
  { platform = process.platform, environment = process.env, locateExecutable = locate }: ShellProbe = {},
): ShellSelection {
  if (shell.kind !== 'powershell' || shell.tail !== '' || command === undefined) return shell;
  const name = /^(\S+)(\s|$)/.exec(command)?.[1];
  if (name === undefined) return shell;
  const extensions = platform === 'win32' ? windowsExtensions(environment) : [];
  const candidates = [name, ...extensions.flatMap((extension) => [name + extension.toLowerCase(), name + extension])];
  for (const candidate of candidates) {
    if (locateExecutable(candidate, environment) !== undefined) return { ...shell, tail: POWERSHELL_TAIL };
  }
  return shell;
}
