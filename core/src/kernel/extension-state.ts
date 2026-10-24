// 扩展启停登记：数据根下的持久状态，记录用户显式停用的已安装扩展。
// 登记只过滤安装目录的发现结果；配置层显式声明的路径不受其约束。
// 读取失败按空登记处理（等同没有停用任何扩展），同时把原因交回调用方报告。
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import lockfile from 'proper-lockfile';
import { dataRoot } from './config-file.js';
import { KernelError } from './error.js';

const STATE_VERSION = 1;

export function extensionStatePath(home = homedir()): string {
  return join(dataRoot(home), 'extensions-state.json');
}

export interface ExtensionStateRead {
  disabled: string[];
  // 登记文件存在但读不懂时给出原因；不影响按空登记继续。
  invalid?: string;
}

export async function readExtensionState(home = homedir()): Promise<ExtensionStateRead> {
  let text: string;
  try {
    text = await readFile(extensionStatePath(home), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { disabled: [] };
    throw new KernelError('extension_state_read_failed', { cause: error, detail: extensionStatePath(home) });
  }
  try {
    const parsed = JSON.parse(text) as { version?: unknown; disabled?: unknown };
    if (parsed.version !== STATE_VERSION
      || !Array.isArray(parsed.disabled)
      || parsed.disabled.some((item) => typeof item !== 'string' || item === '')) {
      return { disabled: [], invalid: 'the extension state document is invalid' };
    }
    return { disabled: [...new Set(parsed.disabled as string[])].sort() };
  } catch (cause) {
    return { disabled: [], invalid: (cause as Error).message };
  }
}

// 读取-合并-写入在同一文件锁内完成；临时文件加原子替换落盘。
export async function writeExtensionState(home = homedir(), disabled: readonly string[] = []): Promise<void> {
  const target = extensionStatePath(home);
  await mkdir(dirname(target), { recursive: true });
  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(target, { realpath: false, lockfilePath: `${target}.lock`, stale: 10_000, update: 2_000, retries: 0 });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ELOCKED') {
      throw new KernelError('extension_state_locked', { detail: `${target} has an active writer` });
    }
    throw cause;
  }
  const temporary = `${target}.${randomUUID()}.tmp`;
  let created = false;
  try {
    const document = JSON.stringify({ version: STATE_VERSION, disabled: [...new Set(disabled)].sort() }, null, 2);
    const handle = await open(temporary, 'wx', 0o600);
    created = true;
    try {
      await handle.writeFile(document, 'utf8');
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
    created = false;
  } finally {
    try {
      if (created) await rm(temporary, { force: true });
    } finally {
      await release();
    }
  }
}
