// 交出去的那两样文本：导出的那一份 markdown，与终端标题上那一串（D81 边界二：两处都不写进会话记录）。
// 内容一律来自 `session.read` 交回的那份记录，这一层只负责排版与落盘。
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

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

// 结果那一段给人看的是正文：结构化那一格取 `text`，其余整份写出来，失败时补上稳定码。
function resultBody(record: ExportRecord): string {
  const content = record.result?.content;
  if (typeof content === 'string') return content;
  if (content !== null && typeof content === 'object' && typeof (content as { text?: unknown }).text === 'string') {
    return (content as { text: string }).text;
  }
  return JSON.stringify({ content, code: record.result?.code, spilled: record.result?.spilled }, null, 2);
}

/** 一份记录写成一份 markdown：每一次工具调用与那一次的结果各成一段，序号留着，回看时能对上 `/show`。 */
export function exportMarkdown(events: readonly ExportRecord[], meta: { id: string; projectRoot?: string; createdAt?: string | null }): string {
  const lines: string[] = [`# ligule 会话 ${meta.id}`, ''];
  if (meta.projectRoot !== undefined && meta.projectRoot !== '') lines.push(`- 项目根：${meta.projectRoot}`, '');
  if (meta.createdAt !== undefined && meta.createdAt !== null) lines.push(`- 开始：${meta.createdAt}`, '');
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
    // `session` 首行与 `usage` 那一条是元信息与读数，不作为一段：那份文件给人读历史，不是给人读表格。
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/** 导出的那几份文件：主干一份，每一条派生支线另写一份，文件名里带着那条支线自己的 id。 */
export async function writeExport(path: string, main: string, branches: readonly { id: string; text: string }[]): Promise<string[]> {
  await mkdir(dirname(path), { recursive: true });
  const written = [path];
  await writeFile(path, main);
  const stem = path.replace(/\.(md|markdown|txt)$/i, '');
  for (const branch of branches) {
    const branchPath = `${stem}.${branch.id}.md`;
    await writeFile(branchPath, branch.text);
    written.push(branchPath);
  }
  return written;
}

// 标题那一串来自模型名与项目根这类位置，去掉能终止转义序列的控制字符与双向格式码：
// 一串带 ESC 或 BEL 的文本写进标题就等于在替这个终端写它自己的指令。
const CONTROL = /[\u0000-\u001F\u007F-\u009F\u200E-\u200F\u202A-\u202E\u2066-\u2069]/g;

export function titleText({ model, boundary, sessionId }: { model?: string; boundary?: string; sessionId: string }): string {
  const parts = [model, boundary, sessionId.slice(0, 8)].filter((part) => typeof part === 'string' && part !== '');
  return parts.join(' · ').replace(CONTROL, '').slice(0, 120);
}

/** 终端标题走 OSC 那一条：`\x1B]0;<那一串>\x1B\\`。收尾用 ST 而不是 BEL，与那一串里可能有的字符都不冲突。 */
export function titleEscape(title: string): string {
  return `\u001B]0;${title}\u001B\\`;
}
