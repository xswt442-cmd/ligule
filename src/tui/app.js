// 终端界面的行与状态（D33 的第二种客户端）。这里不读帧也不写帧：帧由 src/host/connection.js 那一层交进来，
// 这一层只把会话记录与流式增量画成行。行投影（projectRecord）是纯函数，检查在 test/tui.test.js。
import { createElement as h, Fragment, useCallback, useEffect, useState } from 'react';
import { Box, Static, Text, useApp, useInput } from 'ink';

const LABELS = {
  user: '你',
  assistant: '助手',
  reasoning: '推理',
  tool: '工具',
};

// 一条记录画成一行或者几行：助手那一条可能带着若干次工具调用，工具调用与结果各占一行。
export function projectRecord(record) {
  if (record.kind === 'user') return [{ kind: 'question', text: record.text }];
  if (record.kind === 'reasoning') return [{ kind: 'reasoning', text: record.text }];
  if (record.kind === 'assistant') {
    const rows = record.text === '' ? [] : [{ kind: 'answer', text: record.text }];
    for (const call of record.toolCalls ?? []) rows.push({ kind: 'call', tool: call.name, text: JSON.stringify(call.args ?? {}) });
    return rows;
  }
  if (record.kind === 'tool') {
    const failed = record.result?.failed === true;
    return [{
      kind: failed ? 'failure' : 'result',
      tool: record.tool,
      text: record.result?.reason ?? record.result?.content ?? '',
      code: record.result?.code,
    }];
  }
  return [];
}

function Row({ row }) {
  if (row.kind === 'question') return h(Text, { color: 'cyan' }, `› ${row.text}`);
  if (row.kind === 'reasoning') return h(Text, { dimColor: true, wrap: 'truncate-end' }, `· 推理 ${row.text}`);
  if (row.kind === 'answer') return h(Text, { wrap: 'wrap' }, row.text);
  if (row.kind === 'call') return h(Text, { color: 'yellow' }, `→ ${row.tool} ${row.text}`);
  if (row.kind === 'result') return h(Text, { color: 'green' }, `✓ ${row.tool} ${row.text}`);
  if (row.kind === 'failure') return h(Text, { color: 'red' }, `✗ ${row.tool} ${row.code ?? ''} ${row.text}`);
  if (row.kind === 'meta') return h(Text, { dimColor: true }, `· ${row.text}`);
  return h(Text, { color: 'red' }, `! ${row.text}`);
}

export function App({ client, sessionId, interactive = true }) {
  const app = useApp();
  const [rows, setRows] = useState([]);
  const [live, setLive] = useState({ text: '', reasoning: '' });
  const [ask, setAsk] = useState(null);
  const [running, setRunning] = useState(false);
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState(null);

  const push = useCallback((...added) => setRows((current) => [...current, ...added]), []);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await client.request('status.get', { sessionId }));
    } catch {
      // 状态读不到不影响这一轮本身，底部那一行留着上一次的读数。
    }
  }, [client, sessionId]);

  useEffect(() => {
    const onNotification = (message) => {
      if (message.sessionId !== sessionId) return;
      if (message.notify === 'delta') {
        const piece = message.event?.text ?? '';
        if (message.event?.type === 'text') setLive((current) => ({ ...current, text: current.text + piece }));
        else if (message.event?.type === 'reasoning') setLive((current) => ({ ...current, reasoning: current.reasoning + piece }));
        return;
      }
      if (message.notify === 'event') {
        // 刚落盘的那一条取代流式期间的那半截：记录是事实源（I5），界面按它重画。
        if (message.event?.kind === 'assistant') setLive((current) => ({ ...current, text: '' }));
        if (message.event?.kind === 'reasoning') setLive((current) => ({ ...current, reasoning: '' }));
        push(...projectRecord(message.event));
        return;
      }
      if (message.notify === 'fault') push({ kind: 'error', text: `${message.code}：${message.detail ?? ''}` });
    };
    const onRequest = (message) => {
      if (message.method !== 'approval.request' || message.params.sessionId !== sessionId) return;
      setAsk({
        id: message.id,
        tool: message.params.tool,
        detail: message.params.command ?? JSON.stringify(message.params.args ?? {}),
        reason: message.params.reason ?? '',
      });
    };
    client.onNotification(onNotification);
    client.onRequest(onRequest);
    void refreshStatus();
  }, [client, push, refreshStatus, sessionId]);

  const submit = useCallback(async (text) => {
    setDraft('');
    setRunning(true);
    try {
      const result = await client.request('run.start', { sessionId, input: text });
      const extra = result.completedBy === undefined ? '' : `，由 ${result.completedBy} 收尾`;
      push({ kind: 'meta', text: `本轮结束：${result.iterations} 次迭代、${result.modelCalls} 次模型调用${extra}` });
    } catch (error) {
      push({ kind: 'error', text: `${error.code ?? ''} ${error.detail ?? error.message ?? ''}`.trim() });
    } finally {
      setAsk(null);
      setRunning(false);
      void refreshStatus();
    }
  }, [client, push, refreshStatus, sessionId]);

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      app.exit();
      return;
    }
    if (ask !== null) {
      if (input === 'y' || input === 'Y') {
        const asked = ask;
        setAsk(null);
        push({ kind: 'meta', text: `已允许 ${asked.tool}` });
        client.reply(asked.id, { decision: 'allow' });
      } else if (input === 'n' || input === 'N') {
        const asked = ask;
        setAsk(null);
        push({ kind: 'meta', text: `已不允许 ${asked.tool}` });
        client.reply(asked.id, { decision: 'deny' });
      }
      return;
    }
    if (key.escape && running) {
      void client.request('run.cancel', { sessionId }).catch((error) => push({ kind: 'error', text: error.code ?? 'run_cancel_failed' }));
      return;
    }
    if (key.return) {
      if (key.shift) setDraft((current) => `${current}\n`);
      else if (draft.trim() !== '') void submit(draft.trim());
      return;
    }
    if (key.backspace || key.delete) setDraft((current) => current.slice(0, -1));
    else if (input !== '' && !key.ctrl && !key.meta) setDraft((current) => current + input);
  // 没有真终端时不开这一路：Ink 在拿不到 raw mode 的输入上是报错而不是降级（检查里就传 interactive: false）。
  }, { isActive: interactive });

  const tail = live.reasoning.split('\n').slice(-2).join(' ');

  return h(Fragment, null,
    h(Static, { items: rows }, (row, index) => h(Box, { key: index }, h(Row, { row }))),
    live.reasoning === '' ? null : h(Text, { dimColor: true }, `· 推理 ${tail}`),
    live.text === '' ? null : h(Text, { wrap: 'wrap' }, live.text),
    ask === null ? null : h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'yellow', paddingX: 1 },
      h(Text, { bold: true }, `要执行 ${ask.tool} ${ask.detail}`),
      ask.reason === '' ? null : h(Text, { dimColor: true }, ask.reason),
      h(Text, null, '按 y 允许一次，按 n 不允许')),
    h(Box, { marginTop: 1 },
      h(Text, { color: running ? 'yellow' : 'cyan' }, running ? '⏺ ' : '› '),
      h(Text, null, draft),
      running ? h(Text, { dimColor: true }, '  （Esc 取消本轮）') : null),
    h(Text, { dimColor: true }, status === null
      ? `会话 ${sessionId.slice(0, 8)} · Enter 发送，Shift+Enter 换行，Ctrl+C 退出`
      : `会话 ${sessionId.slice(0, 8)} · 档位 ${status.mode} · 工具 ${status.tools.length} 件 · 记录 ${status.eventCount} 条 · Enter 发送，Ctrl+C 退出`),
  );
}
