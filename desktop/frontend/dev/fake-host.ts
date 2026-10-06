// 只在开发时用的那一份假宿主（不进打包产物：`vite build` 的入口是 index.html，这一份从 dev.html 进来）。
// 它按 `src/host/protocol.js` 那张表的帧形状说话，为的是把界面上每一条真实分支都演出来：流式增量、
// 刚落盘的事件、审批的反向请求、错误码、用量与压力、会话列表与支线。真宿主跑起来要有端点，
// 这一份不需要：界面改动的对错因此能在浏览器里当场看，也能在检查里当场断。
import type { Transport } from '../src/protocol';

type Frame = { id?: string; method?: string; params?: Record<string, unknown>; notify?: string; [key: string]: unknown };

const markdown = [
  '上下文压缩这一步做了三件事，按先后是：',
  '',
  '## 做了什么',
  '',
  '1. 端点报回的用量落成一条 `usage` 记录事件',
  '2. 重开会话时修正系数从记录算回来',
  '3. 手动压缩走 `session.compact`',
  '',
  '| 触发 | 什么时候响 | 拒绝码 |',
  '| --- | --- | --- |',
  '| 压力 | 估算越过 `窗口 × 0.8` | `compact_window_unset` |',
  '| 超长 | 端点报回窗口不够 | `compact_nothing_to_cut` |',
  '',
  '代码那一段也要看着对：',
  '',
  '```ts',
  'const factor = reported.input / estimated.input; // 校准',
  'if (estimated * factor > threshold) await compact();',
  '```',
  '',
  '细节在 [阶段三那份实现顺序](ligule-set/phase3/todo.md) 里，外链走另一条路：[example](https://example.com/)。一轮压完大约从十万降到两万。',
].join('\n');

// 溢出文件里的那一整段：只有 `fullResults` 这一格交回来，记录里留着的是截断后的那一份。
const spills: Record<string, unknown> = {
  'result-3-1a2b3c4d.json': {
    text: [
      '窗口 200000、压力线 160000、一次压掉 97122。',
      '这一段是溢出文件里的整段正文，界面上「看全文」展开的就是它。',
      '记录里那一份是截断后的，读回记录时才由宿主换成整段。',
      ...Array.from({ length: 14 }, (_unused, index) => `第 ${index + 1} 次：越线在校准后约 ${158_000 + index * 1_200} 报回，压完剩 ${19_000 + index * 300}。`),
    ].join('\n'),
  },
};

const eventsOf = (sessionId: string): Record<string, unknown>[] => [
  { seq: 0, kind: 'user', text: '把压缩那一步的读数写成一页', raw: '把压缩那一步的读数写成一页' },
  { seq: 1, kind: 'reasoning', text: '需要先看记录里那条 usage 的读数，然后写成一份能贴进文档的段落。' },
  { seq: 2, kind: 'assistant', text: '', toolCalls: [
    { id: 'call_read_1', name: 'read', args: { path: 'notes/compaction.md' } },
    { id: 'call_exec_1', name: 'exec', args: { command: 'node -e "console.log(1)"' } },
  ] },
  // 一次读取：没问人就成了，正文溢出在文件里（D77、D94）。外层那一格是内核量的执行时间（第 66 步）。
  { seq: 3, kind: 'tool', tool: 'read', callId: 'call_read_1', args: { path: 'notes/compaction.md' }, durationMs: 42,
    verdict: { decision: 'allow', via: 'auto', capability: 'read', level: 'auto' },
    result: { content: { text: '窗口 200000、压力线 16…（整段已截断）' }, spilled: 'result-3-1a2b3c4d.json' } },
  // 一次命令：问过才放行，跑出来是失败的退出码。用时那一格不含等人答复的那一段。
  { seq: 4, kind: 'tool', tool: 'exec', callId: 'call_exec_1', args: { command: 'node -e "console.log(1)"' }, durationMs: 12_400,
    verdict: { decision: 'allow', via: 'ask', capability: 'exec', level: 'ask', rule: '命令逐次询问', answer: 'allow' },
    result: { failed: true, code: 'exec_exit_1', content: { text: '命令没找到', exitCode: 1 } } },
  { seq: 5, kind: 'assistant', text: '', toolCalls: [
    { id: 'call_write_1', name: 'write', args: { path: 'notes/readings.md', content: '# 读数\n\n窗口 200000\n压力线 160000\n' } },
  ] },
  // 一次写入：参数里带着整份内容，界面上给的是行数与那句改动摘要（D94）。
  { seq: 6, kind: 'tool', tool: 'write', callId: 'call_write_1', args: { path: 'notes/readings.md', content: '# 读数\n\n窗口 200000\n压力线 160000\n' },
    verdict: { decision: 'allow', via: 'auto', capability: 'write', level: 'auto' },
    result: { content: { text: '写了 5 行' } } },
  { seq: 7, kind: 'assistant', text: '', toolCalls: [
    { id: 'call_mcp_1', name: 'mcp.call', args: { server: 'demo', tool: 'lookup', input: { key: 'compaction' } } },
  ] },
  // 一次 MCP 调用：判定链读的是 `mcp:<服务器>/<工具>`，画出来的也该是那一串（D52）。
  { seq: 8, kind: 'tool', tool: 'mcp.call', callId: 'call_mcp_1', args: { server: 'demo', tool: 'lookup', input: { key: 'compaction' } },
    verdict: { decision: 'allow', via: 'ask', capability: 'mcp:demo/lookup', level: 'auto', rule: '第三方工具逐次询问' },
    result: { content: { text: '找到两条相关段落，都在第三份文档里。', effectiveCapability: 'mcp:demo/lookup' } } },
  { seq: 9, kind: 'mode', name: 'full', layer: 'shipped', tools: ['create', 'delete', 'edit', 'exec', 'fetch', 'find', 'read', 'search', 'write'], digest: '0f2b1c3d4e5f' },
  { seq: 10, kind: 'usage', ignorable: true, input: 8351, output: 126, estimated: 17398, measurement: 'request-v1' },
  { seq: 11, kind: 'assistant', text: markdown },
  // 派生支线：交回的那一份里带着支线的会话 id，正文之外那一格进抬头（D74）。
  { seq: 12, kind: 'tool', tool: 'subagent', callId: 'call_sub_1', args: { task: '把那段哈希输入逐格核对一遍' },
    result: { content: { text: '核对完，三格对不上。', sessionId: `${sessionId}.sub-1` } } },
  // 崩溃留下的那一次派发由恢复路径补成一条正常结果，码是 tool_outcome_unknown（D72）。
  { seq: 13, kind: 'tool', tool: 'exec', callId: 'call_exec_9', args: { command: 'git status --short' },
    recovery: { assistantSeq: 14, safeToRedo: false },
    result: { failed: true, code: 'tool_outcome_unknown', content: { text: '那一次派发没留下结果，它的外部副作用次数未知。' } } },
  { seq: 14, kind: 'assistant', text: '', toolCalls: [
    { id: 'call_fetch_1', name: 'fetch', args: { url: 'http://169.254.169.254/latest/meta-data/' } },
  ] },
  // 未允许与失败是两种脸：这一条被判定链直接拒了，码原样显示（D58、D93）。
  { seq: 15, kind: 'tool', tool: 'fetch', callId: 'call_fetch_1', args: { url: 'http://169.254.169.254/latest/meta-data/' },
    verdict: { decision: 'deny', capability: 'fetch', level: 'auto', rule: '元数据端点直接拒绝' },
    result: { failed: true, kind: 'refusal', code: 'fetch_metadata_blocked', reason: '那个地址落在链路本地与元数据端点那一类，直接拒（D58）。' } },
];

const branchEvents: Record<string, unknown>[] = [
  { seq: 0, kind: 'user', text: '把那段哈希输入逐格核对一遍', raw: '把那段哈希输入逐格核对一遍' },
  { seq: 1, kind: 'assistant', text: '对完：`seq`、kind、工具名三格一致；`callId` 不在输入里。' },
];

// 左侧栏那一份列表的夹具：三行是正常读出来的，第四行是读不出来的那一种（D93 要看得见码）。
const sessions = [
  { id: '7f3c9a21-4b7e-4f0a-9c1d-2a5e8b0c6d9f', formatVersion: 1, projectRoot: 'E:/notes', createdAt: '2026-10-05T09:02:11.000Z', updatedAt: '2026-10-05T11:41:07.000Z', events: 41, lastSeq: 40, mode: { name: 'full', layer: 'shipped', digest: '0f2b1c3d4e5f' }, name: '压缩读数那一轮', archived: false, unanswered: 0, truncatedBytes: 0 },
  { id: '2b8d55c0-11aa-4c3e-8d77-9f0a1b2c3d4e', formatVersion: 1, projectRoot: 'E:/notes', createdAt: '2026-10-05T07:20:00.000Z', updatedAt: '2026-10-05T08:55:31.000Z', events: 128, lastSeq: 127, mode: { name: 'minimal', layer: 'shipped', digest: 'aa11bb22cc33' }, name: '', archived: true, unanswered: 2, truncatedBytes: 0 },
  { id: 'c4e1f00d-7788-4a5b-9c0d-e1f2a3b4c5d6', formatVersion: 0, projectRoot: '', createdAt: null, updatedAt: '2026-10-04T13:07:44.000Z', events: 3, lastSeq: 2, mode: null, name: '', archived: false, unanswered: 0, truncatedBytes: 0 },
  { id: '9a7b5c3d-0e1f-4a5b-8c9d-0e1f2a3b4c5d', formatVersion: 0, projectRoot: '', createdAt: null, updatedAt: '2026-10-04T09:12:03.000Z', events: 0, lastSeq: -1, mode: null, name: '', archived: false, unanswered: 0, truncatedBytes: 0, error: { code: 'session_event_unknown', detail: '事件种类没标 ignorable，读不懂就拒绝重建（D73）' } },
];

let status = {
  sessionId: '',
  running: false,
  tools: ['create', 'delete', 'edit', 'exec', 'fetch', 'find', 'read', 'search', 'write', 'skill', 'mcp.inspect', 'mcp.call', 'subagent'],
  mode: 'full',
  modeLayer: 'shipped',
  pendingMode: null,
  policy: 'auto',
  denials: { consecutive: 0, total: 3 },
  eventCount: 0,
  templates: [
    { command: 'git:release:prepare', description: '准备一次发布', hint: '<序号>' },
    { command: 'notes:summarise', description: '把一份笔记压成三段', hint: '<路径>' },
  ],
  usage: { window: 200_000, threshold: 160_000, retained: 32_000, estimated: 41_512, factor: 0.48, reported: { seq: 6, input: 8351, output: 126 }, measurement: 'request-v1' },
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// 长转录的测量用：一份 N 条的合成记录，五种形状轮着来，每一条都是真记录里会出现的那几种之一。
export function longEvent(seq: number): Record<string, unknown> {
  const kind = seq % 5;
  if (kind === 1) return { seq, kind: 'user', text: `第 ${seq} 条输入`, raw: `第 ${seq} 条输入` };
  if (kind === 2) return { seq, kind: 'reasoning', text: '这一段推理够长，能占掉几行屏幕。'.repeat(3) };
  if (kind === 3) return { seq, kind: 'assistant', text: '', toolCalls: [{ id: `c${seq}`, name: 'exec', args: { command: `node -e ${seq}` } }] };
  if (kind === 4) {
    const command = `node -e ${seq}`;
    return {
      seq, kind: 'tool', tool: 'exec', callId: `c${seq}`, args: { command },
      verdict: { decision: 'allow', via: 'auto', capability: 'exec', level: 'auto' },
      result: { content: { text: `命令输出第 ${seq} 行，一共二十行。\n`.repeat(20), exitCode: 0 } },
    };
  }
  return { seq, kind: 'assistant', text: `第 ${seq} 段回答，带一个 \`inline\` 与两行列表：\n\n- 一\n- 二` };
}

// 与宿主那一条同形：`fullResults` 交回时把溢出事件的内容换成整段，记录本身那份是截断的。
function fillSpills(events: Record<string, unknown>[]): Record<string, unknown>[] {
  return events.map((event) => {
    const spilled = (event.result as { spilled?: string } | undefined)?.spilled;
    return spilled === undefined ? event : { ...event, result: { ...(event.result as object), content: spills[spilled] } };
  });
}

// 命中那一格的算法与宿主同形：一段一段找，摘录取真正对上那一段，不把两段接成一句假话（实现顺序第 76 步）。
// 指名一份就读得深一层：溢出文件里那一段整段正文也搜（方案 4.2 的完整工具结果，实现顺序第 78 步）。
function hitsOf(item: (typeof sessions)[number], needle: string, deep: boolean): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const event of eventsOf(item.id)) {
    const texts = event.kind === 'user' || event.kind === 'assistant' || event.kind === 'reasoning'
      ? [String(event.text ?? '')]
      : event.kind === 'tool'
        ? [JSON.stringify(event.args ?? {}), String((event.result as { content?: { text?: string } })?.content?.text ?? '')]
        : [];
    const spilled = (event.result as { spilled?: string } | undefined)?.spilled;
    if (deep && spilled !== undefined) texts.push(String((spills[spilled] as { text?: string } | undefined)?.text ?? ''));
    const matched = texts.map((raw) => raw.replace(/\s+/g, ' ')).find((text) => text.toLocaleLowerCase().includes(needle));
    if (matched === undefined) continue;
    const at = matched.toLocaleLowerCase().indexOf(needle);
    const tail = at + needle.length + 44;
    out.push({
      sessionId: item.id,
      name: item.name,
      seq: event.seq,
      kind: event.kind,
      text: `${at > 0 ? '…' : ''}${matched.slice(Math.max(0, at - 16), tail).trim()}${tail < matched.length ? '…' : ''}`,
      ...(spilled === undefined ? {} : { spilled }),
    });
    if (!deep && out.length === 3) break;
  }
  // 名字那一格也搜得到：它写在 `label` 那一条上，不画在转录里，落到那一条时要说清（实现顺序第 75、77 步）。
  if ((deep || out.length < 3) && String(item.name).toLocaleLowerCase().includes(needle)) {
    out.push({ sessionId: item.id, name: item.name, seq: item.events - 1, kind: 'label', text: String(item.name) });
  }
  return out;
}

export function createFakeHost(options: { events?: number } = {}): Transport & {
  pushEvent: (event: Record<string, unknown>) => void;
  stopReplies: (on: boolean) => void;
} {
  let emit: (frame: Frame) => void = () => undefined;
  let opened = 0;
  let seq = 1000;
  // 装聋那一格：把帧收进去但不答，用来演「这一条连接不在了」那一张横幅。
  let deaf = false;
  // 界面答复那一条审批之后才往下跑：真宿主也是等这一格答复才继续（D16）。
  const asking = new Map<string, (decision: string) => void>();

  const answer = (frame: Frame): void => {
    if (deaf && frame.method !== undefined) return;
    const id = frame.id as string;
    if (typeof id === 'string' && id.startsWith('ask-')) {
      const settle = asking.get(id);
      if (settle !== undefined) {
        asking.delete(id);
        settle((frame.result as { decision?: string } | undefined)?.decision ?? 'deny');
      }
      return;
    }
    const params = (frame.params ?? {}) as Record<string, unknown>;
    const reply = (result: unknown) => emit({ id, result });
    const fail = (code: string, message: string) => emit({ id, error: { code, message } });

    switch (frame.method) {
      case 'session.create':
        opened += 1;
        status = { ...status, sessionId: `dev-session-${opened}`, eventCount: 0 };
        return reply({ sessionId: status.sessionId });
      case 'session.open': {
        // 接上一份记录时，那份记录最后生效的模式清单就是现在的模式（D78）；状态那一格跟着换。
        const found = sessions.find((item) => item.id === params.sessionId);
        if (found !== undefined && found.mode !== null) status = { ...status, mode: found.mode.name, modeLayer: found.mode.layer };
        return reply({ sessionId: params.sessionId });
      }
      case 'session.read': {
        const id = String(params.sessionId);
        const loaded = id.includes('.sub-')
          ? branchEvents
          : options.events === undefined
            ? eventsOf(id)
            : Array.from({ length: options.events }, (_unused, index) => longEvent(index + 1));
        // 分页那一格与宿主同一套说法：游标是这一页最早那一条事件的序号，`hasMore` 说前面还有没有更早的（方案 4.1）。
        const before = typeof params.before === 'number' ? params.before : undefined;
        const limit = typeof params.limit === 'number' ? params.limit : undefined;
        const older = (before === undefined ? loaded : loaded.filter((event) => Number(event.seq) < before));
        const page = limit === undefined ? older : older.slice(-limit);
        return reply({
          sessionId: id,
          events: params.fullResults === true ? fillSpills(page) : page,
          endSeq: page.length === 0 ? null : Number(page.at(-1)?.seq),
          hasMore: page.length > 0 && Number(page[0]?.seq) > 1,
        });
      }
      // 名字与归档标记改的是列表读的那一份事实：这里直接改那几行假记录（实现顺序第 75 步）。
      case 'session.label': {
        const found = sessions.find((item) => item.id === params.sessionId);
        if (found === undefined) return fail('session_not_open', String(params.sessionId));
        const named = typeof params.name === 'string' ? params.name.trim() : '';
        if (params.name !== undefined && named === '') return fail('session_name_invalid', 'wanted 1-120 visible characters');
        if (named !== '') found.name = named;
        if (typeof params.archived === 'boolean') found.archived = params.archived;
        return reply({ sessionId: found.id, name: found.name, archived: found.archived });
      }
      case 'sessions.list':
        return reply({ sessions: params.projectRoot === undefined ? sessions : sessions.filter((item) => item.projectRoot === params.projectRoot) });
      // 查找扫的就是这些假记录里的正文，与宿主那一条交回同一份形状：哪一份会话的第几条（方案 4.2）。
      case 'sessions.search': {
        const needle = String(params.query ?? '').trim().toLocaleLowerCase();
        // 空白的查询在每一份记录里都能对上，宿主那一条在扫之前就拒掉（实现顺序第 76 步）。
        if (needle === '') return fail('search_query_empty', 'a search query has to say what to look for');
        const scoped = typeof params.sessionId === 'string' ? params.sessionId : undefined;
        const found = sessions
          .filter((item) => (scoped === undefined ? !item.id.includes('.sub-') : item.id === scoped))
          .flatMap((item) => hitsOf(item, needle, scoped !== undefined))
          .slice(0, 50);
        return reply({ hits: found });
      }
      case 'status.get':
        return reply({ ...status, sessionId: params.sessionId, eventCount: eventsOf(String(params.sessionId)).length });
      case 'mode.set': {
        // 坏清单在那一刻就报稳定码（D65）：随包带的只有那两份，界面写别的就换不过去。
        const name = String(params.name);
        if (name !== 'minimal' && name !== 'full') return fail('mode_unknown', `没有那一份模式清单：${name}`);
        status = { ...status, mode: name, modeLayer: 'shipped' };
        return reply({ mode: name, layer: status.modeLayer, pending: null, tools: status.tools });
      }
      case 'config.get':
        // 假宿主也按白名单答：这几格是真的配置文件里会写的那种值，密钥本身从来不在里面（D13）。
        return reply({ model: { api: 'chat-completions', baseURL: 'https://example.test/v1', model: 'fake-review-model', apiKeyEnv: 'LIGULE_FAKE_KEY' } });
      case 'session.compact':
        status = { ...status, usage: { ...status.usage, estimated: 12_400 } };
        return reply({ sessionId: params.sessionId, fromSeq: 0, toSeq: 6, tokensBefore: 41_512, tokensAfter: 12_400 });
      case 'run.start':
        return void run(String(params.sessionId), String(params.input)).then(() => reply({ iterations: 4, modelCalls: 3, completedBy: 'assistant' }));
      case 'run.cancel':
        return fail('run_not_running', '这一份会话没在跑');
      default:
        return fail('protocol_method_unknown', String(frame.method));
    }
  };

  // 审批那一条反过来的请求：发出去，等界面答复；停在没人答复那一下时 30 秒后按不允许收掉。
  function ask(callId: string, params: Record<string, unknown>): Promise<string> {
    const askId = `ask-${callId}`;
    return new Promise((resolve) => {
      asking.set(askId, resolve);
      emit({ id: askId, method: 'approval.request', params });
      setTimeout(() => {
        if (asking.has(askId)) {
          asking.delete(askId);
          resolve('deny');
        }
      }, 30_000);
    });
  }

  // 一轮的样子：先推理增量，再两次工具调用与结果，中间夹两次审批（按先后各演一次），最后是带 markdown 的回答。
  async function run(sessionId: string, input: string): Promise<void> {
    const tell = (event: Record<string, unknown>) => emit({ notify: 'event', sessionId, event });
    const part = (type: string, text: string) => emit({ notify: 'delta', sessionId, event: { type, text } });
    const callId = 'call_exec_2';
    status = { ...status, running: true, sessionId };
    tell({ seq: 100, kind: 'user', text: input, raw: input });
    for (const piece of ['先看一眼', '那份记录里的读数，', '再决定要不要连模型。']) {
      await wait(180);
      part('reasoning', piece);
    }
    tell({ seq: 101, kind: 'reasoning', text: '先看一眼那份记录里的读数，再决定要不要连模型。' });
    // 另一份会话在等人答（实现顺序第 71 步）：那一次派发属于左侧栏列出来的第二份记录。
    // 当前这一份不因为它停下，停下的是它那一份自己的那一轮；答复按那一次请求的编号落回它自己那一份。
    const otherId = '2b8d55c0-11aa-4c3e-8d77-9f0a1b2c3d4e';
    void ask('call_other_1', {
      sessionId: otherId,
      tool: 'edit',
      args: { path: 'notes/readings-3.md', anchor: '窗口 120000', replacement: '窗口 200000' },
      reason: '那是另一份会话里的编辑：它排在当前这一份的询问前面，答的仍然是它那一次派发。',
    }).then((decision) => emit({
      notify: 'event',
      sessionId: otherId,
      event: {
        seq: 400, kind: 'tool', tool: 'edit', callId: 'call_other_1', args: { path: 'notes/readings-3.md' },
        verdict: { decision, via: 'ask', capability: 'edit', level: 'ask', rule: '编辑逐次询问', answer: decision },
        result: decision === 'allow'
          ? { content: { text: '改了一行' } }
          : { failed: true, kind: 'refusal', code: 'policy_denied', reason: '这一条没被允许（答复是不允许）。' },
      },
    }));
    await wait(200);
    part('text', '这一步要动两个文件：');
    for (const piece of ['先 `read` 那份笔记，', '再跑一条命令数一遍行数。']) {
      await wait(160);
      part('text', piece);
    }
    await wait(240);
    const command = 'powershell -NoProfile -Command "Get-ChildItem | Measure-Object"';
    const decision = await ask(callId, {
      sessionId,
      tool: 'exec',
      command,
      reason: 'PowerShell 那一条不是简单命令（带管道与 cmdlet），自动档不放开（D66）。',
      shell: 'powershell',
      executable: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    });
    await wait(240);
    tell({ seq: 102, kind: 'assistant', text: '', toolCalls: [{ id: callId, name: 'exec', args: { command } }] });
    await wait(420);
    if (decision === 'allow') {
      tell({ seq: 103, kind: 'tool', tool: 'exec', callId, args: { command },
        verdict: { decision: 'allow', via: 'ask', capability: 'exec', level: 'ask', rule: '命令逐次询问', answer: 'allow' },
        result: { content: { text: 'Count 12', exitCode: 0 } } });
    } else {
      tell({ seq: 103, kind: 'tool', tool: 'exec', callId, args: { command },
        verdict: { decision: 'deny', via: 'ask', capability: 'exec', level: 'ask', rule: '命令逐次询问', answer: 'deny' },
        result: { failed: true, kind: 'refusal', code: 'policy_denied', reason: '这一条没被允许（答复是不允许）。' } });
    }
    await wait(220);
    // 第二次询问：一次整份写入。参数里带着正文，界面上给的是那一句改动摘要与可展开的全文（D94）。
    const writeId = 'call_write_2';
    const path = 'notes/readings-2.md';
    const content = '# 读数\n\n窗口 200000\n压力线 160000\n一次压掉 97122\n';
    const writeDecision = await ask(writeId, {
      sessionId,
      tool: 'write',
      args: { path, content },
      reason: '写入整份文件要人点头：这一件不在自动放行那一档里（D3）。',
    });
    await wait(200);
    tell({ seq: 104, kind: 'assistant', text: '', toolCalls: [{ id: writeId, name: 'write', args: { path, content } }] });
    await wait(380);
    tell({ seq: 105, kind: 'tool', tool: 'write', callId: writeId, args: { path, content },
      verdict: writeDecision === 'allow'
        ? { decision: 'allow', via: 'ask', capability: 'write', level: 'ask', rule: '写入逐次询问', answer: 'allow' }
        : { decision: 'deny', via: 'ask', capability: 'write', level: 'ask', rule: '写入逐次询问', answer: 'deny' },
      result: writeDecision === 'allow'
        ? { content: { text: '写了 6 行' } }
        : { failed: true, kind: 'refusal', code: 'policy_denied', reason: '这一条没被允许（答复是不允许）。' } });
    await wait(220);
    tell({ seq: 106, kind: 'usage', ignorable: true, input: 9211, output: 214, estimated: 19_050, measurement: 'request-v1' });
    await wait(160);
    tell({ seq: 107, kind: 'assistant', text: markdown });
    status = { ...status, running: false, eventCount: 6, usage: { ...status.usage, estimated: status.usage.estimated + 9_425 } };
  }

  return {
    send: (text) => {
      answer(JSON.parse(text) as Frame);
    },
    onFrame: (handle) => {
      emit = (frame) => handle(JSON.stringify(frame));
    },
    onLog: (handle) => {
      handle('宿主：这一份是开发用的假宿主，帧不经管道');
    },
    // 测量与手工试形状用的那一个入口：往现在开着的那一份会话上补一条刚落盘的事件。
    pushEvent: (event) => {
      emit({ notify: 'event', sessionId: status.sessionId, event: { ...event, seq: (seq += 1) } });
    },
    stopReplies: (on) => {
      deaf = on;
    },
    // 重连那一条路的开发时演法：这一具「进程」又开始答话。装聋期间发出去的那些帧由界面自己收尾（第 65 步）。
    restart: async () => {
      deaf = false;
    },
  };
}
