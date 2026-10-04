// 终端界面的行、输入与状态（D33 的第二种客户端）。这里不读帧也不写帧：帧由 src/host/connection.js 那一层交进来，
// 这一层只把会话记录与流式增量画成行，并把按键变成协议里的调用。
// 纯函数（parseInput、editDraft、foldText、projectRecord、branchOf、detailTitle）都从这里交出去，检查在 test/tui.test.js，
// 不靠真终端也能验；画面本身跑 `ligule tui` 看。
import { createElement as h, Fragment, useCallback, useEffect, useState } from 'react';
import { Box, Static, Text, useApp, useInput } from 'ink';

const SPINNER = ['⠋', '⠙', '', '⠸', '⠼', '⠴', '⠦', '', '⠇', '⠏'];
const FOLD_LINES = 3;
// 模式来自哪一层，画给人看的是中文，记录里那三个名字与装载那一侧一致（D43）。
const MODE_LAYERS = { shipped: '随包', user: '全局', project: '项目' };

export const COMMANDS = [
  { name: 'help', usage: '/help', text: '列出命令与按键' },
  { name: 'tools', usage: '/tools', text: '列出这次运行装了哪些工具' },
  { name: 'status', usage: '/status', text: '显示模式、档位、拒绝计数与记录条数' },
  { name: 'mode', usage: '/mode [名字]', text: '显示当前模式，或切换到另一个名字' },
  { name: 'show', usage: '/show [序号]', text: '把记录里那一条的完整内容画出来，不带序号收起' },
  { name: 'sub', usage: '/sub [序号]', text: '画出那一次派生执行的整份支线记录，不带序号收起' },
  { name: 'new', usage: '/new', text: '开一份新会话，画面上方的历史留在终端里' },
  { name: 'quit', usage: '/quit', text: '退出（Ctrl+C 同样）' },
];

// 一段输入要么是斜杠命令，要么是要交给模型的话。命令只认第一个词，其余算参数。
export function parseInput(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return { kind: 'text', text: trimmed };
  const [name, ...rest] = trimmed.slice(1).split(/\s+/);
  return { kind: 'command', name: name.toLowerCase(), argument: rest.join(' ') };
}

// 草稿的编辑：左右移光标、Home/End 与 Ctrl+A/E 跳两端、Ctrl+W 删前一个词、Ctrl+U 清空、其余可打印字符插在光标处。
export function editDraft(draft, caret, input, key) {
  if (key.leftArrow) return { draft, caret: Math.max(0, caret - 1) };
  if (key.rightArrow) return { draft, caret: Math.min(draft.length, caret + 1) };
  if (key.home || (key.ctrl && input === 'a')) return { draft, caret: 0 };
  if (key.end || (key.ctrl && input === 'e')) return { draft, caret: draft.length };
  if (key.ctrl && input === 'u') return { draft: '', caret: 0 };
  if (key.ctrl && input === 'w') {
    // 先跳过光标前的空白，再删一个词：连着空白一起删会让「rm -rf  」整段消失。
    const head = draft.slice(0, caret).replace(/\s+$/, '').replace(/[\w.\-/]+\s*$/, '');
    return { draft: head + draft.slice(caret), caret: head.length };
  }
  if (key.backspace || key.delete) {
    if (caret === 0) return { draft, caret };
    return { draft: draft.slice(0, caret - 1) + draft.slice(caret), caret: caret - 1 };
  }
  if (input === '' || key.ctrl || key.meta) return { draft, caret };
  return { draft: draft.slice(0, caret) + input + draft.slice(caret), caret: caret + input.length };
}

// 工具结果的内容可以是串，也可以是结构化的一段（read 交回的是 {text: ...}）；界面这一处只画文本。
const textOf = (value) => (typeof value === 'string' ? value : JSON.stringify(value ?? '', null, 2));

// 长内容默认折起来：行数与字数各给一个上限，剩下的一行说明还有多少字（Ctrl+O 展开）。
// 只按行数折的话，一段没有换行的 JSON 会整块压在屏幕上。
export function foldText(text, expanded, limit = FOLD_LINES, maxChars = 400) {
  const full = textOf(text);
  if (expanded === true) return { shown: full, hidden: 0 };
  const lines = full.split('\n');
  const shown = lines.length > limit ? lines.slice(0, limit).join('\n') : full;
  const cut = shown.length > maxChars ? shown.slice(0, maxChars) : shown;
  return { shown: cut, hidden: full.length - cut.length };
}

// 一条记录画成一行或者几行：助手那一条可能带着若干次工具调用，工具调用与结果各占一行。
export function projectRecord(record) {
  // 人打的那一行原样画出来（D54）：展开后的那一份是给模型的，回看时要对得上当时敲了什么。
  if (record.kind === 'user') return [{ kind: 'question', text: record.raw ?? record.text }];
  if (record.kind === 'reasoning') return [{ kind: 'reasoning', text: record.text }];
  if (record.kind === 'assistant') {
    const rows = record.text === '' ? [] : [{ kind: 'answer', text: record.text }];
    for (const call of record.toolCalls ?? []) rows.push({ kind: 'call', tool: call.name, text: JSON.stringify(call.args ?? {}) });
    return rows;
  }
  if (record.kind === 'tool') {
    const result = record.result ?? {};
    const kind = result.failed !== true ? 'result' : result.kind === 'refusal' ? 'refusal' : 'failure';
    return [{ kind, tool: record.tool, text: textOf(result.reason ?? result.content), code: result.code }];
  }
  if (record.kind === 'mode') {
    // 模式生效是一件会改变模型能做什么的事，画在转录里，让人看得见是哪一条输入之后换的（I5）。
    return [{ kind: 'meta', text: `模式 ${record.name}（${MODE_LAYERS[record.layer] ?? record.layer}）生效：${record.tools.join('、')}` }];
  }
  return [];
}

// 状态行里模式与判定档位各带一个前缀：`mode` 这一个词在界面上指过两样东西，写清楚比省字重要（D40）。
// 待生效写成 `mode:minimal→full`。宽度不够时先去掉工具数——它是模式与档位的推论，那两样才说得出这一轮能做什么。
export function buildStatusLine({ head, sessionId, boundary, status, running, seconds, expanded, columns }) {
  const base = `${head}会话 ${sessionId.slice(0, 8)}${boundary === undefined ? '' : ` · ${boundary}`}`;
  if (status === null) return base;
  const parts = [`mode:${status.pendingMode === null ? status.mode ?? 'none' : `${status.mode}→${status.pendingMode}`}`,
    `policy:${status.policy}`, `tools:${status.tools.length}`];
  const tail = `记录 ${status.eventCount} 条`
    + (running ? ` · ${Math.floor(seconds)} 秒，Esc 打断` : '')
    + (expanded ? ' · 已展开（Ctrl+O 收起）' : '');
  const line = (kept) => `${base} · ${kept.join('  ')} · ${tail}`;
  // 列数读不到时不裁：宁可让终端自己折行，也不要按一个猜的宽度丢东西。
  if (columns !== undefined && columns > 0 && line(parts).length > columns) parts.pop();
  return line(parts);
}

// `/show` 要的是记录里那个稳定的序号，不是画面上的第几行：行会随投影变，序号不会（D40）。
export function findRecord(events, argument) {
  const seq = Number(argument);
  if (!Number.isInteger(seq) || seq < 0) return { code: 'tui_show_needs_a_number' };
  return { record: events.find((event) => event.seq === seq) ?? null };
}

// `/sub` 用的也是同一套序号，指向父记录里那条派生结果：支线会话 id 写在那一条的结果内容里（D71），
// 界面不猜文件名，也不为支线多要一次别的动作（D74）。
export function branchOf(record) {
  if (record?.kind !== 'tool' || record.tool !== 'subagent') return { code: 'tui_sub_needs_a_branch' };
  const sessionId = record.result?.content?.sessionId;
  // 结果内容超过注入上限时整段溢出到文件（I6），那一条记录里就没有 sessionId 这一格。
  if (typeof sessionId !== 'string' || sessionId === '') {
    return { code: 'tui_sub_reference_spilled', spilled: record.result?.spilled };
  }
  return { sessionId };
}

// 那一格的标题先说清画的是哪一条线：主干与支线各有一套序号，混着看读出来的是错的因果（D74）。
export function detailTitle(detail) {
  if (detail.branch === undefined) return `记录 ${detail.seq}（${detail.kind}）的完整内容 · /show 收起`;
  return `支线 ${detail.branch}，父记录第 ${detail.seq} 那一次派生 · 这里的序号是支线自己的 · /sub 收起`;
}

function Row({ row, expanded }) {
  if (row.kind === 'question') return h(Text, { color: 'cyan' }, `› ${row.text}`);
  if (row.kind === 'reasoning') {
    const folded = foldText(row.text, expanded, 1);
    return h(Fragment, null,
      h(Text, { dimColor: true, wrap: 'truncate-end' }, `· 推理 ${folded.shown}`),
      folded.hidden > 0 ? h(Text, { dimColor: true }, `  …还有 ${folded.hidden} 字推理，Ctrl+O 展开`) : null);
  }
  if (row.kind === 'answer') return h(Text, { wrap: 'wrap' }, row.text);
  if (row.kind === 'call') return h(Text, { color: 'yellow' }, `→ ${row.tool} ${foldText(row.text, expanded, 1).shown}`);
  if (row.kind === 'result') {
    const folded = foldText(row.text, expanded);
    return h(Fragment, null,
      h(Text, { color: 'green' }, `✓ ${row.tool}`),
      folded.shown === '' ? null : h(Text, { dimColor: true, wrap: 'truncate-end' }, folded.shown),
      folded.hidden > 0 ? h(Text, { dimColor: true }, `  …还有 ${folded.hidden} 字输出，Ctrl+O 展开`) : null);
  }
  if (row.kind === 'refusal') return h(Text, { color: 'magenta' }, `✗ ${row.tool} 没让做（${row.code}）`);
  if (row.kind === 'failure') return h(Text, { color: 'red' }, `✗ ${row.tool} ${row.code ?? ''} ${row.text}`);
  if (row.kind === 'meta') return h(Text, { dimColor: true }, `· ${row.text}`);
  return h(Text, { color: 'red' }, `! ${row.text}`);
}

export function App({ client, sessionId: firstSessionId, info = {}, interactive = true, stdout }) {
  const app = useApp();
  const [sessionId, setSessionId] = useState(firstSessionId);
  const [rows, setRows] = useState([]);
  const [live, setLive] = useState({ text: '', reasoning: '' });
  const [ask, setAsk] = useState(null);
  const [running, setRunning] = useState(false);
  const [tick, setTick] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState('');
  const [caret, setCaret] = useState(0);
  const [history, setHistory] = useState([]);
  const [historyAt, setHistoryAt] = useState(-1);
  const [status, setStatus] = useState(null);
  // 详情画在动态区里：`Static` 不回画已提交的行，所以「看那一条」只能是把它再画一次（D39、D40）。
  const [detail, setDetail] = useState(null);

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
        // 用哪一种语法判的、跑的是哪一个可执行文件：答的是这一条命令，看得见的该是这两样（D59）。
        backend: message.params.shell === undefined ? '' : `${message.params.shell} · ${message.params.executable ?? ''}`,
      });
    };
    client.onNotification(onNotification);
    client.onRequest(onRequest);
    void refreshStatus();
  }, [client, push, refreshStatus, sessionId]);

  // 跑着的时候走一个计时器：一格转圈、一秒一格，Esc 能打断这件事要看得见。
  useEffect(() => {
    if (!running) {
      setSeconds(0);
      return undefined;
    }
    const timer = setInterval(() => {
      setTick((current) => current + 1);
      setSeconds((current) => current + 0.2);
    }, 200);
    return () => clearInterval(timer);
  }, [running]);

  const submit = useCallback(async (text) => {
    setRunning(true);
    try {
      const result = await client.request('run.start', { sessionId, input: text });
      const extra = result.completedBy === undefined ? '' : `，由 ${result.completedBy} 收尾`;
      push({ kind: 'meta', text: `本轮结束：${result.iterations} 次迭代、${result.modelCalls} 次模型调用${extra}` });
    } catch (error) {
      const code = error.code ?? 'run_failed';
      if (code === 'loop_cancelled') push({ kind: 'meta', text: '这一轮已被打断' });
      else push({ kind: 'error', text: `${code}：${error.detail ?? error.message ?? ''}` });
    } finally {
      setAsk(null);
      setRunning(false);
      void refreshStatus();
    }
  }, [client, push, refreshStatus, sessionId]);

  // 命令一律收到第一个词，后面的整段作为参数交进来（/mode 要用）。
  const runCommand = useCallback((name, argument = '') => {
    if (name === 'quit') {
      app.exit();
      return;
    }
    if (name === 'new') {
      void (async () => {
        try {
          const created = await client.request('session.create', {});
          setSessionId(created.sessionId);
          setRows([]);
          setLive({ text: '', reasoning: '' });
          push({ kind: 'meta', text: `新会话 ${created.sessionId.slice(0, 8)}` });
        } catch (error) {
          push({ kind: 'error', text: `会话开不出来：${error.code ?? error.message}` });
        }
      })();
      return;
    }
    if (name === 'tools') {
      void (async () => {
        const current = await client.request('status.get', { sessionId }).catch(() => null);
        setStatus(current);
        push({ kind: 'meta', text: current === null ? '状态读不到' : `工具：${current.tools.join('、')}` });
      })();
      return;
    }
    if (name === 'status') {
      void (async () => {
        const current = await client.request('status.get', { sessionId }).catch(() => null);
        setStatus(current);
        push({ kind: 'meta', text: current === null ? '状态读不到'
          : `模式 ${current.mode ?? '没装'} · 档位 ${current.policy} · 拒绝 连续 ${current.denials.consecutive} 次 / 累计 ${current.denials.total} 次 · 记录 ${current.eventCount} 条` });
      })();
      return;
    }
    if (name === 'mode') {
      void (async () => {
        // 带名字就是一次切换请求，不带名字只是问一句现在用的是哪一份（D41）。
        if (argument === '') {
          const current = await client.request('status.get', { sessionId }).catch(() => null);
          setStatus(current);
          push({ kind: 'meta', text: current === null || current.mode === null ? '模式读不到'
            : `当前 ${current.mode}${current.pendingMode === null ? '' : `，下一个 ${current.pendingMode}（待生效）`}` });
          return;
        }
        const switched = await client.request('mode.set', { sessionId, name: argument }).catch((error) => error);
        if (switched.code !== undefined) {
          push({ kind: 'error', text: `切不过去：${switched.code}${switched.detail === undefined ? '' : ` · ${switched.detail}`}` });
          return;
        }
        setStatus(await client.request('status.get', { sessionId }).catch(() => null));
        push({ kind: 'meta', text: switched.pending === null
          ? `模式切到 ${switched.mode}（${switched.tools.length} 件工具）`
          : `已请求切到 ${switched.pending}，这一轮结束才生效；再打一次 /mode ${switched.mode} 可以撤回` });
      })();
      return;
    }
    if (name === 'show') {
      void (async () => {
        if (argument === '') {
          setDetail(null);
          return;
        }
        const read = await client.request('session.read', { sessionId }).catch((error) => error);
        if (read.code !== undefined) {
          push({ kind: 'error', text: `记录读不回来：${read.code}` });
          return;
        }
        const picked = findRecord(read.events, argument);
        if (picked.code !== undefined) {
          push({ kind: 'error', text: '/show 后面要一个记录序号（会话记录里的第几条，不是画面上的第几行）' });
          return;
        }
        if (picked.record === null) {
          push({ kind: 'error', text: `记录里没有第 ${argument} 条（现有 ${read.events.length} 条，编号从 0 起）` });
          return;
        }
        setDetail({ seq: picked.record.seq, kind: picked.record.kind, rows: projectRecord(picked.record) });
      })();
      return;
    }
    if (name === 'sub') {
      void (async () => {
        if (argument === '') {
          setDetail(null);
          return;
        }
        const parent = await client.request('session.read', { sessionId }).catch((error) => error);
        if (parent.code !== undefined) {
          push({ kind: 'error', text: `记录读不回来：${parent.code}` });
          return;
        }
        const picked = findRecord(parent.events, argument);
        if (picked.code !== undefined) {
          push({ kind: 'error', text: '/sub 后面要一个记录序号（父记录里那条 subagent 结果的序号）' });
          return;
        }
        if (picked.record === null) {
          push({ kind: 'error', text: `记录里没有第 ${argument} 条（现有 ${parent.events.length} 条，编号从 0 起）` });
          return;
        }
        const branch = branchOf(picked.record);
        if (branch.code === 'tui_sub_needs_a_branch') {
          push({ kind: 'error', text: `第 ${argument} 条不是一次派生执行的结果（要的是 subagent 那一条）` });
          return;
        }
        if (branch.code === 'tui_sub_reference_spilled') {
          push({ kind: 'error', text: `那一次派生的结果内容溢出在 ${branch.spilled ?? '文件里'}，记录里没有支线 id` });
          return;
        }
        // 支线那份走的是同一次读记录的动作：它不在这轮的内核里，但它是同一目录下的另一份会话记录（D74）。
        const read = await client.request('session.read', { sessionId: branch.sessionId }).catch((error) => error);
        if (read.code !== undefined) {
          push({ kind: 'error', text: `支线记录读不回来：${read.code}` });
          return;
        }
        setDetail({
          seq: picked.record.seq,
          kind: 'subagent',
          branch: branch.sessionId,
          rows: read.events.flatMap((event) => projectRecord(event)),
        });
      })();
      return;
    }
    if (name === 'help') {
      push({ kind: 'meta', text: COMMANDS.map((command) => `${command.usage} —— ${command.text}`).join('\n') });
      return;
    }
    push({ kind: 'error', text: `没有这条命令：/${name}（/help 看列表）` });
  }, [app, client, push, sessionId]);

  const send = useCallback((text) => {
    const parsed = parseInput(text);
    setDraft('');
    setCaret(0);
    setHistoryAt(-1);
    if (parsed.kind === 'command') {
      push({ kind: 'meta', text: `/${parsed.name}` });
      runCommand(parsed.name === '' ? 'help' : parsed.name, parsed.argument);
      return;
    }
    setHistory((current) => [parsed.text, ...current].slice(0, 50));
    void submit(parsed.text);
  }, [push, runCommand, submit]);

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      app.exit();
      return;
    }
    if (key.ctrl && input === 'o') {
      setExpanded((current) => !current);
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
    if (key.escape) {
      if (running) void client.request('run.cancel', { sessionId }).catch((error) => push({ kind: 'error', text: error.code ?? 'run_cancel_failed' }));
      return;
    }
    if (key.upArrow || key.downArrow) {
      if (history.length === 0) return;
      // 只在单行草稿上翻历史：草稿里已经有换行时上下键留给光标。
      if (draft.includes('\n')) return;
      const next = key.upArrow ? Math.min(historyAt + 1, history.length - 1) : Math.max(historyAt - 1, -1);
      setHistoryAt(next);
      const recalled = next < 0 ? '' : history[next];
      setDraft(recalled);
      setCaret(recalled.length);
      return;
    }
    if (key.return) {
      if (key.shift) {
        const inserted = draft.slice(0, caret) + '\n' + draft.slice(caret);
        setDraft(inserted);
        setCaret(caret + 1);
        return;
      }
      if (draft.trim() !== '') send(draft);
      return;
    }
    const edited = editDraft(draft, caret, input, key);
    setDraft(edited.draft);
    setCaret(edited.caret);
  // 没有真终端时不开这一路：Ink 在拿不到 raw mode 的输入上是报错而不是降级（检查里就传 interactive: false）。
  }, { isActive: interactive });

  const head = info.model === undefined ? '' : `${info.model} · `;
  const foldedLive = foldText(live.reasoning, expanded, 1);

  return h(Fragment, null,
    h(Static, { items: rows }, (row, index) => h(Box, { key: index, flexDirection: 'column' }, h(Row, { row, expanded }))),
    foldedLive.shown === '' ? null : h(Text, { dimColor: true, wrap: 'truncate-end' }, `· 推理 ${foldedLive.shown}${foldedLive.hidden > 0 ? ` …还有 ${foldedLive.hidden} 字` : ''}`),
    live.text === '' ? null : h(Text, { wrap: 'wrap' }, live.text),
    ask === null ? null : h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'yellow', paddingX: 1 },
      h(Text, { bold: true }, `要执行 ${ask.tool}`),
      h(Text, { wrap: 'truncate-end' }, ask.detail),
      ask.backend === '' ? null : h(Text, { dimColor: true, wrap: 'truncate-end' }, `后端 ${ask.backend}`),
      ask.reason === '' ? null : h(Text, { dimColor: true }, ask.reason),
      h(Text, null, '按 y 允许一次，按 n 不允许')),
    detail === null ? null : h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'cyan', paddingX: 1 },
      h(Text, { dimColor: true }, detailTitle(detail)),
      detail.rows.length === 0
        ? h(Text, { dimColor: true }, '这一条没有可画的内容')
        : detail.rows.map((row, index) => h(Row, { key: index, row, expanded: true }))),
    h(Box, null,
      h(Text, { color: running ? 'yellow' : 'cyan' }, running ? `${SPINNER[tick % SPINNER.length]} ` : '› '),
      draft === '' && !running
        ? h(Text, { dimColor: true }, '要模型做的事（Enter 发送，Shift+Enter 换行，/help 看命令）')
        : h(Fragment, null,
          h(Text, null, draft.slice(0, caret)),
          h(Text, { inverse: true }, draft[caret] ?? ' '),
          h(Text, null, draft.slice(caret + 1)))),
    h(Text, { dimColor: true }, buildStatusLine({
      head, sessionId, boundary: info.boundary, status, running, seconds, expanded, columns: stdout?.columns,
    })),
  );
}
