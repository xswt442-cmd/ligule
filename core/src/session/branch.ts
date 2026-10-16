// 分支：把一份记录的前缀复制成一份新会话，父那一份一个字都不动（方案 4.3）。
// 两个入口共用这一处：不指名边界就是整份复制（复制时父会话跑到哪儿就带到哪儿），
// 指名一个轮次标记的序号就复制到那一条为止——只有正常完整结束的那一轮留下标记（D68 那一条 `turn`）。
import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { KernelError } from '../kernel/error.js';
import { workspaceIdentity } from '../kernel/workspace.js';
import { createSessionHeader, type SessionModeIdentity } from './format.js';
import { parseSessionBytes } from './record.js';

export interface BranchResult {
  sessionId: string;
  parentSessionId: string;
  // 复制停在哪儿：那一条事件的序号，父会话后来追加的不进这一份。
  at: number;
  events: number;
}

function unavailable(detail: string): KernelError {
  return new KernelError('session_branch_point_unavailable', { detail });
}

// 复制的是那些行本身，不是重新拼出来的：未知但标了可跳过的那些条、以及谁多写的一格都原样带过去，
// 序号也接着父那一份连续（D73）。首行那一份元信息除外——新会话写自己那一份；没有首行的现存记录不丢事件。
function prefixLines(text: string, boundary: number): string[] {
  const kept: string[] = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const event = JSON.parse(line) as { kind?: unknown; seq?: unknown };
    if (event.kind === 'session') continue;
    if (typeof event.seq === 'number' && event.seq > boundary) break;
    kept.push(line);
  }
  return kept;
}

function modeInForce(kept: string[], fallback: SessionModeIdentity | undefined): SessionModeIdentity | undefined {
  let mode = fallback;
  for (const line of kept) {
    const event = JSON.parse(line) as { kind?: string; name?: unknown; layer?: unknown };
    if (event.kind === 'mode' && typeof event.name === 'string') {
      mode = { name: event.name, layer: String(event.layer ?? '') };
    }
  }
  return mode;
}

export async function branchSession(
  directory: string,
  parentSessionId: string,
  { at, projectRoot }: { at?: number; projectRoot?: string },
): Promise<BranchResult> {
  let text: string;
  try {
    text = await readFile(join(directory, `${parentSessionId}.jsonl`), 'utf8');
  } catch (cause) {
    if ((cause as { code?: string }).code === 'ENOENT') throw new KernelError('session_not_found', { detail: parentSessionId });
    throw cause;
  }
  const record = parseSessionBytes(Buffer.from(text, 'utf8'));
  const last = record.events.at(-1);
  const boundary = at ?? (last?.seq ?? -1);
  if (at !== undefined) {
    // 一个轮次的分支点就是它那一条标记：标记写在正常收尾的那一刻，取消、失败与上限都留不下它（D68）。
    // 旧记录证明不了边界时不猜一个点出来——那一种会话走整份复制那一个入口。
    const marker = record.events.find((event) => event.kind === 'turn' && event.seq === at && event.status === 'completed');
    if (marker === undefined) {
      throw unavailable(`${parentSessionId} has no completed turn at event ${at}; copying the whole record takes no \`at\``);
    }
  }
  const kept = prefixLines(text, boundary);
  const id = randomUUID();
  const header = createSessionHeader({
    id,
    projectRoot,
    // 支线抄的是来源那一份首行：它落在哪一具工作区、当初怎么落到那儿的（方案 5.5.4「分支继承来源会话的实际工作区与显示归属」）。
    // 父侧那一格没有说过这两件事，就还是不写，不拿现在的目录或默认值替它猜一个来源。
    workspace: record.header?.workspace ?? (projectRoot === undefined || projectRoot === '' ? undefined : workspaceIdentity(projectRoot)),
    workspaceOrigin: record.header?.workspaceOrigin,
    createdAt: new Date().toISOString(),
    mode: modeInForce(kept, record.header?.mode),
  });
  // 这一份是谁的分支、停在哪儿：新会话的身份事实，随首行一起写，模型看不见它。
  const written = [JSON.stringify({ ...header, branchOf: parentSessionId, branchAt: boundary }), ...kept];
  const path = join(directory, `${id}.jsonl`);
  // 先写临时名再改名：列表只认 `.jsonl`，所以一份没写完的分支不会先出现在那儿（方案 4.3）。
  const temporary = `${path}.tmp`;
  try {
    await writeFile(temporary, `${written.join('\n')}\n`, 'utf8');
    await rename(temporary, path);
  } catch (cause) {
    throw new KernelError('session_branch_failed', { cause, detail: `${parentSessionId} at ${boundary}: ${(cause as Error).message}` });
  }
  return { sessionId: id, parentSessionId, at: boundary, events: kept.length };
}
