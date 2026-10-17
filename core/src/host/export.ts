// 将会话记录导出为 Markdown。记录和溢出内容由 Host 读取，此模块负责排版和写文件。
// 用户界面负责选择目标路径。
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** 导出结果中每个文件的状态，包括已写入、目标已存在和写入失败。 */
export interface Exported {
  readonly written: readonly string[];
  readonly skipped: readonly { id: string; path?: string; code: string }[];
  readonly failed: readonly { path: string; code: string }[];
}

export interface ExportRecord {
  readonly kind: string;
  readonly seq?: number;
  readonly raw?: string;
  readonly text?: string;
  readonly tool?: string;
  readonly toolCalls?: readonly { readonly id: string; readonly name: string; readonly args?: Record<string, unknown> }[];
  readonly result?: { readonly content?: unknown; readonly failed?: boolean; readonly code?: string; readonly spilled?: string };
  readonly name?: string;
  readonly layer?: string;
}

const fence = (value: string) => `\`\`\`\n${value.replace(/\n+$/, '')}\n\`\`\``;

// 优先显示结构化结果中的 `text` 字段；其他结果序列化为文本，失败时附带稳定错误码。
function resultBody(record: ExportRecord): string {
  const content = record.result?.content;
  if (typeof content === 'string') return content;
  if (content !== null && typeof content === 'object' && typeof (content as { text?: unknown }).text === 'string') {
    return (content as { text: string }).text;
  }
  return JSON.stringify({ content, code: record.result?.code, spilled: record.result?.spilled }, null, 2);
}

// 派生结果可能将支线 ID 存在溢出文件中，需在读取完整结果后提取。
export function branchSessionId(record: ExportRecord): string | undefined {
  if (record.kind !== 'tool' || record.tool !== 'subagent') return undefined;
  const id = (record.result?.content as { sessionId?: unknown } | undefined)?.sessionId;
  return typeof id === 'string' && id !== '' ? id : undefined;
}

/** 将会话记录写为 Markdown；工具调用及其结果分别成段，并保留事件序号供 `/show` 定位。 */
export function exportMarkdown(events: readonly ExportRecord[], meta: { id: string; projectRoot?: string; createdAt?: string | null; unfinished?: boolean }): string {
  const lines: string[] = [`# ligule 会话 ${meta.id}`, ''];
  if (meta.projectRoot !== undefined && meta.projectRoot !== '') lines.push(`- 项目根：${meta.projectRoot}`, '');
  if (meta.createdAt !== undefined && meta.createdAt !== null) lines.push(`- 开始：${meta.createdAt}`, '');
  // 导出末尾序号表示本次读取的快照边界，不表示会话轮次已结束。
  if (meta.unfinished === true) lines.push('> 导出这一刻这一份会话还在跑：这份文件到记录落到那一条为止，后面写进来的不在这份里。', '');
  for (const record of events) {
    if (record.kind === 'user') lines.push(`## 第 ${record.seq} 条 · 你说`, '', record.raw ?? record.text ?? '', '');
    else if (record.kind === 'reasoning') lines.push(`## 第 ${record.seq} 条 · 推理`, '', record.text ?? '', '');
    else if (record.kind === 'assistant') {
      lines.push(`## 第 ${record.seq} 条 · 模型`, '');
      if (record.text !== undefined && record.text !== '') lines.push(record.text, '');
      for (const call of record.toolCalls ?? []) {
        lines.push(`### 第 ${record.seq} 条的一次调用 · ${call.name}`, '', fence(JSON.stringify(call.args ?? {}, null, 2)), '');
      }
    } else if (record.kind === 'tool') {
      lines.push(`### 第 ${record.seq} 条 · ${record.tool} 的结果`);
      if (record.result?.failed === true) lines.push(`（这一次没做成）${record.result.code === undefined ? '' : ` ${record.result.code}`}`);
      lines.push('', resultBody(record), '');
    } else if (record.kind === 'mode') {
      lines.push(`> 第 ${record.seq} 条：模式 ${record.name}（${record.layer ?? ''}）生效`, '');
    }
    // `session` 首行和 `usage` 事件是元数据，不作为会话内容段落导出。
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/** 导出主会话和各个派生会话；派生文件名包含对应 ID。
 * 主文件写入用户确认的目标路径。已有同名派生文件时不覆盖，并返回 `export_target_exists`。
 * 每个文件单独报告写入结果，并返回主文件路径。 */
export async function writeExport(path: string, main: string, branches: readonly { id: string; text: string }[]): Promise<Exported> {
  await mkdir(dirname(path), { recursive: true });
  const written: string[] = [];
  const skipped: { id: string; path?: string; code: string }[] = [];
  const failed: { path: string; code: string }[] = [];
  try {
    await writeFile(path, main);
    written.push(path);
  } catch (cause) {
    failed.push({ path, code: String((cause as { code?: string }).code ?? 'write_failed') });
  }
  const stem = path.replace(/\.(md|markdown|txt)$/i, '');
  for (const branch of branches) {
    const branchPath = `${stem}.${branch.id}.md`;
    try {
      // 使用独占创建，避免检查路径和写入之间的竞态覆盖已有文件。
      await writeFile(branchPath, branch.text, { flag: 'wx' });
      written.push(branchPath);
    } catch (cause) {
      const code = String((cause as { code?: string }).code ?? 'write_failed');
      // 目标文件已存在时不覆盖其内容。
      if (code === 'EEXIST') skipped.push({ id: branch.id, path: branchPath, code: 'export_target_exists' });
      else failed.push({ path: branchPath, code });
    }
  }
  return { written, skipped, failed };
}
