// 会话记录 → 界面行的投影。记录是事实源（I5），这里只画已经落盘的那一份与流式期间的那半截；
// 后端的记录形状在 `src/session/session.js` 与 `src/kernel/loop.js`，界面这一侧不认识别的。

export type ToolCall = { id: string; name: string; args?: Record<string, unknown> };

export type Record_ = {
  seq?: number;
  kind: string;
  text?: string;
  // 模板展开过的那一条用户记录另留着人打的那一行（D54）：画的是这一份，交给模型的是 text。
  raw?: string;
  toolCalls?: ToolCall[];
  tool?: string;
  callId?: string;
  result?: { kind?: string; failed?: boolean; code?: string; reason?: string; content?: unknown };
};

export type Row = {
  id: number;
  kind: 'question' | 'answer' | 'reasoning' | 'call' | 'result' | 'refusal' | 'failure' | 'meta' | 'error';
  text: string;
  tool?: string;
  code?: string;
  callId?: string;
};

// 工具结果的内容可以是串，也可以是结构化的一段（read 交回的是 {text: ...}）。
export function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  return JSON.stringify(value, null, 2);
}

let sequence = 0;
const nextId = (): number => (sequence += 1);

export function metaRow(kind: 'meta' | 'error', text: string): Row {
  return { id: nextId(), kind, text };
}

export function projectRecord(record: Record_): Row[] {
  if (record.kind === 'user') return [{ id: nextId(), kind: 'question', text: record.raw ?? record.text ?? '' }];
  if (record.kind === 'reasoning') return [{ id: nextId(), kind: 'reasoning', text: record.text ?? '' }];
  if (record.kind === 'assistant') {
    const rows: Row[] = record.text === '' || record.text === undefined
      ? []
      : [{ id: nextId(), kind: 'answer', text: record.text }];
    for (const call of record.toolCalls ?? []) {
      rows.push({ id: nextId(), kind: 'call', tool: call.name, text: JSON.stringify(call.args ?? {}, null, 2), callId: call.id });
    }
    return rows;
  }
  if (record.kind === 'tool') {
    const result = record.result ?? {};
    const kind = result.failed !== true ? 'result' : result.kind === 'refusal' ? 'refusal' : 'failure';
    return [{
      id: nextId(),
      kind,
      tool: record.tool,
      code: result.code,
      callId: record.callId,
      text: textOf(result.reason ?? result.content),
    }];
  }
  return [];
}
