// 检查点（D75、实现顺序第 36 步）：压缩不改动事件日志，摘要与它顶掉的那一段范围写进同目录下的另一份文件。
// 派生文件随时可以整份作废：投影前按日志里那一段重算规范化输入与前缀哈希，对不上就不读它，从原始日志整段重建。
// 这一份坏了不该停住一次运行，所以这里一条内核自身的故障都不抛——事实源是事件日志，不是它。
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionEvent } from './format.js';

export const CHECKPOINT_FORMAT_VERSION = 1;
// 哈希输入的那一份规范化写法自己带一个版本：给记录加一个无关的外层字段不该让所有旧检查点集体作废（D75）。
export const CHECKPOINT_INPUT_VERSION = 1;

export interface Checkpoint {
  formatVersion: number;
  inputVersion: number;
  sessionId: string;
  fromSeq: number;
  toSeq: number;
  digest: string;
  text: string;
}

export interface CheckpointRead {
  checkpoint: Checkpoint | null;
  reason: string;
}

// 只有参与模型请求重建的那几种事件进输入：推理段不进投影（D32），模式那一条是装配事实而不是对话内容。
const PROJECTED_KINDS = ['user', 'assistant', 'tool'];

const textOf = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value ?? null));

// 参与重建的字段按固定顺序拼进去，一次性的传输身份不进输入（调用 id、写盘时刻、溢出用的文件名）。
// 位置数组而不是对象：拼出来的串只由这一处决定，将来改形状时改的是这个函数与那一格版本号。
function canonicalInput(events: SessionEvent[]): string {
  return JSON.stringify(events
    .filter((event) => PROJECTED_KINDS.includes(String(event.kind)))
    .map((event) => {
      if (event.kind === 'user') return [event.seq, 'user', textOf(event.text)];
      if (event.kind === 'assistant') {
        const calls = (event.toolCalls as { name?: unknown; args?: unknown }[] | undefined) ?? [];
        return [event.seq, 'assistant', textOf(event.text), calls.map((call) => [textOf(call?.name), call?.args ?? null])];
      }
      const result = event.result as { failed?: boolean; code?: unknown; content?: unknown } | undefined;
      return [event.seq, 'tool', textOf(event.tool), result?.failed === true, result?.code ?? null, textOf(result?.content)];
    }));
}

export function prefixDigest(events: SessionEvent[]): string {
  return createHash('sha256').update(canonicalInput(events)).digest('hex');
}

export function checkpointPath(directory: string, id: string): string {
  return join(directory, `${id}.checkpoint.json`);
}

// 检查点说的是「这一段的这些事件我替它们说话」，所以它的哈希就是那一段重算出来的那一份。
export function createCheckpoint({
  id,
  events,
  text,
  fromSeq,
  toSeq,
}: {
  id: string;
  events: SessionEvent[];
  text: string;
  fromSeq: number;
  toSeq: number;
}): Checkpoint {
  return {
    formatVersion: CHECKPOINT_FORMAT_VERSION,
    inputVersion: CHECKPOINT_INPUT_VERSION,
    sessionId: id,
    fromSeq,
    toSeq,
    digest: prefixDigest(events),
    text,
  };
}

// 范围对得上、哈希对得上、版本对得上，这一份才用；任何一条对不上交回 null 与那一条的名字，投影走原始日志。
export function usableCheckpoint(checkpoint: unknown, id: string, events: SessionEvent[]): CheckpointRead {
  const value = checkpoint as Partial<Checkpoint> | null | undefined;
  if (typeof value !== 'object' || value === null) return { checkpoint: null, reason: 'checkpoint_shape' };
  if (value.formatVersion !== CHECKPOINT_FORMAT_VERSION) return { checkpoint: null, reason: 'checkpoint_format_version' };
  if (value.inputVersion !== CHECKPOINT_INPUT_VERSION) return { checkpoint: null, reason: 'checkpoint_input_version' };
  if (value.sessionId !== id) return { checkpoint: null, reason: 'checkpoint_session_mismatch' };
  const { text, digest } = value;
  const fromSeq = value.fromSeq;
  const toSeq = value.toSeq;
  if (typeof text !== 'string' || text === '') return { checkpoint: null, reason: 'checkpoint_text_missing' };
  if (typeof fromSeq !== 'number' || typeof toSeq !== 'number'
    || !Number.isInteger(fromSeq) || !Number.isInteger(toSeq)
    || fromSeq < 0 || fromSeq > toSeq) {
    return { checkpoint: null, reason: 'checkpoint_range_shape' };
  }
  const covered = events.filter((event) => event.seq >= fromSeq && event.seq <= toSeq);
  // 范围里缺号（记录被截过、或者那段根本不在这份日志里）时重算出来的哈希对不上是巧合，对得上才是运气，都不该用。
  if (covered.length !== toSeq - fromSeq + 1) return { checkpoint: null, reason: 'checkpoint_range_missing' };
  if (digest !== prefixDigest(covered)) return { checkpoint: null, reason: 'checkpoint_digest_mismatch' };
  return { checkpoint: value as Checkpoint, reason: '' };
}

export async function loadCheckpoint({ directory, id, events }: {
  directory: string;
  id: string;
  events: SessionEvent[];
}): Promise<CheckpointRead> {
  let bytes: string;
  try {
    bytes = await readFile(checkpointPath(directory, id), 'utf8');
  } catch {
    return { checkpoint: null, reason: 'checkpoint_absent' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes);
  } catch {
    return { checkpoint: null, reason: 'checkpoint_invalid_json' };
  }
  return usableCheckpoint(parsed, id, events);
}
