// Ctrl+G 那一条的实际动作：草稿写进一份临时文件，交出去编辑，回来读那一份文件（D81 边界二：草稿归界面）。
// 让出终端这件事由调用方做（Ink 的 suspendTerminal 负责 raw mode 与重画），这一层只碰文件与子进程。
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type EditorOutcome =
  | { readonly text: string }
  | { readonly code: 'tui_editor_command_invalid' | 'tui_editor_failed' };

const WINDOWS = process.platform === 'win32';

export async function editInExternalEditor(command: string, content: string): Promise<EditorOutcome> {
  const [program, ...rest] = command.trim().split(/\s+/);
  if (program === undefined || program === '') return { code: 'tui_editor_command_invalid' };
  const directory = await mkdtemp(join(tmpdir(), 'ligule-editor-'));
  const path = join(directory, 'draft.md');
  try {
    await writeFile(path, content, 'utf8');
    // Windows 上 `code` 这类命令是 .cmd 壳，不经 shell 解析不出来；那种方式下参数只是接在那一条命令串后面，
    // 所以整串由这里拼、每一段自己加引号并去掉串里的引号（临时路径由这一层拼，编辑器名来自本机那一个环境变量，
    // 两处都不是外来文本）。POSIX 上不经过 shell，参数数组就是参数数组。
    const argument = (value: string) => (WINDOWS ? `"${value.replace(/"/g, '')}"` : value);
    const launched = WINDOWS
      ? spawn([program, ...rest, path].map(argument).join(' '), { stdio: 'inherit', shell: true })
      : spawn(program, [...rest, path], { stdio: 'inherit' });
    // 异步 spawn 而不是同步那一种：同步的子进程调用会让父进程的控制台读取与编辑器抢同一把输入。
    const exited = await new Promise<number | null>((resolve) => {
      launched.on('error', () => resolve(null));
      launched.on('close', (code) => resolve(code));
    });
    if (exited !== 0) return { code: 'tui_editor_failed' };
    // 编辑器自己补的最后一个换行不算草稿的内容。
    return { text: (await readFile(path, 'utf8')).replace(/\n$/, '') };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
