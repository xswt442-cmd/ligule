// 会话记录 → 界面行的投影。记录是事实源（I5），这里只画已经落盘的那一份与流式期间的那半截；
// 后端的记录形状在 `src/session/session.js`，界面这一侧不认识别的。
// 卡片上每一格的取值规则写在 D94：抬头说的是这一件做成了什么，正文只给内容，不给信封。

export type ToolCall = { id: string; name: string; args?: Record<string, unknown> };

export type Verdict = {
  decision?: string;
  via?: string;
  capability?: string;
  level?: string;
  forced?: boolean;
  rule?: string;
  answer?: string;
};

export type Record_ = {
  seq?: number;
  kind: string;
  name?: string;
  archived?: boolean;
  // 模板展开过的那一条用户记录另留着人打的那一行（D54）：画的是这一份，交给模型的是 text。
  text?: string;
  raw?: string;
  toolCalls?: ToolCall[];
  tool?: string;
  callId?: string;
  // 这一次执行花了多久，由内核记在事件外层（第 66 步）。没执行的调用与恢复补写的那一条没有这一格。
  durationMs?: number;
  // 工具那一条记录留着交进去的参数（`src/kernel/kernel.js` 的 call），派生支线那一格要说得出交的是哪件事。
  args?: Record<string, unknown>;
  result?: {
    kind?: string;
    failed?: boolean;
    code?: string;
    reason?: string;
    content?: unknown;
    spilled?: string;
  };
  // 判定真正用的那一格（D77）：进记录、不进模型可见投影，界面读得到。
  verdict?: Verdict;
  // 一轮正常完整结束留下的那一条事实（D68）：它是一处可选的分支点（方案 4.3）。
  status?: string;
  code?: string;
  iterations?: number;
  modelCalls?: number;
  // 一轮开始时交回的那一份完整参数快照（`session.read` 里的一条 `turnContext`）。内核没落这一条时这几格都不出现。
  model?: string | null;
  policy?: string;
  policySource?: string;
  mode?: string;
  // 崩溃之后由恢复路径补上的那一条（D72、D85）。
  recovery?: { assistantSeq?: number; safeToRedo?: boolean };
};

// 展示档那一格决定哪几行进得来：虚拟视口要量每一行的高度，藏着不画的行留在列表里只会量到零（D90、U48）。
export const shownIn = (verbosity: string, row: Row): boolean =>
  !(verbosity === 'brief' && (row.kind === 'reasoning' || row.kind === 'call' || row.kind === 'result' || row.kind === 'context'))
  && !(verbosity === 'standard' && (row.kind === 'reasoning' || row.kind === 'context'));

export type Row = {
  id: number;
  kind: 'question' | 'answer' | 'reasoning' | 'call' | 'result' | 'refusal' | 'failure' | 'round' | 'context' | 'meta' | 'error';
  text: string;
  status?: string;
  // 这一行来自记录里哪一条事件（D73 那个稳定序号）。界面自己写的那几行没有它。
  seq?: number;
  // 生效的能力名：`mcp.call` 这一件画的是 `mcp:<服务器>/<工具>`，与判定链读的那一串一致（D52）。
  tool?: string;
  code?: string;
  callId?: string;
  // 抬头下面那一行：参数摘要或改动摘要，说的是对着哪个对象（D94）。
  summary?: string;
  // 抬头右侧那几枚读数：退出码、溢出文件、判定、支线、耗时。
  notes?: string[];
  // 系统摘要与读数同时保留两种文字；切换语言不改模型正文和工具输出。
  english?: { text?: string; summary?: string; notes?: string[] };
  // 写入类那一张卡片上的加减行数：换掉多少行、换上多少行（D94）。
  diff?: { added: number; removed: number };
};

// 工具结果的内容可以是串，也可以是结构化的一段（read 交回的是 {text: ...}）。
export function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  return JSON.stringify(value, null, 2);
}

// `mcp.call` 这个名字对人不说明任何事：判定链、审批框与记录里读的都是那一串能力名。
export function capabilityOf(name?: string, args?: Record<string, unknown>): string {
  if (name === 'mcp.call' && typeof args?.server === 'string' && typeof args?.tool === 'string') {
    return `mcp:${args.server}/${args.tool}`;
  }
  return name ?? '';
}

// 工具交回的那一份形状是 { text, 附带几格 }：正文画 text，附带那几格进抬头那一行。
function payloadOf(result: Record_['result']): { text?: string; exitCode?: unknown; effectiveCapability?: unknown; sessionId?: unknown } {
  const content = result?.content;
  return typeof content === 'object' && content !== null
    ? content as { text?: string; exitCode?: unknown; effectiveCapability?: unknown; sessionId?: unknown }
    : {};
}

// 写入类那一句改动摘要与加减行数说的是同一件事：路径、换掉多少行、换上多少行。
// 参数里没有路径就不编造一个：摘要行宁可空着，也不画 `?.md` 那种形状。
// `action`、`before`、`after` 是给审批那一格看的差异（方案 5.4）：说清实际动的是哪一件、去掉哪一段、换上哪一段。
// 没读过的正文一概不画：删除只说移进回收站；整份写入不猜目标是新建还是覆盖，那一件由内核那条规则管。
export type Change = { summary: string; diff?: { added: number; removed: number }; action: string; before: string; after: string };

export function changeOf(tool: string, args: Record<string, unknown>, locale: 'zh' | 'en' = 'zh'): Change {
  const t = (zh: string, en: string) => locale === 'zh' ? zh : en;
  const path = typeof args.path === 'string' ? args.path : '';
  const lines = (value: unknown) => String(value ?? '').split('\n').length;
  const none: Change = { summary: '', action: '', before: '', after: '' };
  if (path === '') return none;
  if ((tool === 'write' || tool === 'create') && typeof args.content === 'string') {
    const added = lines(args.content);
    return {
      summary: t(`${path}：写入 ${added} 行`, `${path}: write ${added} lines`),
      diff: { added, removed: 0 },
      action: t('写入完整文件；覆盖已有文件前必须完整读取', 'Write the entire file; overwriting requires reading the existing file first'),
      before: '',
      after: args.content,
    };
  }
  if (tool === 'edit' && typeof args.anchor === 'string') {
    const replacement = typeof args.replacement === 'string' ? args.replacement : '';
    return {
      summary: t(`${path}：替换 ${lines(args.anchor)} 行，写入 ${lines(replacement)} 行`, `${path}: replace ${lines(args.anchor)} lines with ${lines(replacement)} lines`),
      diff: { added: lines(replacement), removed: lines(args.anchor) },
      action: t(`${path}：替换匹配内容`, `${path}: replace matched text`),
      before: args.anchor,
      after: replacement,
    };
  }
  if (tool === 'delete') {
    return { summary: t(`将 ${path} 移入回收站`, `Move ${path} to trash`), action: t(`将 ${path} 移入系统回收站或权限边界内的回收目录`, `Move ${path} to system trash or the recovery directory within the permission boundary`), before: '', after: '' };
  }
  return none;
}

// 审批那一格展开的正文：写入类那三件画成「去掉哪一段、换上哪一段」，段首带减号与加号（方案 5.4）。
// 与终端那一侧同一条规则、两份写法；其余的调用还是把参数交出去，不编内容。
export function changeBody(change: Change, args: Record<string, unknown>, locale: 'zh' | 'en' = 'zh'): string {
  const t = (zh: string, en: string) => locale === 'zh' ? zh : en;
  if (change.action === '') return typeof args.content === 'string' ? args.content : JSON.stringify(args, null, 2);
  const mark = (text: string, sign: string): string[] =>
    text === '' ? [`${sign}${t('（空）', '(empty)')}`] : text.split('\n').map((line) => `${sign} ${line}`);
  return [change.action,
    ...(change.before === '' ? [] : [t('原内容:', 'Before:'), ...mark(change.before, '-')]),
    ...(change.after === '' ? [] : [t('新内容:', 'After:'), ...mark(change.after, '+')]),
  ].join('\n');
}

// 一次调用对人说清它动的是哪个对象：命令文本、路径、地址、那一项 MCP 能力名，都没有就退回一行参数。
function argSummary(tool: string, args: Record<string, unknown>): string {
  if (tool === 'ask_user_question') {
    let questions: unknown = args.questions;
    if (typeof questions === 'string') {
      try {
        questions = JSON.parse(questions);
      } catch {
        // 无效参数的原文保留在展开详情中。
        return '';
      }
    }
    if (!Array.isArray(questions)) return '';
    return questions.flatMap((question: unknown) => {
      if (typeof question !== 'object' || question === null) return [];
      const fields = question as Record<string, unknown>;
      const title = fields.header ?? fields.question;
      return typeof title === 'string' && title.trim() !== '' ? [title.trim()] : [];
    }).join(' · ').slice(0, 160);
  }
  const single = args.command ?? args.path ?? args.url ?? args.pattern ?? args.query ?? args.task;
  if (typeof single === 'string' && single !== '') return single;
  // `mcp.call` 的能力名已经在抬头上，摘要只给那一份输入（D52）。
  const rest = tool === 'mcp.call' ? { ...args, server: undefined, tool: undefined } : args;
  const line = JSON.stringify(rest);
  return line.length > 160 ? `${line.slice(0, 160)}…` : line;
}

// 判定那一格说人话：没问人就成了、问过才成、不允许，外加命中的规则与档位（D77、D94）。
function verdictNote(verdict: Verdict, locale: 'zh' | 'en'): string {
  const t = (zh: string, en: string) => locale === 'zh' ? zh : en;
  if (typeof verdict.decision !== 'string') return '';
  const outcome = verdict.decision === 'deny' ? t('已拒绝', 'Denied') : verdict.via === 'ask' ? t('审批通过', 'Approved') : t('自动允许', 'Allowed automatically');
  const level = verdict.level === undefined ? '' : ` (${verdict.level}${verdict.forced === true ? '→ask' : ''})`;
  const rule = typeof verdict.rule === 'string' && verdict.rule !== '' ? t(` · 规则：${verdict.rule}`, ` · Rule: ${verdict.rule}`) : '';
  return `${outcome}${level}${rule}`;
}

function toolNotes(record: Record_, result: NonNullable<Record_['result']>, locale: 'zh' | 'en'): string[] {
  const t = (zh: string, en: string) => locale === 'zh' ? zh : en;
  const payload = payloadOf(result);
  const notes: string[] = [];
  if (payload.exitCode !== undefined) notes.push(t(`退出码 ${String(payload.exitCode)}`, `Exit code ${String(payload.exitCode)}`));
  if (result.spilled !== undefined) notes.push(t(`完整结果：${result.spilled}`, `Full result: ${result.spilled}`));
  const verdict = verdictNote(record.verdict ?? {}, locale);
  if (verdict !== '') notes.push(verdict);
  if (typeof payload.sessionId === 'string') notes.push(t(`子任务 ${payload.sessionId}`, `Subtask ${payload.sessionId}`));
  if (record.recovery !== undefined) {
    notes.push(record.recovery.safeToRedo === true ? t('中断恢复 · 可重试', 'Recovered after interruption · retry available') : t('中断恢复 · 外部操作结果未知', 'Recovered after interruption · external outcome unknown'));
  }
  return notes;
}

// 一次调用没有参数时，正文那一个空对象不该占一行。
function argsText(args: Record<string, unknown> | undefined): string {
  return args === undefined || Object.keys(args).length === 0 ? '' : textOf(args);
}

let sequence = 0;
const nextId = (): number => (sequence += 1);

export function metaRow(kind: 'meta' | 'error', text: string, english?: string): Row {
  return { id: nextId(), kind, text, ...(english === undefined ? {} : { english: { text: english } }) };
}

// 记录里那一格是内核自己量的实际执行时间，不含审批等待（第 66 步）。
// 界面这一侧量到的那一段是发出到交回之间，含等人答复，所以只在跑着的那一轮读得到。
function secondsNote(ms: number, locale: 'zh' | 'en' = 'zh'): string {
  const seconds = ms / 1000;
  const shown = seconds < 10 ? seconds.toFixed(1) : Math.round(seconds);
  return locale === 'zh' ? `用时 ${shown} 秒` : `${shown}s`;
}

export function durationNote(startedAt: number, now: number): string {
  return secondsNote(now - startedAt);
}

// 一张提问卡收掉时留下的那一句（审阅 F2）：题面与已经打下的字都读得到。
// 一次请求只有一次答复（D107），卡片收掉之后那些字不会再交出去，所以要留在转录里。
export function questionEcho(ask: { questions: { id: string; question: string }[] }, drafts: Record<string, { picked: string[]; extra: string }> = {}, locale: 'zh' | 'en' = 'zh'): string {
  return ask.questions.map((question, index) => {
    const typed = [...(drafts[question.id]?.picked ?? []), (drafts[question.id]?.extra ?? '').trim()].filter((one) => one !== '');
    const prefix = locale === 'zh' ? `第 ${index + 1} 题「${question.question}」：` : `Question ${index + 1}: “${question.question}” — `;
    const answer = typed.length === 0
      ? (locale === 'zh' ? '没有作答' : 'No answer entered')
      : typed.join(locale === 'zh' ? '、' : ', ');
    return `${prefix}${answer}`;
  }).join(locale === 'zh' ? '；' : '; ');
}

export function projectRecord(record: Record_, options: { startedAt?: number; now?: number } = {}): Row[] {
  // 每一行带着它来自记录里哪一条事件：查找的命中说的是那一条事件的序号，跳到那一行要靠它（方案 4.2、实现顺序第 77 步）。
  const at = record.seq === undefined ? {} : { seq: record.seq };
  return projected(record, options).map((row) => ({ ...row, ...at }));
}

function projected(record: Record_, options: { startedAt?: number; now?: number }): Row[] {
  if (record.kind === 'user') return [{ id: nextId(), kind: 'question', text: record.raw ?? record.text ?? '' }];
  // 一轮开始时的参数快照画成那一轮里的一行小字：内核还没落这一条时这一路不产行（读回来的记录里就没有它）。
  if (record.kind === 'turnContext') {
    const facts = [record.model, record.mode, record.policy].filter((part): part is string => typeof part === 'string' && part !== '');
    if (facts.length === 0) return [];
    const values = facts.join(' · ');
    return [{ id: nextId(), kind: 'context', text: `本轮参数：${values}`, english: { text: `Turn settings: ${values}` } }];
  }
  if (record.kind === 'reasoning') return [{ id: nextId(), kind: 'reasoning', text: record.text ?? '' }];
  // 一轮正常完整结束留下一条事实，那也是一处可选的分支点（D68、方案 4.3）：它画出一行，「从这里分支」挂在那一行上。
  if (record.kind === 'turn') {
    const states: Record<string, string> = { completed: '本轮已完成', cancelled: '本轮已取消', failed: '本轮失败', interrupted: '本轮意外中断' };
    const status = record.status ?? '';
    return states[status] === undefined ? [] : [{ id: nextId(), kind: 'round', status, code: record.code, text: states[status] }];
  }
  if (record.kind === 'assistant') {
    const rows: Row[] = record.text === '' || record.text === undefined
      ? []
      : [{ id: nextId(), kind: 'answer', text: record.text }];
    for (const call of record.toolCalls ?? []) {
      rows.push({
        id: nextId(),
        kind: 'call',
        tool: capabilityOf(call.name, call.args),
        callId: call.id,
        summary: argSummary(call.name, call.args ?? {}),
        text: argsText(call.args),
      });
    }
    return rows;
  }
  if (record.kind === 'tool') {
    const result = record.result ?? {};
    const kind = result.failed !== true ? 'result' : result.kind === 'refusal' ? 'refusal' : 'failure';
    const payload = payloadOf(result);
    const notes = toolNotes(record, result, 'zh');
    const englishNotes = toolNotes(record, result, 'en');
    const change = changeOf(record.tool ?? '', record.args ?? {});
    // 记录里有的那一格优先：它跟着记录走，重开这份会话也还在。
    const duration = typeof record.durationMs === 'number' ? record.durationMs
      : options.startedAt === undefined ? undefined : (options.now ?? Date.now()) - options.startedAt;
    if (duration !== undefined) {
      notes.push(secondsNote(duration));
      englishNotes.push(secondsNote(duration, 'en'));
    }
    return [{
      id: nextId(),
      kind,
      tool: typeof payload.effectiveCapability === 'string'
        ? payload.effectiveCapability
        : capabilityOf(record.tool, record.args),
      code: result.code,
      callId: record.callId,
      summary: change.summary,
      diff: change.diff,
      notes,
      english: { notes: englishNotes, summary: changeOf(record.tool ?? '', record.args ?? {}, 'en').summary },
      // 失败与未允许那一格带着说不出去的原因，正文读它，不读那层信封（D93）。
      text: typeof payload.text === 'string' ? payload.text : textOf(result.reason ?? result.content),
    }];
  }
  return [];
}
