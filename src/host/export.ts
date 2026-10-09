// 导出的一整件（方案 6A）：一份记录写成 markdown 并落盘。读记录与补溢出正文由宿主那一次读取交出，
// 这一层只管排版与写文件；界面那一侧只负责由人选定目的地。
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

// 父记录里那条派生结果带着支线自己的 id（D71）；整段溢出到文件时记录里就没有这一格。
export function branchSessionId(record: ExportRecord): string | undefined {
  if (record.kind !== 'tool' || record.tool !== 'subagent') return undefined;
  const id = (record.result?.content as { sessionId?: unknown } | undefined)?.sessionId;
  return typeof id === 'string' && id !== '' ? id : undefined;
}

/** 一份记录写成一份 markdown：每一次工具调用与那一次的结果各成一段，序号留着，回看时能对上 `/show`。 */
export function exportMarkdown(events: readonly ExportRecord[], meta: { id: string; projectRoot?: string; createdAt?: string | null; unfinished?: boolean }): string {
  const lines: string[] = [`# ligule 会话 ${meta.id}`, ''];
  if (meta.projectRoot !== undefined && meta.projectRoot !== '') lines.push(`- 项目根：${meta.projectRoot}`, '');
  if (meta.createdAt !== undefined && meta.createdAt !== null) lines.push(`- 开始：${meta.createdAt}`, '');
  // 记下的末端是那一次读取的末端，不是那一轮结束的地方：这一句让人知道后面还会写。
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
