// 检查点将压缩摘要及其覆盖范围保存在独立文件中，不修改事件日志。
// 读取前根据事件日志重新计算规范化输入和哈希；校验失败时忽略检查点并从日志重建。
// 事件日志是事实来源，检查点损坏不会中断会话恢复。
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionEvent } from './format.js';

export const CHECKPOINT_FORMAT_VERSION = 1;
// 哈希输入包含独立版本号，避免无关记录字段变化使所有检查点失效。
export const CHECKPOINT_INPUT_VERSION = 2;

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

// 仅将参与模型请求重建的事件放入哈希输入；推理和模式事件不属于模型投影。
// 压缩切点和压缩后预算也使用相同事件集合。
export const PROJECTED_KINDS = ['user', 'assistant', 'tool'];

const textOf = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value ?? null));

// 按固定顺序选择重建请求所需字段，排除调用 ID、写入时间和溢出文件名等传输信息。
// 使用位置数组生成稳定输入；格式变化时更新此函数和对应版本号。
function canonicalInput(events: SessionEvent[]): string {
  return JSON.stringify(events
    .filter((event) => PROJECTED_KINDS.includes(String(event.kind)))
    .map((event) => {
      if (event.kind === 'user') return [event.seq, 'user', textOf(event.text)];
      if (event.kind === 'assistant') {
        const calls = (event.toolCalls as { name?: unknown; args?: unknown }[] | undefined) ?? [];
        return [event.seq, 'assistant', textOf(event.text), textOf(event.reasoning), calls.map((call) => [textOf(call?.name), call?.args ?? null])];
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

// 检查点覆盖范围的哈希由该范围内事件重新计算。
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

// 只有范围、哈希和版本全部匹配时才使用检查点；否则返回失败原因并从原始日志生成投影。
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
  // 覆盖范围必须对应连续事件；缺少事件时拒绝使用检查点，即使计算出的哈希偶然匹配。
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
