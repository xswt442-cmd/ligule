// 个人键位存在本机这一份文件里：它是界面上的方便物，不进会话记录、不进模型上下文、也不进项目的业务配置（方案 6.1、D81 边界二）。
// 形状是一份 JSON 对象：动作名 → 那一串键的写法。表里没有的动作名与读不懂的键名在 read 那一步就拒掉，
// 因为「读坏了整份用默认」不如「那一条说清楚为什么没落下来」——键位错了让人以为按键坏了。
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseSpec } from './keymap.js';
import { dataRoot } from '../kernel/config-file.js';

export function keyPathOf(home = homedir()): string {
  return join(dataRoot(home), 'tui-keys.json');
}

/** 读那一份覆盖：读不懂的一格都不落下，交回的是有效的那一些与拒掉的的名字。 */
export async function readKeys(path = keyPathOf()): Promise<{ overrides: Record<string, string>; refused: string[] }> {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return { overrides: {}, refused: [] };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { overrides: {}, refused: ['这份文件读不懂，整份按默认那一份走'] };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { overrides: {}, refused: ['这份文件写的不是那一张表，整份按默认那一份走'] };
  }
  const overrides: Record<string, string> = {};
  const refused: string[] = [];
  for (const [action, value] of Object.entries(parsed as Record<string, unknown>)) {
    const spec = typeof value === 'string' ? parseSpec(value) : null;
    if (spec === null) { refused.push(`${action}=${String(value)}`); continue; }
    overrides[action] = spec;
  }
  return { overrides, refused };
}

let writing: Promise<void> = Promise.resolve();

/** 整份重写：一次只留一份在写，同进程里连着改两次不会交错。先写临时文件再改名，不留半份。 */
export function writeKeys(path: string, overrides: Record<string, string>): Promise<void> {
  writing = writing.then(async () => {
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(overrides, null, 2)}\n`, 'utf8');
    await rename(temp, path);
  });
  return writing;
}

export function flushKeys(): Promise<void> {
  return writing;
}
