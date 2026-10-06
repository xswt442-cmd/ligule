// 跨会话查找：读的是记录目录里那些整份记录，与列表同一处开盘（U38 那条索引还没建）。
// 交回的是「哪一份会话的第几条」：界面拿着这两个值接上那一份会话，再跳到那一行（方案 4.2）。
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { listSessions } from './list.js';
import type { SessionEvent } from './format.js';
import type { SessionSummary } from './list.js';
import { parseSessionBytes } from './record.js';

export interface SearchHit {
  sessionId: string;
  // 那一行带着名字画：没起过名字是空串，界面拿会话编号当标题（实现顺序第 75 步）。
  name: string;
  seq: number;
  kind: string;
  // 命中处那一段摘录：够认出是哪一句。整段正文由界面用 `session.read` 加这一个序号去取。
  text: string;
  // 命中来自那一次结果，而它的整段溢出在另一个文件里：摘录出自记录留着的那一头一尾，中间那一段没有在这里搜过。
  spilled?: string;
}

// 摘录的窗口：命中处前 16 个字、后 44 个字。codex 用的是 48 与 96，它那一段挂在网页的一行里，
// 本项目这一行前面还要放会话编号与序号。
const BEFORE = 16;
const AFTER = 44;
// 一份会话最多交几条：一个常见词能在长会话里中几百条，全交出来等于把列表刷满。
const PER_RECORD = 3;
export const SEARCH_LIMIT = 50;

// 命中位置先算清楚，两头要不要加省略号才知道。
function excerpt(text: string, at: number, width: number): string {
  const from = Math.max(0, at - BEFORE);
  const to = Math.min(text.length, at + width + AFTER);
  return `${from > 0 ? '…' : ''}${text.slice(from, to).trim()}${to < text.length ? '…' : ''}`;
}

// 一条事件里搜得到的那几段，与各段是什么：人与模型说的话、那一次调用的参数、那一次结果的正文、
// 判定不让做时写的理由，还有这一份会话的名字——名字写在 `label` 那一条上，模型看不见，可人要查的正是它。
// 结果溢出在文件里的那一段正文不读：跨会话扫的是记录本身，读不读那些文件要先有日常使用的数字（U38）。
function sources(event: SessionEvent): (readonly [string, string])[] {
  if (event.kind === 'user' || event.kind === 'assistant' || event.kind === 'reasoning') {
    return typeof event.text === 'string' && event.text !== '' ? [[event.text, 'text']] : [];
  }
  if (event.kind === 'label') {
    return typeof event.name === 'string' && event.name !== '' ? [[event.name, 'name']] : [];
  }
  if (event.kind !== 'tool') return [];
  const result = (event.result ?? {}) as { content?: unknown; reason?: unknown };
  const content = result.content;
  const body = typeof content === 'string' ? content : typeof (content as { text?: unknown })?.text === 'string' ? (content as { text: string }).text : '';
  const args = JSON.stringify(event.args ?? {});
  const found: (readonly [string, string])[] = [[args, 'args'], [body, 'result'], [typeof result.reason === 'string' ? result.reason : '', 'reason']];
  return found.filter(([text]) => text !== '' && text !== '{}');
}

function matchIn(item: SessionSummary, event: SessionEvent, needle: string): SearchHit | undefined {
  for (const [raw, where] of sources(event)) {
    // 先收拢空白再找：正文里的换行与缩进会截掉摘录，还会把一段话切成两半（codex 同样先收拢）。
    const text = raw.replace(/\s+/g, ' ').trim();
    const at = text.toLocaleLowerCase().indexOf(needle);
    if (at < 0) continue;
    const outcome = event.result as { spilled?: unknown } | undefined;
    return {
      sessionId: item.id,
      name: item.name,
      seq: event.seq,
      kind: String(event.kind),
      text: excerpt(text, at, needle.length),
      ...(where === 'result' && typeof outcome?.spilled === 'string' ? { spilled: outcome.spilled } : {}),
    };
  }
  return undefined;
}

export async function searchSessions(
  directory: string,
  { query, projectRoot = undefined as string | undefined, limit = SEARCH_LIMIT }: { query: string; projectRoot?: string; limit?: number },
): Promise<SearchHit[]> {
  const needle = query.trim().toLocaleLowerCase();
  const listed = await listSessions(directory, { projectRoot });
  const hits: SearchHit[] = [];
  // 顺序跟着列表：最近动过的那一份先出现。命中按记录里的事件序号从小到大。
  for (const item of listed) {
    let events: SessionEvent[];
    try {
      // ponytail: 列表那一趟已经读过一遍文件，这里为正文再读一遍；上限是 U38 那条扫描代价，
      // 升级路径是给正文建一份索引，或者用随包的 ripgrep 先挑出有命中的那几个文件（codex 走的是这一条）。
      events = parseSessionBytes(await readFile(join(directory, `${item.id}.jsonl`))).events;
    } catch {
      // 读不出来的那一份由列表那一行带着稳定码说清，查找不重复报一次，也不猜它写过什么。
      continue;
    }
    let inThisRecord = 0;
    for (const event of events) {
      if (inThisRecord === PER_RECORD) break;
      const hit = matchIn(item, event, needle);
      if (hit === undefined) continue;
      hits.push(hit);
      inThisRecord += 1;
      if (hits.length === limit) return hits;
    }
  }
  return hits;
}
