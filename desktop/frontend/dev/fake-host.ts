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

const eventsOf = (sessionId: string): Record<string, unknown>[] => [
  { seq: 0, kind: 'user', text: '把压缩那一步的读数写成一页', raw: '把压缩那一步的读数写成一页' },
  { seq: 1, kind: 'reasoning', text: '需要先看记录里那条 usage 的读数，然后写成一份能贴进文档的段落。' },
  { seq: 2, kind: 'assistant', text: '', toolCalls: [
    { id: 'call_read_1', name: 'read', args: { path: 'notes/compaction.md' } },
    { id: 'call_exec_1', name: 'exec', args: { command: 'node -e "console.log(1)"' } },
  ] },
  { seq: 3, kind: 'tool', tool: 'read', callId: 'call_read_1', args: { path: 'notes/compaction.md' }, result: { content: { text: '窗口 200000、压力线 160000、一次压掉 97122。' } } },
  { seq: 4, kind: 'tool', tool: 'exec', callId: 'call_exec_1', args: { command: 'node -e "console.log(1)"' }, result: { failed: true, code: 'exec_exit_1', content: { text: '命令没找到', exitCode: 1 } } },
  { seq: 5, kind: 'mode', name: 'full', layer: 'shipped', tools: ['*'], digest: '0f2b1c3d4e5f' },
  { seq: 6, kind: 'usage', ignorable: true, input: 8351, output: 126, estimated: 17398, measurement: 'request-v1' },
  { seq: 7, kind: 'assistant', text: markdown },
  { seq: 8, kind: 'tool', tool: 'subagent', callId: 'call_sub_1', args: { task: '把那段哈希输入逐格核对一遍' }, result: { content: { text: '核对完，三格对不上。', sessionId: `${sessionId}.sub-1` } } },
];

const branchEvents: Record<string, unknown>[] = [
  { seq: 0, kind: 'user', text: '把那段哈希输入逐格核对一遍', raw: '把那段哈希输入逐格核对一遍' },
  { seq: 1, kind: 'assistant', text: '对完：`seq`、kind、工具名三格一致；`callId` 不在输入里。' },
];

const sessions = [
  { id: '7f3c9a21-4b7e-4f0a-9c1d-2a5e8b0c6d9f', formatVersion: 1, projectRoot: 'E:/notes', createdAt: '2026-10-05T09:02:11.000Z', updatedAt: '2026-10-05T11:41:07.000Z', events: 41, lastSeq: 40, mode: { name: 'full', layer: 'shipped', digest: '0f2b1c3d4e5f' }, unanswered: 0 },
  { id: '2b8d55c0-11aa-4c3e-8d77-9f0a1b2c3d4e', formatVersion: 1, projectRoot: 'E:/notes', createdAt: '2026-10-05T07:20:00.000Z', updatedAt: '2026-10-05T08:55:31.000Z', events: 128, lastSeq: 127, mode: { name: 'minimal', layer: 'shipped', digest: 'aa11bb22cc33' }, unanswered: 2 },
  { id: 'c4e1f00d-7788-4a5b-9c0d-e1f2a3b4c5d6', formatVersion: 0, projectRoot: '', createdAt: null, updatedAt: '2026-10-04T13:07:44.000Z', events: 3, lastSeq: 2, mode: null, unanswered: 0 },
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

export function createFakeHost(): Transport {
  let emit: (frame: Frame) => void = () => undefined;
  let opened = 0;
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
      case 'session.open':
        return reply({ sessionId: params.sessionId });
      case 'session.read':
        return reply({ sessionId: params.sessionId, events: String(params.sessionId).includes('.sub-') ? branchEvents : eventsOf(String(params.sessionId)) });
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
      tell({ seq: 103, kind: 'tool', tool: 'exec', callId, args: { command }, result: { content: { text: 'Count 12', exitCode: 0 } } });
    } else {
      tell({ seq: 103, kind: 'tool', tool: 'exec', callId, args: { command }, result: { failed: true, kind: 'refusal', code: 'policy_denied', reason: '这一条没被允许（答复是不允许）。' } });
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
  };
}
