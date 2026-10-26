// 检查点将压缩块及其覆盖范围保存在独立文件中，不修改事件日志。
// 一个会话的全部压缩块放在同一个文件里，每次写入整体原子替换。
// 读取前根据事件日志重新计算规范化输入和哈希；任一块校验失败时忽略全部块并从日志重建。
// 事件日志是事实来源，检查点损坏不会中断会话恢复。
import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionEvent } from './format.js';

// 版本 1 是单个摘要的旧布局，读取时折算为一个块；版本 2 起保存块列表。
export const CHECKPOINT_FORMAT_VERSION = 2;
// 哈希输入包含独立版本号，避免无关记录字段变化使所有检查点失效。
export const CHECKPOINT_INPUT_VERSION = 2;

export interface CompactionBlock {
  // 会话内单调递增，永不复用；用于界面展示与后续按块操作。
  blockId: number;
  fromSeq: number;
  toSeq: number;
  digest: string;
  text: string;
}

export interface CheckpointFile {
  formatVersion: number;
  inputVersion: number;
  sessionId: string;
  blocks: CompactionBlock[];
}

export interface CheckpointRead {
  blocks: CompactionBlock[];
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
      const result = event.result as { failed?: boolean; code?: unknown; content?: unknown; images?: unknown } | undefined;
      const canonical = [event.seq, 'tool', textOf(event.tool), result?.failed === true, result?.code ?? null, textOf(result?.content)];
      if (result?.images !== undefined) canonical.push(result.images);
      return canonical;
    }));
}

export function prefixDigest(events: SessionEvent[]): string {
  return createHash('sha256').update(canonicalInput(events)).digest('hex');
}

export function checkpointPath(directory: string, id: string): string {
  return join(directory, `${id}.checkpoint.json`);
}

// 块的覆盖范围哈希由该范围内事件重新计算。
export function createBlock({
  events,
  text,
  fromSeq,
  toSeq,
  blockId,
}: {
  events: SessionEvent[];
  text: string;
  fromSeq: number;
  toSeq: number;
  blockId: number;
}): CompactionBlock {
  return { blockId, fromSeq, toSeq, digest: prefixDigest(events), text };
}

export function createCheckpointFile({ id, blocks }: { id: string; blocks: CompactionBlock[] }): CheckpointFile {
  return {
    formatVersion: CHECKPOINT_FORMAT_VERSION,
    inputVersion: CHECKPOINT_INPUT_VERSION,
    sessionId: id,
    blocks,
  };
}

// 块文件是派生数据，写入使用临时文件加原子替换；未完成的写入不会进入读取路径。
export async function writeCheckpointFile(directory: string, id: string, file: CheckpointFile): Promise<void> {
  const target = checkpointPath(directory, id);
  const temporary = `${target}.${randomUUID()}.tmp`;
  let created = false;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    created = true;
    try {
      await handle.writeFile(JSON.stringify(file), 'utf8');
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
    created = false;
  } finally {
    if (created) await rm(temporary, { force: true });
  }
}

interface LegacyCheckpoint {
  formatVersion: number;
  inputVersion: number;
  sessionId: string;
  fromSeq: number;
  toSeq: number;
  digest: string;
  text: string;
}

function blockShape(block: unknown): { block: CompactionBlock } | { reason: string } {
  const value = block as Partial<CompactionBlock> | null;
  if (typeof value !== 'object' || value === null) return { reason: 'checkpoint_range_shape' };
  const { blockId, fromSeq, toSeq, digest, text } = value;
  if (typeof blockId !== 'number' || !Number.isInteger(blockId) || blockId < 1) return { reason: 'checkpoint_block_ids' };
  if (typeof fromSeq !== 'number' || typeof toSeq !== 'number'
    || !Number.isInteger(fromSeq) || !Number.isInteger(toSeq)
    || fromSeq < 0 || fromSeq > toSeq) return { reason: 'checkpoint_range_shape' };
  if (typeof digest !== 'string') return { reason: 'checkpoint_digest_mismatch' };
  if (typeof text !== 'string' || text === '') return { reason: 'checkpoint_text_missing' };
  return { block: { blockId, fromSeq, toSeq, digest, text } };
}

// 只有范围、哈希和版本全部匹配时才使用块；否则返回失败原因并从原始日志生成投影。
// 块必须按范围升序排列且互不重叠，保证投影中每段历史最多由一个摘要代表。
export function usableCheckpointFile(value: unknown, id: string, events: SessionEvent[]): CheckpointRead {
  if (typeof value !== 'object' || value === null) return { blocks: [], reason: 'checkpoint_shape' };
  const file = value as Partial<CheckpointFile> & Partial<LegacyCheckpoint>;
  if (file.sessionId !== id) return { blocks: [], reason: 'checkpoint_session_mismatch' };
  if (file.inputVersion !== CHECKPOINT_INPUT_VERSION) return { blocks: [], reason: 'checkpoint_input_version' };
  // 版本 1 的旧文件只保存一个摘要；折算为块后按同一规则校验。
  if (file.formatVersion === 1) {
    const legacy = blockShape({ blockId: 1, fromSeq: file.fromSeq, toSeq: file.toSeq, digest: file.digest, text: file.text });
    if ('reason' in legacy) return { blocks: [], reason: legacy.reason };
    return usableBlocks([legacy.block], events);
  }
  if (file.formatVersion !== CHECKPOINT_FORMAT_VERSION) return { blocks: [], reason: 'checkpoint_format_version' };
  if (!Array.isArray(file.blocks) || file.blocks.length === 0) return { blocks: [], reason: 'checkpoint_blocks_empty' };
  const shaped: CompactionBlock[] = [];
  for (const block of file.blocks) {
    const parsed = blockShape(block);
    if ('reason' in parsed) return { blocks: [], reason: parsed.reason };
    shaped.push(parsed.block);
  }
  return usableBlocks(shaped, events);
}

function usableBlocks(blocks: CompactionBlock[], events: SessionEvent[]): CheckpointRead {
  let previous: CompactionBlock | undefined;
  for (const block of blocks) {
    if (previous !== undefined && block.fromSeq <= previous.toSeq) {
      return { blocks: [], reason: 'checkpoint_block_overlap' };
    }
    if (block.blockId <= (previous?.blockId ?? 0)) {
      return { blocks: [], reason: 'checkpoint_block_ids' };
    }
    const covered = events.filter((event) => event.seq >= block.fromSeq && event.seq <= block.toSeq);
    // 覆盖范围必须对应连续事件；缺少事件时拒绝使用块，即使计算出的哈希偶然匹配。
    if (covered.length !== block.toSeq - block.fromSeq + 1) return { blocks: [], reason: 'checkpoint_range_missing' };
    if (block.digest !== prefixDigest(covered)) return { blocks: [], reason: 'checkpoint_digest_mismatch' };
    previous = block;
  }
  return { blocks, reason: '' };
}

export async function loadCheckpointFile({ directory, id, events }: {
  directory: string;
  id: string;
  events: SessionEvent[];
}): Promise<CheckpointRead> {
  let bytes: string;
  try {
    bytes = await readFile(checkpointPath(directory, id), 'utf8');
  } catch {
    return { blocks: [], reason: 'checkpoint_absent' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes);
  } catch {
    return { blocks: [], reason: 'checkpoint_invalid_json' };
  }
  return usableCheckpointFile(parsed, id, events);
}
