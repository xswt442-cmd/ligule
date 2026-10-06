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
  // 一次读取：没问人就成了，正文溢出在文件里（D77、D94）。
  { seq: 3, kind: 'tool', tool: 'read', callId: 'call_read_1', args: { path: 'notes/compaction.md' },
    verdict: { decision: 'allow', via: 'auto', capability: 'read', level: 'auto' },
    result: { content: { text: '窗口 200000、压力线 16…（整段已截断）' }, spilled: 'result-3-1a2b3c4d.json' } },
  // 一次命令：问过才放行，跑出来是失败的退出码。
  { seq: 4, kind: 'tool', tool: 'exec', callId: 'call_exec_1', args: { command: 'node -e "console.log(1)"' },
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
  { id: '7f3c9a21-4b7e-4f0a-9c1d-2a5e8b0c6d9f', formatVersion: 1, projectRoot: 'E:/notes', createdAt: '2026-10-05T09:02:11.000Z', updatedAt: '2026-10-05T11:41:07.000Z', events: 41, lastSeq: 40, mode: { name: 'full', layer: 'shipped', digest: '0f2b1c3d4e5f' }, unanswered: 0, truncatedBytes: 0 },
  { id: '2b8d55c0-11aa-4c3e-8d77-9f0a1b2c3d4e', formatVersion: 1, projectRoot: 'E:/notes', createdAt: '2026-10-05T07:20:00.000Z', updatedAt: '2026-10-05T08:55:31.000Z', events: 128, lastSeq: 127, mode: { name: 'minimal', layer: 'shipped', digest: 'aa11bb22cc33' }, unanswered: 2, truncatedBytes: 0 },
  { id: 'c4e1f00d-7788-4a5b-9c0d-e1f2a3b4c5d6', formatVersion: 0, projectRoot: '', createdAt: null, updatedAt: '2026-10-04T13:07:44.000Z', events: 3, lastSeq: 2, mode: null, unanswered: 0, truncatedBytes: 0 },
  { id: '9a7b5c3d-0e1f-4a5b-8c9d-0e1f2a3b4c5d', formatVersion: 0, projectRoot: '', createdAt: null, updatedAt: '2026-10-04T09:12:03.000Z', events: 0, lastSeq: -1, mode: null, unanswered: 0, truncatedBytes: 0, error: { code: 'session_event_unknown', detail: '事件种类没标 ignorable，读不懂就拒绝重建（D73）' } },
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

export function createFakeHost(options: { events?: number } = {}): Transport & { pushEvent: (event: Record<string, unknown>) => void } {
  let emit: (frame: Frame) => void = () => undefined;
  let opened = 0;
  let seq = 1000;
  // 界面答复那一条审批之后才往下跑：真宿主也是等这一格答复才继续（D16）。
  const asking = new Map<string, (decision: string) => void>();

  const answer = (frame: Frame): void => {
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
        return reply({ sessionId: id, events: params.fullResults === true ? fillSpills(loaded) : loaded });
      }
      case 'sessions.list':
        return reply({ sessions: params.projectRoot === undefined ? sessions : sessions.filter((item) => item.projectRoot === params.projectRoot) });
      case 'status.get':
        return reply({ ...status, sessionId: params.sessionId, eventCount: eventsOf(String(params.sessionId)).length });
      case 'mode.set':
        status = { ...status, mode: String(params.name), modeLayer: 'shipped' };
        return reply({ mode: status.mode, layer: status.modeLayer, pending: null, tools: status.tools });
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

  // 一轮的样子：先推理增量，再两次工具调用与结果，中间夹一次审批，最后是带 markdown 的回答。
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
    await wait(200);
    part('text', '这一步要动两个文件：');
    for (const piece of ['先 `read` 那份笔记，', '再跑一条命令数一遍行数。']) {
      await wait(160);
      part('text', piece);
    }
    await wait(240);
    const command = 'powershell -NoProfile -Command "Get-ChildItem | Measure-Object"';
    const askId = `ask-${callId}`;
    const decision = await new Promise<string>((resolve) => {
      asking.set(askId, resolve);
      emit({
        id: askId,
        method: 'approval.request',
        params: {
          sessionId,
          tool: 'exec',
          command,
          reason: 'PowerShell 那一条不是简单命令（带管道与 cmdlet），自动档不放开（D66）。',
          shell: 'powershell',
          executable: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        },
      });
      // 演示页面停在没人答复时也要能走下去：30 秒后按不允许收掉。
      setTimeout(() => {
        if (asking.has(askId)) {
          asking.delete(askId);
          resolve('deny');
        }
      }, 30_000);
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
    tell({ seq: 104, kind: 'usage', ignorable: true, input: 9211, output: 214, estimated: 19_050, measurement: 'request-v1' });
    await wait(160);
    tell({ seq: 105, kind: 'assistant', text: markdown });
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
  };
}
