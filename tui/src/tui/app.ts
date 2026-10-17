// 终端界面的行、输入与状态（D33 的第二种客户端）。这里不读帧也不写帧：帧由 core/src/host/connection.ts 那一层交进来，
// 这一层只把会话记录与流式增量画成行，并把按键变成协议里的调用。
// 纯函数（editDraft、foldText、projectRecord、branchOf、detailTitle 与 commands.ts 里那几张表）都从这里交出去，
// 检查在 test/tui.test.js，不靠真终端也能验；画面本身跑 `ligule` 看。
import { resolve } from 'node:path';
import { createElement as h, Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Static, Text, useApp, useInput, usePaste } from 'ink';
import { SESSION_ROWS, answerOf, candidatesOf, describeChange, findLines, findUiCommand, insertMention, localizedCommand, mentionToken, resolveSessionId, routeInput, sessionLines } from './commands.js';
import { pushHistory } from '@ligule/core/kernel/input-history.js';
import { searchHistory } from './history.js';
import { editInExternalEditor } from './editor.js';
import { copyToClipboard, lastAnswer } from './clipboard.js';
import { titleEscape, titleText } from './output.js';
import { runtimeFailureText } from './errors.js';
import { capabilityOf, projectRecord, resultParts, type TranscriptItem, type TuiRecord } from './transcript.js';
import { VERSION } from '../version.js';
import { ChoicePanel, HelpPanel, type PanelChoice } from './panels.js';
import { markdownLines } from './markdown.js';
import { selectedText, transcriptLines, viewportPosition, wrapLine } from './viewport.js';
import { CURRENT, ENGLISH_LABELS, ENGLISH_VIEWS, KEYMAP, applyOverrides, conflictsIn, defaultSpecs, formatKeys, hit, keyHint, parseSpec } from './keymap.js';
import { displayWidth } from './commands.js';
import { textOf as chooseText, type Locale } from '@ligule/core/kernel/locale.js';
import type { InkKey, TerminalAction } from './keymap.js';
import type { MarkdownLine } from './markdown.js';
import type { SessionEvent, SessionHeader } from '@ligule/core/session/format.js';
import type { SessionSummary } from '@ligule/core/session/list.js';
import type { AskAnswer, AskQuestion } from '@ligule/core/tools/ask-user.js';
import type { Connection, HostRequest } from '@ligule/core/host/connection.js';
import type { TemplateCommand } from './commands.js';
import type { EditorOutcome } from './editor.js';
import type { SavedInput } from './input-store.js';
import type { PathListing } from '@ligule/core/host/paths.js';
import type { Exported } from '@ligule/core/host/export.js';
import type { BranchResult } from '@ligule/core/session/branch.js';
import type { SearchHit } from '@ligule/core/session/search.js';
import type { ModelSelection, ModelService } from '@ligule/core/kernel/model-services.js';
import type { LoopResult } from '@ligule/core/kernel/loop.js';
import type { CredentialStatus } from '@ligule/core/kernel/credentials.js';

const SPINNER = ['⠋', '⠙', '', '⠸', '⠼', '⠴', '⠦', '', '⠇', '⠏'];
const FOLD_LINES = 3;
// 模式来自哪一层，画给人看的是中文，记录里那三个名字与装载那一侧一致（D43）。
const MODE_LAYERS: Readonly<Record<string, string>> = { shipped: '随包', user: '全局', project: '项目' };
// 清单最多画几行：再长就把屏幕顶到输入框以外，人看不到自己在敲什么。
const CANDIDATE_ROWS = 6;
// 路径候选一次问宿主 8 条：这一处画的是文件名，多几行也读不完，而宿主的 `limit` 比它更宽。
const MENTION_ROWS = 8;
// 「没在问哪一段」的形状：真实的落笔处起点不可能是 -1，所以它跟任何一段都对不上。
const NO_TOKEN = { start: -1, text: '' } as const;
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === 'string' ? error.code : undefined;
}

function errorMessage(error: unknown): string | undefined {
  if (error instanceof Error) return error.message;
  return isRecord(error) && typeof error.message === 'string' ? error.message : undefined;
}

function isSessionEvent(value: unknown): value is SessionEvent {
  return isRecord(value) && typeof value.seq === 'number'
    && (value.kind === undefined || typeof value.kind === 'string');
}

function isAskQuestion(value: unknown): value is AskQuestion {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.question === 'string'
    && typeof value.multiSelect === 'boolean'
    && Array.isArray(value.options)
    && value.options.every((option) => isRecord(option) && typeof option.label === 'string');
}

interface DraftState {
  readonly draft: string;
  readonly caret: number;
}

interface TuiStatus {
  readonly model?: string | null;
  readonly pendingModel?: string | null;
  readonly mode?: string | null;
  readonly pendingMode?: string | null;
  readonly policy: string;
  readonly policySource?: string;
  readonly tools: readonly string[];
  readonly eventCount: number;
  readonly denials: { readonly consecutive: number; readonly total: number };
  readonly usage?: { readonly estimated: number; readonly window: number; readonly threshold: number } | null;
  readonly progress?: TuiProgress | null;
  readonly templates?: readonly TemplateCommand[];
  readonly [key: string]: unknown;
}

interface TuiProgress {
  readonly phase: 'preparing' | 'model_request' | 'tool_execution' | 'compaction' | 'awaiting_approval' | 'awaiting_input' | 'settling';
  readonly startedAt: number;
  readonly phaseStartedAt: number;
  readonly lastProgressAt: number;
  readonly modelCalls: number;
  readonly toolCalls: number;
  readonly outputTokens: number | null;
}

interface DetailState {
  readonly seq: number | null;
  readonly kind: string;
  readonly branch?: string;
  readonly rows: readonly TranscriptItem[];
  readonly cursor?: number;
  readonly offset?: number;
  readonly anchor?: number | null;
  readonly loading?: boolean;
}

interface SessionPickerState {
  readonly items: readonly SessionSummary[];
  readonly at: number;
}

interface SearchState {
  readonly query: string;
  readonly at: number;
}

type PickerKind = 'model' | 'mode' | 'policy';
interface RuntimeChoice extends PanelChoice {
  readonly selection?: ModelSelection;
}

interface MentionState {
  readonly paths: readonly string[];
  readonly chosen: number;
  readonly start: number;
  readonly text: string;
  readonly stopped: 'pending' | 'error' | 'budget' | 'unreadable' | 'done' | '';
  readonly failed?: string;
}

interface AskState {
  readonly id: string;
  readonly tool: string;
  readonly detail: string;
  readonly change: string;
  readonly content: string;
  readonly backend: string;
  readonly reason: string;
}

interface TuiInfo {
  readonly model?: string;
  readonly boundary?: string;
  readonly editor?: string;
}

interface TuiInputHistory {
  entries: string[];
  remember(text: string): Promise<string[]>;
}

interface AppProps {
  readonly client: TuiClient;
  readonly sessionId: string;
  readonly info?: TuiInfo;
  readonly interactive?: boolean;
  readonly stdout?: NodeJS.WriteStream;
  readonly history?: TuiInputHistory;
  readonly inputs?: {
    read(projectRoot: string, sessionId: string): Promise<SavedInput>;
    write(projectRoot: string, sessionId: string, draft: string, queued: readonly string[]): Promise<void>;
  };
  readonly keys?: {
    read(): Promise<{ overrides: Record<string, string>; refused: string[] }>;
    write(overrides: Record<string, string>): Promise<void>;
  };
  readonly locale?: Locale;
  readonly trust?: { revoke(): Promise<void> };
  readonly modes?: { read(): Promise<readonly { readonly name: string; readonly layer: string }[]> };
}

interface UndoState {
  stack: DraftState[];
  future: DraftState[];
  kind: 'insert' | 'text' | null;
  before: DraftState;
}

function isEditorText(outcome: EditorOutcome): outcome is { readonly text: string } {
  return 'text' in outcome && typeof outcome.text === 'string';
}

interface SessionInputState {
  readonly queue: string[];
  readonly queuePaused: boolean;
  readonly draft: string;
}

interface SessionPage {
  readonly sessionId: string;
  readonly events: SessionEvent[];
  readonly header: SessionHeader | null;
  readonly endSeq: number | null;
  readonly hasMore: boolean;
}

interface TuiConfigResult extends Record<string, unknown> {
  readonly services: ModelService[];
  readonly selection: ModelSelection | null;
  readonly model?: { readonly model?: string; readonly apiKeyEnv?: string };
}

interface TuiRequestResults {
  readonly 'session.create': { readonly sessionId: string };
  readonly 'session.open': { readonly sessionId: string };
  readonly 'session.close': { readonly sessionId: string };
  readonly 'session.read': SessionPage;
  readonly 'session.export': Exported;
  readonly 'session.branch': BranchResult;
  readonly 'session.label': { readonly sessionId: string; readonly name: string; readonly archived: boolean };
  readonly 'sessions.list': { readonly sessions: SessionSummary[] };
  readonly 'sessions.search': { readonly hits: SearchHit[] };
  readonly 'paths.list': PathListing;
  readonly 'run.start': LoopResult;
  readonly 'run.cancel': { readonly cancelled: boolean };
  readonly 'status.get': TuiStatus;
  readonly 'model.select': { readonly model: string | null; readonly serviceId: string; readonly when: 'now' | 'round' };
  readonly 'config.get': TuiConfigResult;
  readonly 'credentials.status': CredentialStatus;
  readonly 'mode.set': { readonly mode: string | null; readonly layer: string | null; readonly pending: string | null; readonly tools: string[] };
  readonly 'policy.set': { readonly policy: string; readonly policySource: string; readonly policyDefault: string };
  readonly 'session.compact': { readonly sessionId: string; readonly [key: string]: unknown };
}

export interface TuiClient extends Omit<Connection, 'request'> {
  request<Method extends keyof TuiRequestResults>(method: Method, params?: Record<string, unknown>): Promise<TuiRequestResults[Method]>;
}

function isTerminalAction(value: string): value is TerminalAction {
  return Object.hasOwn(KEYMAP, value);
}

function requestFailure(error: unknown, fallback: string): { readonly code: string } {
  return { code: errorCode(error) ?? fallback };
}

interface QuestionState {
  readonly id: string;
  readonly questions: readonly AskQuestion[];
  readonly at: number;
  readonly picked: Readonly<Record<string, { readonly raw: string; readonly answer: AskAnswer | null }>>;
  readonly answers?: readonly (AskAnswer | null | undefined)[];
  readonly custom?: string;
}

// 那几张表与那几个纯函数交给检查里用（test/tui.test.js），界面自己只走这一处出口。
export { SESSION_ROWS, UI_COMMANDS, answerOf, candidatesOf, describeChange, displayWidth, findLines, findUiCommand, insertMention, mentionToken, resolveSessionId, routeInput, sessionLines } from './commands.js';
export { KEYMAP, CURRENT, applyOverrides, conflictsIn, defaultSpecs, formatKeys, hit, keyHint, parseSpec, specOf } from './keymap.js';
export { markdownLines } from './markdown.js';

// 草稿的编辑：左右移光标、Home/End 与 Ctrl+A/E 跳两端、Ctrl+W 删前一个词、Ctrl+U 清空、其余可打印字符插在光标处。
export function editDraft(draft: string, caret: number, input: string, key: InkKey): DraftState {
  const boundaries = [...GRAPHEMES.segment(draft)].map((part) => part.index);
  const previous = boundaries.filter((index) => index < caret).at(-1) ?? 0;
  const next = boundaries.find((index) => index > caret) ?? draft.length;
  if (key.leftArrow) return { draft, caret: previous };
  if (key.rightArrow) return { draft, caret: next };
  if (key.home || (key.ctrl && input === 'a')) return { draft, caret: 0 };
  if (key.end || (key.ctrl && input === 'e')) return { draft, caret: draft.length };
  if (key.ctrl && input === 'u') return { draft: '', caret: 0 };
  if (key.ctrl && input === 'w') {
    // 先跳过光标前的空白，再删一个词：连着空白一起删会让「rm -rf  」整段消失。
    const head = draft.slice(0, caret).replace(/\s+$/, '').replace(/[\p{L}\p{N}_.\-/]+$/u, '');
    return { draft: head + draft.slice(caret), caret: head.length };
  }
  if (key.backspace || key.delete) {
    if (caret === 0) return { draft, caret };
    return { draft: draft.slice(0, previous) + draft.slice(caret), caret: previous };
  }
  if (input === '' || key.ctrl || key.meta) return { draft, caret };
  return { draft: draft.slice(0, caret) + input + draft.slice(caret), caret: caret + input.length };
}

// 撤销的「一个单位」怎么划：连着在末尾打出来的字算一个单位，退格、删词、粘贴、换行各算一个（方案 6.1）。
// 划线段的判据只有这一个：前一份是后一份的开头、多出来的正好是一个字素、那一头落在末尾、且不是空白。
// 空白单独成一段，打错「两个字之间的那个空格」时能退回打空格之前，而不是整句一起没。
export function isTypingRun(before: DraftState, after: DraftState): boolean {
  if (before.caret !== before.draft.length || after.caret !== after.draft.length) return false;
  if (!after.draft.startsWith(before.draft)) return false;
  const parts = [...GRAPHEMES.segment(after.draft.slice(before.draft.length))];
  return parts.length === 1 && !/\s/u.test(parts[0].segment);
}

const textOf = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value ?? '', null, 2));

// 长内容默认折起来：行数与字数各给一个上限，剩下的一行说明还有多少字（Ctrl+O 展开）。
// 只按行数折的话，一段没有换行的 JSON 会整块压在屏幕上。
export function foldText(text: unknown, expanded: boolean, limit = FOLD_LINES, maxChars = 400): { shown: string; hidden: number } {
  const full = textOf(text);
  if (expanded === true) return { shown: full, hidden: 0 };
  const lines = full.split('\n');
  const shown = lines.length > limit ? lines.slice(0, limit).join('\n') : full;
  const cut = shown.length > maxChars ? shown.slice(0, maxChars) : shown;
  return { shown: cut, hidden: full.length - cut.length };
}

export { capabilityOf, projectRecord, resultParts };

// 状态行上的那一段上下文压力：当前投影的估算、窗口，外加越线没有（D82）。没写窗口时宿主交出 null，这一段整块不出现。
// 估算是本地量法乘上端点报回的修正系数，前面那个波浪号说的是它不是端点给的确数。
interface ContextUsage {
  readonly estimated: number;
  readonly window: number;
  readonly threshold: number;
}

export function contextSegment(usage: ContextUsage | null | undefined, locale: Locale = 'zh'): string {
  if (usage === null || usage === undefined) return '';
  return `ctx:~${usage.estimated}/${usage.window}${usage.estimated > usage.threshold ? chooseText(locale, ' 超限', ' over limit') : ''}`;
}

// 元数据行保留会话、目录、上下文和运行状态；模型与控制入口在输入框下单独显示。
// 宽度不足时先缩短目录，再隐藏上下文和记录数，保留取消提示。
interface StatusLineOptions {
  readonly sessionId: string;
  readonly boundary?: string;
  readonly status: TuiStatus | null;
  readonly running: boolean;
  readonly seconds: number;
  readonly expanded: boolean;
  readonly columns?: number;
  readonly locale?: Locale;
  readonly now?: number;
}

export function buildStatusLine({ sessionId, boundary, status, running, seconds, expanded, columns, locale = 'zh', now = Date.now() }: StatusLineOptions): string {
  const t = (zh: string, en: string) => chooseText(locale, zh, en);
  const id = `${chooseText(locale, '会话', 'session')} ${sessionId.slice(0, 8)}`;
  const root = boundary === undefined ? '' : boundary;
  let base = `${id}${root === '' ? '' : ` · ${root}`}`;
  if (status === null) return base;
  const context = contextSegment(status.usage, locale);
  const parts: string[] = [];
  if (context !== '') parts.push(context);
  const progress = status.progress;
  const phaseHint = progress === undefined || progress === null ? '' : {
    preparing: t('准备上下文', 'Preparing context'),
    model_request: t('请求模型', 'Requesting model'),
    tool_execution: t('执行工具', 'Running tools'),
    compaction: t('压缩上下文', 'Compacting context'),
    awaiting_approval: t('等待审批', 'Waiting for approval'),
    awaiting_input: t('等待用户输入', 'Waiting for your input'),
    settling: t('正在收尾', 'Finishing'),
  }[progress.phase];
  const idleSeconds = progress === undefined || progress === null ? 0 : Math.max(0, Math.floor((now - progress.lastProgressAt) / 1000));
  const progressHint = running && progress !== undefined && progress !== null
    ? `${phaseHint} · ${progress.modelCalls} ${t('次模型调用', 'model calls')} · ${progress.toolCalls} ${t('个工具调用', 'tool calls')} · ${idleSeconds}${t('秒无新进展', 's without progress')}${progress.outputTokens === null ? '' : ` · ${progress.outputTokens} ${t('输出token', 'output tokens')}`}`
    : '';
  // 打断与展开那两句跟在条数之后：挤的时候条数先走，这两句留着。
  const hints = (running ? `${progressHint === '' ? '' : ` · ${progressHint}`}${t(` · ${Math.floor(seconds)} 秒，${keyHint('interrupt')} 打断`, ` · ${Math.floor(seconds)}s, ${keyHint('interrupt')} to stop`)}` : '')
    + (expanded ? t(` · 已展开（${keyHint('expand-or-history')} 收起）`, ` · expanded (${keyHint('expand-or-history')} to close)`) : '');
  let tail = `${chooseText(locale, `记录 ${status.eventCount} 条`, `${status.eventCount} events`)}${hints}`;
  let shown = parts;
  // 列数读不到时不裁：宁可让终端自己折行，也不要按一个猜的宽度丢东西。
  const line = () => [base, ...shown, tail].filter(part => part !== '').join(' · ');
  const over = () => columns !== undefined && columns > 0 && displayWidth(line()) > columns;
  const leaf = root === '' ? '' : root.split(/[\\/]/).filter(Boolean).pop() ?? '';
  if (over()) base = `${id}${leaf === '' ? '' : ` · ${leaf}`}`;
  if (over()) shown = shown.filter((part) => !part.startsWith('ctx:'));
  if (over()) base = id;
  if (over()) tail = hints === '' ? '' : hints.slice(3);
  if (over() && running && progress !== undefined && progress !== null) {
    shown = [];
    tail = `${phaseHint} · ${idleSeconds}${t('秒无新进展', 's without progress')} · ${keyHint('interrupt')} ${t('打断', 'stop')}`;
    if (over()) base = '';
  }
  return line();
}

// `/show` 要的是记录里那个稳定的序号，不是画面上的第几行：行会随投影变，序号不会（D40）。
export function findRecord(events: readonly TuiRecord[], argument: string): { readonly code: string } | { readonly record: TuiRecord | null } {
  const seq = Number(argument);
  if (!Number.isInteger(seq) || seq < 0) return { code: 'tui_show_needs_a_number' };
  return { record: events.find((event) => event.seq === seq) ?? null };
}

// `/sub` 用的也是同一套序号，指向父记录里那条派生结果：支线会话 id 写在那一条的结果内容里（D71），
// 界面不猜文件名，也不为支线多要一次别的动作（D74）。
export function branchOf(record: TuiRecord | undefined): { readonly code: 'tui_sub_needs_a_branch' } | { readonly sessionId: string } | { readonly code: 'tui_sub_reference_spilled'; readonly spilled: string | undefined } {
  if (record?.kind !== 'tool' || record.tool !== 'subagent') return { code: 'tui_sub_needs_a_branch' };
  const result = isRecord(record.result) ? record.result : undefined;
  const content = isRecord(result?.content) ? result.content : undefined;
  const sessionId = content?.sessionId;
  // 结果内容超过注入上限时整段溢出到文件（I6），那一条记录里就没有 sessionId 这一格。
  if (typeof sessionId !== 'string' || sessionId === '') {
    return { code: 'tui_sub_reference_spilled', spilled: typeof result?.spilled === 'string' ? result.spilled : undefined };
  }
  return { sessionId };
}

// 那一格的标题先说清画的是哪一条线：主干与支线各有一套序号，混着看读出来的是错的因果（D74）。
interface DetailTitleOptions {
  readonly seq: number | null;
  readonly kind: string;
  readonly branch?: string;
}

export function detailTitle(detail: DetailTitleOptions, locale: Locale = 'zh'): string {
  if (detail.branch === undefined) return chooseText(locale, `记录 ${detail.seq}（${detail.kind}）的完整内容 · /show 收起`, `Event ${detail.seq} (${detail.kind}) · /show to close`);
  return chooseText(locale, `支线 ${detail.branch}，父记录第 ${detail.seq} 那一次派生 · 这里的序号是支线自己的 · /sub 收起`, `Subtask ${detail.branch}, from event ${detail.seq} · sequence numbers belong to this subtask · /sub to close`);
}

// 助手的 Markdown 按终端列数排版，代码按语言上色，内容完整保留。
// 强调那几种记号（加粗、斜体、删除线、行内代码）在这一层画出来：范围名到 Ink 那几格的对应只有这一处（第 96 步）。
const MARK_STYLES: Readonly<Record<string, Record<string, unknown>>> = {
  'md-strong': { bold: true },
  'md-em': { italic: true },
  'md-del': { strikethrough: true },
  'md-codespan': { color: 'cyan' },
};
function MarkdownRows({ text, columns = 80 }: { readonly text: string; readonly columns?: number }) {
  const lines = useMemo(() => markdownLines(text, columns), [text, columns]);
  const marked = (line: MarkdownLine) => line.spans?.map((span, part) => h(Text, { key: part, ...(span.scope === undefined ? {} : MARK_STYLES[span.scope] ?? {}) }, span.text)) ?? [];
  return h(Fragment, null, lines.map((line, index) => {
    if (line.kind === 'code') return h(Text, { key: index, wrap: 'wrap' }, '  ', line.spans === undefined ? line.text : line.spans.map((span, part) => {
      const scope = span.scope?.split('.')[0];
      const codeColors: Readonly<Record<string, string>> = { keyword: 'magenta', string: 'green', number: 'yellow', comment: 'gray', title: 'cyan', literal: 'yellow', built_in: 'cyan' };
      const color = scope === undefined ? undefined : codeColors[scope];
      return h(Text, { key: part, color }, span.text);
    }));
    if (line.kind === 'heading') return h(Text, { key: index, bold: true, wrap: 'wrap' }, line.spans === undefined ? line.text : marked(line));
    if (line.spans !== undefined) return h(Text, { key: index, wrap: 'wrap' }, marked(line));
    return h(Text, { key: index, wrap: 'wrap' }, line.text);
  }));
}

// 审批问的是「要不要做这一件」，那一句改动得先看得见：写入类工具的参数里带着全文或那两段，界面上算个行数就够。
export function changeSummary(tool: string, args: Record<string, unknown>, locale: Locale = 'zh'): string {
  return describeChange(tool, args, locale).summary;
}

// 审批框展开的那一段：写入类那三件说清实际动的是哪一件、要去掉哪一段、要换上哪一段（方案 5.4）。
// 两段内容都带行首的减号与加号，读的人不必自己对照；没读过的正文不画，删除那一条只说移进回收站。
function approvalBody(tool: string, args: Record<string, unknown>, locale: Locale = 'zh'): string {
  const t = (zh: string, en: string) => chooseText(locale, zh, en);
  const change = describeChange(tool, args, locale);
  if (change.action === '') return typeof args.content === 'string' ? args.content : JSON.stringify(args, null, 2);
  const marked = (text: string, sign: string) => (text === '' ? [`${sign}${t('（空）', '(empty)')}`] : text.split('\n').map((line) => `${sign} ${line}`));
  return [change.action,
    ...(change.before === '' ? [] : [t('原内容:', 'Before:'), ...marked(change.before, '-')]),
    ...(change.after === '' ? [] : [t('新内容:', 'After:'), ...marked(change.after, '+')]),
  ].join('\n');
}

function Row({ row, expanded, columns, locale = 'zh' }: { readonly row: TranscriptItem; readonly expanded: boolean; readonly columns: number; readonly locale?: Locale }) {
  const t = (zh: string, en: string) => chooseText(locale, zh, en);
  if (row.kind === 'question') return h(Text, { color: 'cyan' }, `› ${row.text}`);
  if (row.kind === 'reasoning') {
    const folded = foldText(row.text, expanded, 1);
    return h(Fragment, null,
      h(Text, { dimColor: true, wrap: 'truncate-end' }, t(`· 推理 ${folded.shown}`, `· Reasoning ${folded.shown}`)),
      folded.hidden > 0 ? h(Text, { dimColor: true }, t(`  …还有 ${folded.hidden} 字，${keyHint('expand-or-history')} 展开`, `  …${folded.hidden} more characters; ${keyHint('expand-or-history')} to expand`)) : null);
  }
  if (row.kind === 'answer') return h(MarkdownRows, { text: row.text, columns });
  if (row.kind === 'call') return h(Text, { color: 'yellow' }, `→ ${row.tool} ${foldText(row.text, expanded, 1).shown}`);
  if (row.kind === 'result') {
    const folded = foldText(row.text, expanded);
    // 抬头那一行说的是这一件做成了什么：命令带退出码，溢出带那个文件名（I6 的那一条引用要看得见）。
    const note = [row.exitCode === undefined ? '' : t(`退出码 ${row.exitCode}`, `exit ${row.exitCode}`), row.spilled === undefined ? '' : t(`整段在 ${row.spilled}`, `full result: ${row.spilled}`)].filter((part) => part !== '').join(' · ');
    return h(Fragment, null,
      h(Text, { color: 'green' }, `✓ ${row.tool}${note === '' ? '' : `（${note}）`}`),
      folded.shown === '' ? null : h(Text, { dimColor: true, wrap: 'truncate-end' }, folded.shown),
      folded.hidden > 0 ? h(Text, { dimColor: true }, t(`  …还有 ${folded.hidden} 字，${keyHint('expand-or-history')} 展开`, `  …${folded.hidden} more characters; ${keyHint('expand-or-history')} to expand`)) : null);
  }
  if (row.kind === 'refusal') return h(Text, { color: 'magenta' }, t(`✗ ${row.tool} 已拒绝（${row.code}）`, `✗ ${row.tool} denied (${row.code})`));
  if (row.kind === 'failure') return h(Text, { color: 'red' }, `✗ ${row.tool} ${row.code ?? ''} ${row.text}`);
  if (row.kind === 'meta') return h(Text, { dimColor: true }, `· ${row.text}`);
  return h(Text, { color: 'red' }, `! ${row.text}`);
}

// 队列里那一条画之前先裁短：一行装不下一整句话，而这一格的作用只是让人看见排了几条。
export function queuedLine(text: string, limit = 64): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

// 一道题在画面上怎么写：选中的那几条与自由回答各占一段，两样都没有就说这一格是空的（D107）。
// `undefined` 是还没走到那一题，`null` 是走到过、回车交的是空的一句——两者交回宿主之后都记成「没有回答」，画面上要说清是哪一种。
const answeredLine = (answer: AskAnswer | null | undefined, locale: Locale = 'zh') => answer === undefined ? chooseText(locale, '尚未回答', 'Not answered')
  : answer === null ? chooseText(locale, '已跳过', 'Skipped')
  : [answer.selected.join(', '), answer.custom].filter((one) => one !== '' && one !== undefined).join('; ') || chooseText(locale, '未回答', 'Not answered');

// 那一格下面说的是「怎么答」：有选项时要把编号那条写出来，人不然只会照着题面写一句自由回答（D107）。
const optionHint = (question: AskQuestion, locale: Locale = 'zh') => question.options.length === 0
  ? chooseText(locale, '输入回答', 'Type your answer')
  : question.multiSelect ? chooseText(locale, '输入回答或多个选项编号', 'Type an answer or multiple option numbers') : chooseText(locale, '输入回答或选项编号', 'Type an answer or an option number');

// 没有把那一份共用文件接进来时（调用方不给了历史）的历史：句子仍留在这一个进程里，退出就不在了。
// 模块级一份：`remember` 交回写完的清单是这一格的合同，每次渲染新建一个对象会让界面的依赖一路变。
const processHistory: TuiInputHistory = {
  entries: [],
  remember: async (text) => {
    processHistory.entries = pushHistory(processHistory.entries, text);
    return processHistory.entries;
  },
};

export function App({ client, sessionId: firstSessionId, info = {}, interactive = true, stdout, history = processHistory, inputs, keys, trust, modes, locale = 'zh' }: AppProps) {
  const t = useCallback((zh: string, en: string) => chooseText(locale, zh, en), [locale]);
  const app = useApp();
  const [sessionId, setSessionId] = useState(firstSessionId);
  const activeSession = useRef(sessionId);
  const terminalReceived = useRef(false);
  activeSession.current = sessionId;
  const [geometry, setGeometry] = useState({ columns: stdout?.columns ?? 80, rows: stdout?.rows ?? 24 });
  const [rows, setRows] = useState<TranscriptItem[]>([]);
  const [live, setLive] = useState({ text: '', reasoning: '' });
  const [ask, setAsk] = useState<AskState | null>(null);
  // 模型的提问（D107）：一次请求一到四道题，答一道前进一道，答完最后一道才把答复交回去。
  const [query, setQuery] = useState<QuestionState | null>(null);
  const [running, setRunning] = useState(false);
  const [tick, setTick] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [panel, setPanel] = useState<PickerKind | 'help' | null>(null);
  const [choices, setChoices] = useState<RuntimeChoice[]>([]);
  const [choicesLoading, setChoicesLoading] = useState(false);
  const pickerRequest = useRef(0);
  const [draft, setDraft] = useState('');
  const [caret, setCaret] = useState(0);
  // 草稿的撤销栈（方案 6.1）：人在这一格里改出来的每一段，落笔时先把当时那一格的草稿与光标留下来，Ctrl+Z 退回它、Ctrl+Y 再拿回来。
  // 只留在这一次打开的内存里：跨退出留住的是第 84 步那两格，退出之后退回刚才打的字没有意义。
  // stack 与 future 各 100 份（ponytail: 上限写在这一处，一句草稿远够用；要更长就换成按字节预算的环形缓冲）。
  const undo = useRef<UndoState>({ stack: [], future: [], kind: null, before: { draft: '', caret: 0 } });
  useEffect(() => {
    const cell = undo.current;
    const current = { draft, caret };
    const previous = cell.before;
    cell.before = current;
    if (current.draft === previous.draft) { cell.kind = null; return; }
    const run = isTypingRun(previous, current);
    // 连着打的字并上一个单位：退一次是一段，不是一个字符。
    if (run && cell.kind === 'insert') return;
    cell.stack = [...cell.stack.slice(-99), previous];
    cell.kind = run ? 'insert' : 'text';
  }, [draft, caret]);
  // 草稿整份换掉的那几处走这一条：那不是一次可退回的改动，清空栈也别让 Ctrl+Z 把另一份会话的草稿翻回来。
  const resetDraft = useCallback((text: string) => {
    const cell = undo.current;
    cell.stack = [];
    cell.future = [];
    cell.kind = null;
    cell.before = { draft: text, caret: text.length };
    setDraft(text);
    setCaret(text.length);
  }, []);
  // 输入历史跨会话留住（D81 边界二：它存在界面自己那一份文件里，不进会话记录）。
  // 文件里的先后就是这里的先后，最新的排在第一个，上下键从第一个往下翻就是往旧处翻。
  const [entries, setEntries] = useState(history.entries);
  const [historyAt, setHistoryAt] = useState(-1);
  const [historyDraft, setHistoryDraft] = useState('');
  // Ctrl+R 那一次反查：查询串与移到第几条匹配；不在反查中时这一格是 null。
  const [search, setSearch] = useState<SearchState | null>(null);
  const [status, setStatus] = useState<TuiStatus | null>(null);
  // 详情画在动态区里：`Static` 不回画已提交的行，所以「看那一条」只能是把它再画一次（D39、D40）。
  const [detail, setDetail] = useState<DetailState | null>(null);
  // 斜杠输入时的选中位置：候选每次从草稿现算，这里只记住人移到第几条（D81）。
  const [pick, setPick] = useState(0);
  // Esc 收起候选时记下收起的是哪一段草稿：改一个字就该重新露出来，不需要另一个开关。
  const [dismissedAt, setDismissedAt] = useState<string | null>(null);
  // 跑着的那一轮里回车排进来的那几条：只在界面一侧，不进记录也不进内核（D81 边界二）。
  const [queue, setQueue] = useState<string[]>([]);
  // 取消这一轮之后队列停下等人：剩余的那几条不自己发出去（方案 5.2）。
  const [queuePaused, setQueuePaused] = useState(false);
  // 落笔处那一段 `@` 路径引用的候选：清单由宿主列出来，界面不开盘（方案 5.3、D81 边界一）。
  const [mention, setMention] = useState<MentionState | null>(null);
  // Esc 收起的是当下这一个词：接着改字会重新问，原样不动时不再弹出来挡住输入。
  const [hiddenMention, setHiddenMention] = useState('');
  const mentionWanted = useRef<ReturnType<typeof mentionToken> | typeof NO_TOKEN>(NO_TOKEN);
  const mentionAsked = useRef<ReturnType<typeof mentionToken> | typeof NO_TOKEN>(NO_TOKEN);
  // 退出之后流已经关了：那时候再落一行会让 Ink 往关掉的输出上写，报出来的是 `write after end`，
  // 而不是那一句真正想说的话。这一格只用来让迟到的答复与状态刷新不再往画面上写。
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const push = useCallback((...added: TranscriptItem[]) => {
    if (!alive.current) return;
    setRows((current) => [...current, ...added]);
  }, []);
  // 个人键位那一份覆盖读自本机的另一份文件，写也写回那里：不进记录、不进模型上下文、不进项目的业务配置（方案 6.1、D81 边界二）。
  const [keyOverrides, setKeyOverrides] = useState<Record<string, string>>({});
  useEffect(() => {
    if (keys === undefined) return;
    void (async () => {
      const loaded = await keys.read().catch((error: unknown) => ({ overrides: {}, refused: [t(`无法读取：${errorCode(error) ?? errorMessage(error) ?? 'unknown'}`, `Could not read: ${errorCode(error) ?? errorMessage(error) ?? 'unknown'}`)] }));
      const outcome = applyOverrides(loaded.overrides);
      const applied: Record<string, string> = {};
      for (const action of outcome.applied) applied[action] = CURRENT[action];
      setKeyOverrides(applied);
      const refused = [...loaded.refused, ...outcome.refused];
      // 落不下来的那几条一条条说出来：剩下的那些照样按默认那一份走，但「你以为改掉了其实没有」这件事要说得见。
      if (refused.length > 0) push({ kind: 'meta', text: t(`${refused.length} 项快捷键无效，使用默认值：${refused.join('、')}`, `${refused.length} invalid shortcuts use defaults: ${refused.join(', ')}`) });
      else if (outcome.applied.length > 0) push({ kind: 'meta', text: t(`已加载 ${outcome.applied.length} 项自定义快捷键（/bind 查看）`, `Loaded ${outcome.applied.length} custom shortcuts (/bind to browse)`) });
    })();
  }, [keys, push, t]);
  // 排着的那几条与草稿都属于那一份会话：换看别的一份时把这一份收起来，换回来再摊开——
  // 既不把没发的话送到另一份会话里，也不把它丢掉（方案 5.2「队列按会话隔离」）。
  const inputState = useRef(new Map<string, SessionInputState>());
  const viewedSession = useRef(sessionId);
  useEffect(() => {
    if (viewedSession.current === sessionId) return;
    inputState.current.set(viewedSession.current, { queue, queuePaused, draft });
    const saved = inputState.current.get(sessionId);
    setQueue(saved?.queue ?? []);
    setQueuePaused(saved?.queuePaused ?? false);
    resetDraft(saved?.draft ?? '');
    viewedSession.current = sessionId;
  }, [draft, queue, queuePaused, sessionId]);

  // 退出之前没发出去的那一句与排着的几句留在本机这一份文件里：接上哪一份会话就读哪一份（方案 5.1）。
  // 只在本次没摊开过的那一份上读一次；读回来时人已切走的丢掉，不盖到另一份的草稿上。
  const inputNow = useRef({ draft: '', queue: [] as string[] });
  inputNow.current = { draft, queue };
  useEffect(() => {
    if (inputs === undefined) return;
    const own = sessionId;
    const root = info.boundary ?? '';
    if (inputState.current.has(own)) return;
    void (async () => {
      const saved = await inputs.read(root, own);
      if (viewedSession.current !== own) return;
      inputState.current.set(own, { queue: saved.queued, queuePaused: saved.queued.length > 0, draft: saved.draft });
      // 那一句读回来的路上人已经自己敲了字：以他敲的为准，不拿一份旧的盖过去。
      if (saved.draft !== '' && inputNow.current.draft === '') resetDraft(saved.draft);
      // 排着的几句恢复成暂停：那几句当时还没发出去，重启之后自己发是替人做了他没要的决定（方案 5.2）。
      if (saved.queued.length > 0 && inputNow.current.queue.length === 0) {
        setQueue(saved.queued);
        setQueuePaused(true);
      }
    })().catch(() => inputState.current.delete(own));
  }, [info.boundary, inputs, sessionId]);

  // 手停下来 400 毫秒才写这一份：敲字那一段不碰磁盘，而退出与崩溃前那一句已经落下了。
  useEffect(() => {
    if (inputs === undefined) return;
    const own = sessionId;
    const root = info.boundary ?? '';
    const timer = setTimeout(() => {
      void inputs.write(root, own, draft, queue).catch(() => push({ kind: 'error', text: t('无法保存草稿和队列，请复制后再退出', 'Could not save draft and queue; copy your input before exiting') }));
    }, 400);
    return () => clearTimeout(timer);
  }, [draft, info.boundary, inputs, push, queue, sessionId, t]);

  // 落笔处那一段 `@` 交给宿主去列：等手停下 160 毫秒再问一次，答回来时那一段已经变了就丢掉（方案 5.3）。
  // 传输那一层没有中途取消的办法，所以「慢请求可取消」在这儿做到的是「不落到画面上」。
  useEffect(() => {
    const token = mentionToken(draft, caret);
    if (token === null) { setMention(null); mentionAsked.current = NO_TOKEN; return; }
    mentionWanted.current = token;
    if (hiddenMention === token.text) { mentionAsked.current = NO_TOKEN; return; }
    // 「上一次问的是哪一段」放在 ref 而不是 state：写进 state 会让本条 effect 重跑，
    // 那一次重跑先把已经排好的那一下问撤销掉，接着又因为这一段没变而不再重问，画面就停在等那一下上。
     const asked = mentionAsked.current;
     if (asked !== null && asked.start === token.start && asked.text === token.text) return;
    // 换了一个词就把手里那几条旧的候选放下：清单留着，Enter 就会把人没选过的那一条插进去。
    mentionAsked.current = token;
    setMention({ ...token, paths: [], chosen: 0, stopped: 'pending' });
    const timer = setTimeout(() => {
      void (async () => {
        const listed = await client.request('paths.list', { projectRoot: info.boundary, query: token.text, limit: MENTION_ROWS })
          .catch((error: unknown) => ({ code: errorCode(error) ?? 'paths_list_failed' }));
        const now = mentionWanted.current;
        if (now === null || now.start !== token.start || now.text !== token.text) return;
        setMention('code' in listed
          ? { ...token, paths: [], stopped: 'error', failed: listed.code, chosen: 0 }
          : { ...token, paths: listed.paths, stopped: listed.stopped, chosen: 0 });
      })();
    }, 160);
    return () => clearTimeout(timer);
  }, [caret, client, draft, hiddenMention, info.boundary]);
  const [sessionPicker, setSessionPicker] = useState<SessionPickerState | null>(null);
  const [approvalExpanded, setApprovalExpanded] = useState(false);
  const [approvalCursor, setApprovalCursor] = useState(0);

  const refreshStatus = useCallback(async () => {
    // 界面已经收掉了：这一处不去敲那条已经关掉的连接，免得一次迟到的收尾变成一条没人接的错误。
    if (!alive.current) return;
    try {
      const current = await client.request('status.get', { sessionId });
      if (activeSession.current === sessionId) setStatus(current);
    } catch (error) {
      if (activeSession.current !== sessionId) return;
      setStatus(null);
      push({ kind: 'error', text: t(`无法读取状态：${errorCode(error) ?? errorMessage(error) ?? String(error)}`, `Could not read status: ${errorCode(error) ?? errorMessage(error) ?? String(error)}`) });
    }
  }, [client, push, sessionId, t]);

  useEffect(() => {
    const resize = () => setGeometry({ columns: stdout?.columns ?? 80, rows: stdout?.rows ?? 24 });
    stdout?.on?.('resize', resize);
    return () => { stdout?.off?.('resize', resize); };
  }, [stdout]);

  useEffect(() => {
    const onNotification = (message: Record<string, unknown>) => {
      if (message.sessionId !== sessionId) return;
      if (message.notify === 'progress') {
        const progress = isRecord(message.progress) ? message.progress as unknown as TuiProgress : null;
        setStatus((current) => current === null ? current : { ...current, running: progress !== null, progress });
        return;
      }
      if (message.notify === 'delta') {
        const delta = isRecord(message.event) ? message.event : undefined;
        const piece = typeof delta?.text === 'string' ? delta.text : '';
        if (delta?.type === 'text') setLive((current) => ({ ...current, text: current.text + piece }));
        else if (delta?.type === 'reasoning') setLive((current) => ({ ...current, reasoning: current.reasoning + piece }));
        return;
      }
      if (message.notify === 'event') {
        if (!isSessionEvent(message.event)) return;
        const event = message.event;
        if (event.kind === 'turn') terminalReceived.current = true;
        // 刚落盘的那一条取代流式期间的那半截：记录是事实源（I5），界面按它重画。
        if (event.kind === 'assistant') setLive((current) => ({ ...current, text: '' }));
        if (event.kind === 'reasoning') setLive((current) => ({ ...current, reasoning: '' }));
        push(...projectRecord(event, locale).map((row) => ({ ...row, seq: event.seq })));
        return;
      }
      if (message.notify === 'fault') push({ kind: 'error', text: `${typeof message.code === 'string' ? message.code : 'host_fault'}：${typeof message.detail === 'string' ? message.detail : ''}` });
    };
    const onRequest = (message: HostRequest) => {
      if (!isRecord(message.params)) return;
      const params = message.params;
      if (message.method === 'question.request') {
        // 终端界面一次盯一份会话：别的那一份问过来的题在这一格里答不了（审批那一条同一处门）。
        const asked = params;
        if (asked.sessionId !== sessionId || !Array.isArray(asked.questions) || asked.questions.length === 0 || !asked.questions.every(isAskQuestion)) return;
        pickerRequest.current += 1;
        setPanel(null);
        setDetail(null);
        setSessionPicker(null);
        setSearch(null);
        setExpanded(false);
        setQuery({ id: message.id, questions: asked.questions, at: 0, picked: {} });
        return;
      }
      if (message.method !== 'approval.request' || params.sessionId !== sessionId || typeof params.tool !== 'string') return;
      pickerRequest.current += 1;
      setPanel(null);
      const args = isRecord(params.args) ? params.args : {};
      setApprovalExpanded(false);
      setApprovalCursor(0);
      setDetail(null);
      setSessionPicker(null);
      setSearch(null);
      setExpanded(false);
      // 画出来的那一行说的是什么对象：命令文本、路径、目标地址，或者那一项 MCP 能力名。
      // 写入类的参数里带着整份文件内容，那一段不进这一行——行数写在下面那一行里，全文走 `/show`。
      const shown = typeof params.command === 'string' ? params.command : typeof args.path === 'string' ? args.path : typeof args.url === 'string' ? args.url : typeof args.server === 'string' ? `mcp:${args.server}/${typeof args.tool === 'string' ? args.tool : ''}` : '';
      setAsk({
        id: message.id,
        tool: params.tool,
        detail: shown === '' ? JSON.stringify(args) : String(shown),
        change: changeSummary(params.tool, args, locale),
        reason: typeof params.reason === 'string' ? params.reason : '',
        content: approvalBody(params.tool, args, locale),
        // 用哪一种语法判的、跑的是哪一个可执行文件：答的是这一条命令，看得见的该是这两样（D59）。
        backend: typeof params.shell === 'string' ? `${params.shell} · ${typeof params.executable === 'string' ? params.executable : ''}` : '',
      });
    };
    client.onNotification(onNotification);
    client.onRequest(onRequest);
    void refreshStatus();
  }, [client, locale, push, refreshStatus, sessionId]);

  // 终端标题画出模型、项目根与这一份会话：切会话时那一串跟着换，任务栏与窗口列表里就能认出是哪一份。
  // 没有真终端时不写：那串转义序列落在管道里会成为别人读到的字节。
  useEffect(() => {
    if (stdout?.isTTY !== true) return;
    stdout.write(titleEscape(titleText({ model: status?.model ?? info.model, boundary: info.boundary, sessionId })));
  }, [info.boundary, info.model, sessionId, status?.model, stdout]);

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

  const remember = useCallback((text: string) => {
    // 发出去的那一句才进历史：排进队列的那几条等真正发出去时各自进一次，翻历史看到的都是真说过的话。
    // 先按眼前这一份排一下，箭头键不必等那一次写；写完再把画面换成锁内那一份清单——另一端那句也跟着进来（方案 5.5.6）。
    setEntries((current) => pushHistory(current, text));
    void history.remember(text).then(
      (written) => setEntries(written),
      (error: unknown) => push({ kind: 'error', text: t(`输入历史保存失败：${errorCode(error) ?? errorMessage(error) ?? 'unknown'}`, `Could not save input history: ${errorCode(error) ?? errorMessage(error) ?? 'unknown'}`) }),
    );
  }, [history, push, t]);

  const submit = useCallback(async (text: string) => {
    remember(text);
    terminalReceived.current = false;
    setLive({ text: '', reasoning: '' });
    setRunning(true);
    try {
      await client.request('run.start', { sessionId, input: text });
      if (!terminalReceived.current) push({ kind: 'meta', text: t('本轮已完成', 'Turn completed') });
    } catch (error) {
      const code = errorCode(error) ?? 'run_failed';
      // 打断落在还在跑的模型调用上时端点那一头交回 `provider_cancelled`，落在两组调用之间才是 `loop_cancelled`，
      // 落在等一个人回答的那一次提问上才是 `ask_user_cancelled`：人要读的是同一句——这一轮是他停下来的（方案 5.2、D107）。
      if (!terminalReceived.current) {
        if (code === 'loop_cancelled' || code === 'provider_cancelled' || code === 'ask_user_cancelled') push({ kind: 'meta', text: t('本轮已取消', 'Turn cancelled') });
        else push({ kind: 'error', text: `${t(`运行失败：${code}`, `Run failed: ${code}`)}${runtimeFailureText(code, locale) === undefined ? '' : `\n${runtimeFailureText(code, locale)}`}` });
      }
    } finally {
      setAsk(null);
      setLive({ text: '', reasoning: '' });
      // 这一轮结束了，还没答完的那几道题也不再有人等：宿主那一侧把取消记成一条结果，画面上这一格跟着收掉（D107）。
      setQuery(null);
      setRunning(false);
      void refreshStatus();
    }
  }, [client, push, refreshStatus, remember, sessionId, t]);

  // 命令一律收到第一个词，后面的整段作为参数交进来（/mode 要用）。
  const closePanel = useCallback(() => {
    pickerRequest.current += 1;
    setPanel(null);
  }, []);

  const exitTui = useCallback((savedDraft = inputNow.current.draft) => {
    if (inputs === undefined) { app.exit(); return; }
    void inputs.write(info.boundary ?? '', sessionId, savedDraft, inputNow.current.queue).then(
      () => app.exit(),
      () => push({ kind: 'error', text: t('无法保存草稿和队列，请复制后重试退出', 'Could not save draft and queue; copy your input and retry exiting') }),
    );
  }, [app, inputs, info.boundary, sessionId, push, t]);

  const openPicker = useCallback((kind: PickerKind) => {
    const token = ++pickerRequest.current;
    const own = sessionId;
    setDetail(null);
    setSessionPicker(null);
    setSearch(null);
    setMention(null);
    setPanel(kind);
    setChoices([]);
    setChoicesLoading(true);
    void (async () => {
      let available: RuntimeChoice[];
      if (kind === 'model') {
        const config = await client.request('config.get', { projectRoot: info.boundary });
        available = config.services.flatMap(service => service.models.map(model => ({
          id: `${service.id}:${model}`, label: `${service.name} / ${model}`, selection: { provider: service.id, model },
        })));
        if (typeof config.model?.model === 'string') available.unshift({
          id: `legacy:${config.model.model}`, label: `${t('默认服务', 'Default service')} / ${config.model.model}`, selection: { provider: 'legacy', model: config.model.model },
        });
      } else if (kind === 'mode') {
        if (modes === undefined) throw new Error('mode_list_unavailable');
        available = (await modes.read()).map(mode => ({ id: mode.name, label: mode.name,
          description: t(`来源：${MODE_LAYERS[mode.layer] ?? mode.layer}。只改变模型可用工具和提示，不授予权限。`, `Source: ${mode.layer}. Selects tools and prompts without granting permissions.`),
        }));
      } else {
        available = [
          { id: 'ask', label: t('逐次审批', 'Ask for each tool'), description: t('工具执行前询问；已有拒绝规则和访问边界继续生效。', 'Ask before tools execute; denial rules and access boundaries still apply.') },
          { id: 'auto', label: t('自动判定', 'Automatic decisions'), description: t('由现有规则判定；仍可能请求审批，访问边界不变。', 'Use the existing rules; approvals may still be requested and access boundaries stay unchanged.') },
          { id: 'reset', label: t('使用配置默认', 'Use configured default'), description: t('撤销当前会话的审批方式覆盖。', 'Clear this session’s approval-mode override.') },
        ];
      }
      if (activeSession.current !== own || pickerRequest.current !== token) return;
      if (kind === 'model' && available.length === 0) {
        setPanel(null);
        push({ kind: 'meta', text: t('尚未配置模型服务', 'No model services configured') });
        return;
      }
      setChoices(available);
      setChoicesLoading(false);
    })().catch((error: unknown) => {
      if (activeSession.current !== own || pickerRequest.current !== token) return;
      setPanel(null);
      push({ kind: 'error', text: t(`无法读取选项：${errorCode(error) ?? errorMessage(error) ?? 'picker_failed'}`, `Could not load choices: ${errorCode(error) ?? errorMessage(error) ?? 'picker_failed'}`) });
    });
  }, [client, info.boundary, modes, push, sessionId, t]);

  const runCommand = useCallback((name: string, argument = '') => {
    if (name === 'trust') {
      if (argument === '') {
        push({ kind: 'meta', text: t(`工作区：${info.boundary ?? ''}\n使用 /trust revoke 撤销信任并退出；工具审批仍按当前设置执行。`, `Workspace: ${info.boundary ?? ''}\nUse /trust revoke to revoke trust and exit. Tool approvals still use the current policy.`) });
      } else if (argument !== 'revoke') {
        push({ kind: 'error', text: t('用法：/trust [revoke]', 'Usage: /trust [revoke]') });
      } else if (trust === undefined) {
        push({ kind: 'error', text: t('此客户端未接入工作区信任存储', 'Workspace trust storage is unavailable in this client') });
      } else {
        void trust.revoke().then(() => exitTui(''), (error: unknown) => push({ kind: 'error', text: t(`无法撤销信任：${errorCode(error) ?? 'tui_trust_failed'}`, `Could not revoke trust: ${errorCode(error) ?? 'tui_trust_failed'}`) }));
      }
      return;
    }
    if (name === 'quit') {
      exitTui('');
      return;
    }
    if (name === 'new') {
      void (async () => {
        try {
          const created = await client.request('session.create', {});
          try {
            await client.request('session.close', { sessionId });
          } catch (error) {
            await client.request('session.close', { sessionId: created.sessionId });
            throw error;
          }
          setSessionId(created.sessionId);
          setDetail(null);
          setSessionPicker(null);
          setRows([]);
          setLive({ text: '', reasoning: '' });
          push({ kind: 'meta', text: t(`新会话 ${created.sessionId.slice(0, 8)}`, `New session ${created.sessionId.slice(0, 8)}`) });
        } catch (error) {
          push({ kind: 'error', text: t(`无法创建会话：${errorCode(error) ?? errorMessage(error) ?? 'unknown'}`, `Could not create session: ${errorCode(error) ?? errorMessage(error) ?? 'unknown'}`) });
        }
      })();
      return;
    }
    if (name === 'copy') {
      void (async () => {
        // 复制的是记录里最后那一条回答：流式期间那半截还没落盘，复制它等于复制一份没成形的文本（I5）。
        const read = await client.request('session.read', { sessionId }).catch((error: unknown) => requestFailure(error, 'session_read_failed'));
        if ('code' in read) {
          push({ kind: 'error', text: t(`无法读取记录：${read.code}`, `Could not read conversation: ${read.code}`) });
          return;
        }
        const answer = lastAnswer(read.events);
        if (answer === '') {
          push({ kind: 'meta', text: t('暂无可复制的回答', 'No answer to copy yet') });
          return;
        }
        const done = await copyToClipboard(answer);
        push('program' in done
          ? { kind: 'meta', text: t('已复制最近的回答', 'Latest answer copied') }
          : { kind: 'error', text: t(`复制失败：${done.code}`, `Copy failed: ${done.code}`) });
      })();
      return;
    }
    if (name === 'export') {
      if (argument === '') {
        push({ kind: 'error', text: t('请指定导出路径：/export <路径>', 'Specify an export path: /export <path>') });
        return;
      }
      void (async () => {
        // 排版与落盘都在宿主那一侧（方案 6A），这里只把人打的那一条路径按当前目录定成目的地：
        // 宿主可能在别的进程里，相对路径要按敲下这一行的位置算。
        const done = await client.request('session.export', { sessionId, path: resolve(argument) }).catch((error: unknown) => requestFailure(error, 'session_export_failed'));
        if ('code' in done) {
          push({ kind: 'error', text: t(`导出失败：${done.code}`, `Export failed: ${done.code}`) });
          return;
        }
        // 没写出去的那几份分两种：那一条支线的记录读不回来，与那一个位置已经有同名文件而这一份没人确认过要不要盖（审阅 F6）。
        for (const item of done.skipped) {
          push({ kind: 'error', text: item.code === 'export_target_exists'
            ? t(`文件已存在，已跳过：${item.path ?? item.id}`, `File already exists; skipped: ${item.path ?? item.id}`)
            : t(`无法读取子任务 ${item.id}：${item.code}`, `Could not read subtask ${item.id}: ${item.code}`) });
        }
        for (const item of done.failed) {
          push({ kind: 'error', text: t(`写入失败：${item.path}（${item.code}）`, `Write failed: ${item.path} (${item.code})`) });
        }
        push({ kind: 'meta', text: t(`已导出 ${done.written.length} 个文件：`, `Exported ${done.written.length} files:`) + `\n${done.written.join('\n')}` });
      })();
      return;
    }
    if (name === 'sessions') {
      void (async () => {
        // 列表来自宿主扫的那一份目录（第 34 步那个扫描器）：界面不去开盘，事实源仍然只有那一份（D81 边界一）。
        const listed = await client.request('sessions.list', { projectRoot: info.boundary }).catch((error: unknown) => requestFailure(error, 'session_list_failed'));
        if ('code' in listed) {
          push({ kind: 'error', text: t(`无法读取会话列表：${listed.code}`, `Could not list sessions: ${listed.code}`) });
          return;
        }
        if (listed.sessions.length === 0) push({ kind: 'meta', text: t('此工作区暂无会话', 'No sessions in this workspace') });
        else {
          setDetail(null);
          setExpanded(false);
          setSearch(null);
          setSessionPicker({ items: listed.sessions, at: 0 });
        }
      })();
      return;
    }
    if (name === 'find') {
      const wanted = argument.trim();
      if (wanted === '') {
        push({ kind: 'meta', text: t('请输入搜索内容：/find <文字>', 'Enter search text: /find <text>') });
        return;
      }
      void (async () => {
        // 查的也是宿主扫的那一份记录目录，界面不开盘（D81 边界一）；交回的是「哪一份会话的第几条」（方案 4.2）。
        // 当前这一份另问一次并指名道姓：那一次结果溢出在文件里的整段正文也进来，跨会话那一种只读到记录留着的那一头一尾。
        const [listed, deep] = await Promise.all([
          client.request('sessions.search', { query: wanted, projectRoot: info.boundary }).catch((error: unknown) => requestFailure(error, 'session_search_failed')),
          client.request('sessions.search', { query: wanted, sessionId }).catch((error: unknown) => requestFailure(error, 'session_search_failed')),
        ]);
        for (const answer of [listed, deep]) {
          if ('code' in answer) push({ kind: 'error', text: t(`搜索失败：${answer.code}`, `Search failed: ${answer.code}`) });
        }
        if ('code' in listed && 'code' in deep) return;
        const here = 'code' in deep ? [] : deep.hits;
        const others = 'code' in listed ? [] : listed.hits.filter((hit) => hit.sessionId !== sessionId);
        push({ kind: 'meta', text: here.length + others.length === 0
          ? t(`没有找到“${wanted}”`, `No results for “${wanted}”`)
          : [
            ...(here.length === 0 ? [] : [t('当前会话：', 'Current session:'), ...findLines(here, '', locale)]),
            ...(others.length === 0 ? [] : [t('其他会话：', 'Other sessions:'), ...findLines(others, sessionId, locale)]),
          ].join('\n') });
      })();
      return;
    }
    if (name === 'resume') {
      if (argument === '') {
        runCommand('sessions');
        return;
      }
      // 第二个词是那一份模式清单的名字：摘要变了时 D78 要一次显式的选择，界面上没有 `--mode` 这一格，
      // 这个位置就是它的等价物——否则那一次拒绝在终端里没有任何走下去的路。
      const [wanted, chosenMode] = argument.split(/\s+/);
      void (async () => {
        const listed = await client.request('sessions.list', { projectRoot: info.boundary }).catch((error: unknown) => requestFailure(error, 'session_list_failed'));
        if ('code' in listed) {
          push({ kind: 'error', text: t(`无法读取会话列表：${listed.code}`, `Could not list sessions: ${listed.code}`) });
          return;
        }
        const picked = resolveSessionId(wanted, listed.sessions);
        if (!('id' in picked)) {
          push({ kind: 'error', text: picked.code === 'tui_session_ambiguous'
            ? t(`多个会话以 ${wanted} 开头，请输入更长的编号（/sessions 查看）`, `Multiple sessions start with ${wanted}; enter a longer ID (/sessions to browse)`)
            : t(`此工作区没有会话 ${wanted}（/sessions 查看）`, `Session ${wanted} was not found in this workspace (/sessions to browse)`) });
          return;
        }
        if (picked.id === sessionId && chosenMode === undefined) {
          setSessionPicker(null);
          push({ kind: 'meta', text: t('已打开此会话', 'This session is already open') });
          return;
        }
        // 打开那一份记录时宿主会先补没人回答的派发，再按记录里最后生效的模式清单装配（D72、D78）。
        const opened = await client.request('session.open', { sessionId: picked.id, ...(chosenMode === undefined ? {} : { mode: chosenMode }) })
          .catch((error: unknown) => requestFailure(error, 'session_open_failed'));
        if ('code' in opened) {
          push({ kind: 'error', text: t(`无法恢复会话：${opened.code}`, `Could not resume session: ${opened.code}`)
            + (opened.code === 'resume_mode_changed' ? t(`；请指定工具模式：/resume ${wanted} <模式名>`, `; specify a tool mode: /resume ${wanted} <mode>`) : '')
            + (opened.code === 'session_is_branch' ? t('；请用 /sub <序号> 查看子任务', '; use /sub <seq> to view the subtask') : '') });
          return;
        }
        const read = await client.request('session.read', { sessionId: picked.id }).catch((error: unknown) => requestFailure(error, 'session_read_failed'));
        if ('code' in read) {
          push({ kind: 'error', text: t(`会话已打开，但无法读取记录：${read.code}`, `Session opened, but conversation could not be read: ${read.code}`) });
          return;
        }
        // 换走的那一份在宿主里还占着一次装配与那一份记录锁：终端一次只看一份会话，看走的那一份收掉（D85）。
        // 请求先发、答复后等：换会话 id 与换那一栏记录要在同一帧里落笔，`Static` 的 items 按索引决定补画哪几行，
        // 中间插一次 await 就把它拆成两帧，少画的那一段正是接过来的那一份记录。收不掉也不是接不上的理由，只在 meta 那一行说一句。
        const retiring = client.request('session.close', { sessionId }).catch((error: unknown) => requestFailure(error, 'session_close_failed'));
        setSessionId(picked.id);
        setSessionPicker(null);
        // 投影从那份记录重建，而不是接着画：换过来的这一份里发生过什么，只有记录说得出（I5）。
        setRows(read.events.flatMap((event) => projectRecord(event, locale).map((row) => ({ ...row, seq: event.seq }))));
        setLive({ text: '', reasoning: '' });
        setDetail(null);
        const retired = await retiring;
        const row = listed.sessions.find((item) => item.id === picked.id);
        push({
          kind: 'meta',
          text: t(`已恢复会话 ${picked.id.slice(0, 8)}`, `Resumed session ${picked.id.slice(0, 8)}`)
            + ('code' in retired ? t(`；无法关闭上一会话：${retired.code}`, `; previous session could not close: ${retired.code}`) : '')
            + (row === undefined || row.unanswered === 0 ? '' : t(`；已修复 ${row.unanswered} 条未完成调用`, `; repaired ${row.unanswered} unresolved calls`)),
        });
      })();
      return;
    }
    if (name === 'branch') {
      // 两个入口在这一条命令上合成一个：不带序号是整份复制，带一个序号是带到那一轮完整结束那一条（方案 4.3）。
      // 序号读不出整数就当场说清：一个猜出来的分支点比没有分支点更坏（4.3「不猜测历史分支点」）。
      const wanted = argument.trim();
      const at = wanted === '' ? undefined : Number(wanted);
      if (at !== undefined && !Number.isInteger(at)) {
        push({ kind: 'error', text: t('分支点须为完整轮次的记录序号：/branch [序号]', 'Branch point must be a completed turn’s sequence: /branch [seq]') });
        return;
      }
      void (async () => {
        const branched = await client.request('session.branch', { sessionId, ...(at === undefined ? {} : { at }) }).catch((error: unknown) => requestFailure(error, 'session_branch_failed'));
        if ('code' in branched) {
          push({ kind: 'error', text: t(`无法创建分支：${branched.code}`, `Could not create branch: ${branched.code}`) });
          return;
        }
        push({ kind: 'meta', text: t(`已创建分支会话 ${branched.sessionId.slice(0, 8)}（截至记录 ${branched.at}）`, `Created branch ${branched.sessionId.slice(0, 8)} through event ${branched.at}`) });
        // 接上去走的是 `/resume` 那一条路：打开、读回、投影、收掉上一份，一次只看一份会话（D85）。
        // 那一份没配上的派发由这一次打开补成未知结果，补它用的是分支自己的装配（D72、方案 4.3）。
        runCommand('resume', branched.sessionId);
      })();
      return;
    }
    if (name === 'bind') {
      // 改的是那一个动作的键，动作名不动：画面上说的那串字与按键落的事都从同一份表读，改完两处一起变（方案 6.1）。
      const parts = argument.trim().split(/\s+/).filter((part) => part !== '');
      const save = (next: Record<string, string>) => {
        if (keys === undefined) {
          push({ kind: 'meta', text: t('快捷键仅在本次运行生效：未配置存储', 'Shortcuts apply to this run only: storage is unavailable') });
          return;
        }
        void keys.write(next).catch(() => push({ kind: 'error', text: t('无法保存快捷键', 'Could not save shortcuts') }));
      };
      if (parts.length === 0) {
        push({ kind: 'meta', text: [
          t(`快捷键（${Object.keys(keyOverrides).length} 项自定义）。修改：/bind <动作> <按键>；恢复：/bind reset <动作> 或 /bind default。`, `Shortcuts (${Object.keys(keyOverrides).length} customized). Set: /bind <action> <key>; reset: /bind reset <action> or /bind default.`),
          ...Object.entries(KEYMAP).flatMap(([name, binding]) => {
            if (!isTerminalAction(name)) return [];
            return [`${name} = ${formatKeys(CURRENT[name])} (${locale === 'en' ? ENGLISH_VIEWS[binding.view] : binding.view})`];
          }),
        ].join('\n') });
        return;
      }
      if (parts[0] === 'default') {
        for (const [action, spec] of Object.entries(defaultSpecs())) {
          if (isTerminalAction(action)) CURRENT[action] = spec;
        }
        setKeyOverrides({});
        save({});
        push({ kind: 'meta', text: t('已恢复默认快捷键', 'Default shortcuts restored') });
        return;
      }
      if (parts[0] === 'reset') {
        const action = parts[1];
        if (action === undefined || !isTerminalAction(action) || KEYMAP[action] === undefined) {
          push({ kind: 'error', text: t(`未知动作：${action ?? ''}。用 /bind 查看`, `Unknown action: ${action ?? ''}. Use /bind to browse`) });
          return;
        }
        CURRENT[action] = KEYMAP[action].spec;
        const next = { ...keyOverrides };
        delete next[action];
        setKeyOverrides(next);
        save(next);
        push({ kind: 'meta', text: t(`${action} 已恢复为 ${formatKeys(KEYMAP[action].spec)}`, `${action} reset to ${formatKeys(KEYMAP[action].spec)}`) });
        return;
      }
      const [action, text] = parts;
      if (action === undefined || !isTerminalAction(action)) {
        push({ kind: 'error', text: t(`未知动作：${action}。用 /bind 查看`, `Unknown action: ${action}. Use /bind to browse`) });
        return;
      }
      const binding = KEYMAP[action];
      const spec = parseSpec(text ?? '');
      if (spec === null) {
        push({ kind: 'error', text: t(`无效按键：${text ?? ''}。例如 Ctrl+Shift+K、enter、pageup`, `Invalid key: ${text ?? ''}. Examples: Ctrl+Shift+K, enter, pageup`) });
        return;
      }
      // 先按这一条试一遍：同一个范围里两记键要落同一件事就拒，存下去的表必须是自己按得动的。
      const clash = conflictsIn(binding.view, { ...CURRENT, [action]: spec });
      if (clash.length > 0) {
        push({ kind: 'error', text: t(`${formatKeys(spec)} 在${binding.view}中冲突：${clash[0].join(' / ')}`, `${formatKeys(spec)} conflicts in ${ENGLISH_VIEWS[binding.view]}: ${clash[0].join(' / ')}`) });
        return;
      }
      CURRENT[action] = spec;
      const next = { ...keyOverrides, [action]: spec };
      setKeyOverrides(next);
      save(next);
      push({ kind: 'meta', text: `${action} = ${formatKeys(spec)} · ${locale === 'en' ? ENGLISH_LABELS[action] : binding.label}` });
      return;
    }
    if (name === 'queue') {
      // 队列是界面一侧那几行字：这一处只答「怎么走下去」与「收回到哪儿」，不动记录（D81 边界二、方案 5.2）。
      const [action, ordinal] = argument.split(/\s+/);
      if (action === undefined || action === '' || action === 'list') {
        push({ kind: 'meta', text: queue.length === 0 ? t('队列为空', 'Queue is empty')
          : [
            t(`${queue.length} 条待发送（${queuePaused ? '已暂停；/queue continue 继续' : '本轮结束后依次发送'}）：`, `${queue.length} queued (${queuePaused ? 'paused; /queue continue to resume' : 'sends after this turn'}):`),
            ...queue.map((item, index) => `${index + 1} · ${queuedLine(item)}`),
          ].join('\n') });
        return;
      }
      if (action === 'pause' || action === 'continue') {
        setQueuePaused(action === 'pause');
        push({ kind: 'meta', text: action === 'pause'
          ? t(`队列已暂停：${queue.length} 条待发送`, `Queue paused: ${queue.length} pending`)
          : queue.length === 0 ? t('队列为空', 'Queue is empty')
            : t(`队列已继续：${queue.length} 条待发送`, `Queue resumed: ${queue.length} pending`) });
        return;
      }
      // 丢出去的那一条不扔：它回到草稿，那才是人写东西的那一格（5.2「取消项仍能恢复文本」）。
      // 走到这一条时那行命令自己已经从草稿清掉了，所以草稿是空的那一格，不会把两句拼在一起。
      if (action === 'drop') {
        const wanted = ordinal === undefined ? queue.length : Number(ordinal);
        const at = wanted - 1;
        if (!Number.isInteger(wanted) || at < 0 || at >= queue.length) {
          push({ kind: 'error', text: t(`队列编号无效，当前有 ${queue.length} 条消息`, `Invalid queue index; ${queue.length} messages queued`) });
          return;
        }
        const recovered = queue[at];
        setQueue((current) => current.filter((_, index) => index !== at));
        setDraft(recovered);
        setCaret(recovered.length);
        push({ kind: 'meta', text: t(`消息 ${at + 1} 已移回草稿`, `Message ${at + 1} moved back to draft`) });
        return;
      }
      if (action === 'clear') {
        if (queue.length === 0) {
          push({ kind: 'meta', text: t('队列为空', 'Queue is empty') });
          return;
        }
        const recovered = queue.join('\n\n');
        setQueue([]);
        setQueuePaused(false);
        setDraft(recovered);
        setCaret(recovered.length);
        push({ kind: 'meta', text: t(`已将 ${queue.length} 条消息移回草稿`, `Moved ${queue.length} messages back to draft`) });
        return;
      }
      push({ kind: 'error', text: t('用法：/queue list|pause|continue|drop <序号>|clear', 'Usage: /queue list|pause|continue|drop <n>|clear') });
      return;
    }
    if (name === 'tools') {
      void (async () => {
        const current = await client.request('status.get', { sessionId }).catch(() => null);
        setStatus(current);
        push({ kind: 'meta', text: current === null ? t('无法读取状态', 'Could not read status') : t(`工具：${current.tools.join('、')}`, `Tools: ${current.tools.join(', ')}`) });
      })();
      return;
    }
    if (name === 'status') {
      void (async () => {
        const current = await client.request('status.get', { sessionId }).catch(() => null);
        setStatus(current);
        const context = contextSegment(current?.usage, locale);
        push({ kind: 'meta', text: current === null ? t('无法读取状态', 'Could not read status')
          : t(`工具模式 ${current.mode ?? '-'} · 审批 ${current.policy} · 连续拒绝 ${current.denials.consecutive} / 累计 ${current.denials.total} · ${current.eventCount} 条记录`, `Mode ${current.mode ?? '-'} · approvals ${current.policy} · denials ${current.denials.consecutive} consecutive / ${current.denials.total} total · ${current.eventCount} events`)
            + (context === '' ? '' : ` · ${context}`) });
      })();
      return;
    }
    if (name === 'name' || name === 'archive' || name === 'unarchive') {
      // 名字与归档标记由宿主写成记录里的一条事实：界面不留第二份，两端读的是同一份（方案 4.2、实现顺序第 75 步）。
      const label = name === 'name' ? { name: argument.trim() } : { archived: name === 'archive' };
      if (name === 'name' && label.name === '') {
        push({ kind: 'error', text: t('请输入会话名称：/name <名称>', 'Enter a session name: /name <name>') });
        return;
      }
      void (async () => {
        const done = await client.request('session.label', { sessionId, ...label }).catch((error: unknown) => requestFailure(error, 'session_label_failed'));
        if ('code' in done) {
          push({ kind: 'error', text: t(`无法更新会话：${done.code}`, `Could not update session: ${done.code}`) });
          return;
        }
        push({ kind: 'meta', text: t(`${done.name || '未命名会话'} · ${done.archived ? '已归档' : '未归档'}`, `${done.name || 'Untitled session'} · ${done.archived ? 'archived' : 'not archived'}`) });
      })();
      return;
    }
    if (name === 'compact') {
      void (async () => {
        setRunning(true);
        try {
        // 压这一件事归宿主：要调模型、要写检查点（D83）。界面只把结果说清楚，包括三种不肯压的情况。
        const done = await client.request('session.compact', { sessionId }).catch((error: unknown) => requestFailure(error, 'session_compact_failed'));
        if ('code' in done) {
          push({ kind: 'error', text: t(`无法压缩上下文：${done.code}`, `Could not compact context: ${done.code}`) });
          return;
        }
        setStatus(await client.request('status.get', { sessionId }).catch(() => null));
        push({
          kind: 'meta',
          text: t(`已压缩记录 ${done.fromSeq}–${done.toSeq}：估算 token ${done.tokensBefore} → ${done.tokensAfter}，原文已保留`, `Compacted events ${done.fromSeq}–${done.toSeq}: estimated tokens ${done.tokensBefore} → ${done.tokensAfter}; original content preserved`),
        });
        } finally {
          setRunning(false);
        }
      })();
      return;
    }
    if (name === 'credentials') {
      void (async () => {
        try {
          const [current, config] = await Promise.all([
            client.request('status.get', { sessionId }),
            client.request('config.get', { projectRoot: info.boundary }),
          ]);
          const service = config.services.find(item => item.id === current.serviceId);
          const reference = service?.apiKeyEnv ?? config.model?.apiKeyEnv ?? 'LIGULE_API_KEY';
          const credential = await client.request('credentials.status', { reference });
          const source = credential.source === 'environment' ? t('环境变量', 'environment') : credential.source === 'keyring' ? t('系统凭据', 'OS credential store') : t('未设置', 'not set');
          push({ kind: credential.configured ? 'meta' : 'error', text: [
            `${t('模型', 'Model')}: ${current.selectedModel ?? current.model ?? t('未选择', 'not selected')}`,
            `${t('凭据引用', 'Credential reference')}: ${reference} · ${source}`,
            ...(credential.configured ? [] : [runtimeFailureText('provider_credential_missing', locale) ?? 'provider_credential_missing']),
          ].join('\n') });
        } catch (error) {
          const code = errorCode(error) ?? 'credential_status_failed';
          push({ kind: 'error', text: `${code}\n${runtimeFailureText(code, locale) ?? t('无法检查凭据状态', 'Could not check credential status')}` });
        }
      })();
      return;
    }
    if (name === 'model') {
      if (argument.trim() === '') { openPicker('model'); return; }
      void (async () => {
        try {
          const [provider, model, ...extra] = argument.trim().split(/\s+/);
          if (model === undefined || extra.length > 0) {
            push({ kind: 'error', text: t('用法：/model <服务> <模型>', 'Usage: /model <service> <model>') });
            return;
          }
          const changed = await client.request('model.select', { sessionId, provider, model });
          await refreshStatus();
          push({ kind: 'meta', text: changed.when === 'round'
            ? t(`下轮使用 ${changed.model}`, `${changed.model} will apply next turn`)
            : t(`已切换至 ${changed.model}`, `Switched to ${changed.model}`) });
        } catch (error) {
          push({ kind: 'error', text: t(`无法选择模型：${errorCode(error) ?? errorMessage(error) ?? 'unknown'}`, `Could not select model: ${errorCode(error) ?? errorMessage(error) ?? 'unknown'}`) });
        }
      })();
      return;
    }
    if (name === 'mode') {
      if (argument === '') { openPicker('mode'); return; }
      void (async () => {
        const switched = await client.request('mode.set', { sessionId, name: argument }).catch((error: unknown) => requestFailure(error, 'mode_switch_failed'));
        if ('code' in switched) {
          push({ kind: 'error', text: t(`无法切换工具模式：${switched.code}`, `Could not change tool mode: ${switched.code}`) });
          return;
        }
        setStatus(await client.request('status.get', { sessionId }).catch(() => null));
        push({ kind: 'meta', text: switched.pending === null
          ? t(`工具模式：${switched.mode}（${switched.tools.length} 个工具）`, `Tool mode: ${switched.mode} (${switched.tools.length} tools)`)
          : t(`${switched.pending} 将于下轮生效`, `${switched.pending} will apply next turn`) });
      })();
      return;
    }
    if (name === 'policy') {
      if (argument === '') { openPicker('policy'); return; }
      void (async () => {
        const asked = argument === 'reset' ? 'default' : argument;
        if (asked !== 'default' && asked !== 'ask' && asked !== 'auto') {
          push({ kind: 'error', text: t('用法：/policy ask|auto|reset', 'Usage: /policy ask|auto|reset') });
          return;
        }
        const changed = await client.request('policy.set', { sessionId, mode: asked }).catch((error: unknown) => requestFailure(error, 'policy_change_failed'));
        if ('code' in changed) {
          push({ kind: 'error', text: t(`无法修改审批方式：${changed.code}`, `Could not change approval mode: ${changed.code}`) });
          return;
        }
        setStatus(await client.request('status.get', { sessionId }).catch(() => null));
        push({ kind: 'meta', text: changed.policySource === 'session'
          ? t(`当前会话审批方式：${changed.policy}（已生效）`, `Session approval mode: ${changed.policy} (active now)`)
          : t(`已恢复默认审批方式：${changed.policy}`, `Default approval mode restored: ${changed.policy}`) });
      })();
      return;
    }
    if (name === 'show') {
      void (async () => {
        if (argument === '') {
          setDetail(null);
          return;
        }
        const read = await client.request('session.read', { sessionId, fullResults: true }).catch((error: unknown) => requestFailure(error, 'session_read_failed'));
        if ('code' in read) {
          push({ kind: 'error', text: t(`无法读取记录：${read.code}`, `Could not read conversation: ${read.code}`) });
          return;
        }
        const picked = findRecord(read.events, argument);
        if ('code' in picked) {
          push({ kind: 'error', text: t('请输入记录序号：/show <序号>', 'Enter an event sequence: /show <seq>') });
          return;
        }
        if (picked.record === null) {
          push({ kind: 'error', text: t(`没有序号为 ${argument} 的记录`, `Event ${argument} was not found`) });
          return;
        }
        setDetail({ seq: picked.record.seq, kind: picked.record.kind ?? 'unknown', rows: projectRecord(picked.record, locale) });
      })();
      return;
    }
    if (name === 'sub') {
      void (async () => {
        if (argument === '') {
          setDetail(null);
          return;
        }
        const parent = await client.request('session.read', { sessionId, fullResults: true }).catch((error: unknown) => requestFailure(error, 'session_read_failed'));
        if ('code' in parent) {
          push({ kind: 'error', text: t(`无法读取记录：${parent.code}`, `Could not read conversation: ${parent.code}`) });
          return;
        }
        const picked = findRecord(parent.events, argument);
        if ('code' in picked) {
          push({ kind: 'error', text: t('请输入子任务结果的记录序号：/sub <序号>', 'Enter a subtask result’s sequence: /sub <seq>') });
          return;
        }
        if (picked.record === null) {
          push({ kind: 'error', text: t(`没有序号为 ${argument} 的记录`, `Event ${argument} was not found`) });
          return;
        }
        const branch = branchOf(picked.record);
        if (!('sessionId' in branch) && branch.code === 'tui_sub_needs_a_branch') {
          push({ kind: 'error', text: t(`记录 ${argument} 不是子任务结果`, `Event ${argument} is not a subtask result`) });
          return;
        }
        if (!('sessionId' in branch) && branch.code === 'tui_sub_reference_spilled') {
          push({ kind: 'error', text: t(`子任务编号未保留；请查看完整结果 ${branch.spilled ?? ''}`, `Subtask ID is unavailable; see the full result ${branch.spilled ?? ''}`) });
          return;
        }
        // 支线那份走的是同一次读记录的动作：它不在这轮的内核里，但它是同一目录下的另一份会话记录（D74）。
        const read = await client.request('session.read', { sessionId: branch.sessionId, fullResults: true }).catch((error: unknown) => requestFailure(error, 'session_read_failed'));
        if ('code' in read) {
          push({ kind: 'error', text: t(`无法读取子任务：${read.code}`, `Could not read subtask: ${read.code}`) });
          return;
        }
        setDetail({
          seq: picked.record.seq,
          kind: 'subagent',
          branch: branch.sessionId,
          rows: read.events.flatMap((event) => projectRecord(event, locale)),
        });
      })();
      return;
    }
    if (name === 'help') {
      setDetail(null);
      setSessionPicker(null);
      setSearch(null);
      setMention(null);
      setPanel('help');
      return;
    }
    push({ kind: 'error', text: t(`未知命令：/${name}（/help 查看）`, `Unknown command: /${name} (/help to browse)`) });
  }, [app, client, info, keyOverrides, keys, locale, push, queue, queuePaused, refreshStatus, sessionId, status, stdout, t, trust, openPicker, exitTui]);

  const chooseOption = useCallback((id: string) => {
    const choice = choices.find(item => item.id === id);
    if (choice === undefined || panel === null || panel === 'help') return;
    closePanel();
    if (choice.selection === undefined) {
      runCommand(panel, choice.id);
      return;
    }
    const own = sessionId;
    void client.request('model.select', { sessionId, ...choice.selection }).then(async changed => {
      if (activeSession.current !== own) return;
      await refreshStatus();
      push({ kind: 'meta', text: changed.when === 'round' ? t(`下轮使用 ${changed.model}`, `${changed.model} will apply next turn`) : t(`已切换至 ${changed.model}`, `Switched to ${changed.model}`) });
    }, (error: unknown) => push({ kind: 'error', text: t(`无法选择模型：${errorCode(error) ?? 'model_select_failed'}`, `Could not select model: ${errorCode(error) ?? 'model_select_failed'}`) }));
  }, [choices, panel, closePanel, runCommand, client, sessionId, refreshStatus, push, t]);

  // 答一道题：回车把这一题的答话记下并走到下一题，最后一题答完才把整份答复交回去（D107）。
  // 空着回车也往前走：那一题在宿主那里记成「没有回答」，模型读到的就是没答，不是界面替它编的一个答案。
  const answerQuery = useCallback((text: string) => {
    const head = query;
    if (head === null) return;
    const question = head.questions[head.at];
    if (question === undefined) return;
    const picked: Record<string, { readonly raw: string; readonly answer: AskAnswer | null }> = {
      ...head.picked,
      [question.id]: { raw: text, answer: answerOf(question, text) },
    };
    resetDraft('');
    if (head.at + 1 < head.questions.length) {
      setQuery({ ...head, at: head.at + 1, picked });
      return;
    }
    const answers = head.questions.map((one) => picked[one.id]?.answer).filter((one) => one !== undefined && one !== null);
    setQuery(null);
    push({ kind: 'meta', text: t(`已提交 ${answers.length}/${head.questions.length} 个回答`, `Submitted ${answers.length}/${head.questions.length} answers`) });
    client.reply(head.id, { answers });
  }, [client, push, query, resetDraft, t]);

  const send = useCallback((text: string) => {
    // 答题这一格开着时回车交的是这一题的答话，不是新的一轮；斜杠开头的仍按命令走，人还能用 /status 与 /queue（D107）。
    if (query !== null && !text.trim().startsWith('/')) {
      answerQuery(text);
      return;
    }
    const route = routeInput(text, running);
    if (route.kind === 'blocked') {
      push({ kind: 'meta', text: t(`请先按 ${keyHint('interrupt')} 停止当前轮次，再执行此命令`, `Stop this turn with ${keyHint('interrupt')} before using this command`) });
      return;
    }
    resetDraft('');
    setHistoryAt(-1);
    setPick(0);
    setDismissedAt(null);
    // 跑着的那一轮里，要交给模型的那一句进队列：这一轮结束后按先后发出，回车不会把那一句丢掉。
    if (route.kind === 'run' && running) {
      setQueue((current) => [...current, route.text]);
      return;
    }
    if (route.kind === 'command') {
      remember(text);
      const command = findUiCommand(route.name);
      if (command === undefined) {
        push({ kind: 'error', text: t(`未知命令：/${route.name}`, `Unknown command: /${route.name}`) });
        return;
      }
      push({ kind: 'meta', text: localizedCommand(command, locale).usage });
      runCommand(route.name, route.argument);
      return;
    }
    void submit(route.text);
  }, [answerQuery, locale, push, query, remember, runCommand, running, submit, t]);

  // 本轮结束后把队列里的第一条发出去：一次只发一条，剩下的接着排；被打断也算这一轮结束（D20）。
  // 人按下取消之后队列是停着的：那时不自动发，剩下的每一句都要等一次显式的继续（方案 5.2）。
  useEffect(() => {
    if (running || queuePaused || queue.length === 0) return;
    const [next, ...rest] = queue;
    setQueue(rest);
    void submit(next);
  }, [queue, queuePaused, running, submit]);

  // 打断这一轮这一处动作有两个入口（审批框上的 Esc 与平时的 Esc），停下队列这件事只在一份说明里做。
  const cancelRound = useCallback(() => {
    if (queue.length > 0) {
      setQueuePaused(true);
      push({ kind: 'meta', text: t(`队列已暂停：${queue.length} 条待发送，/queue continue 继续`, `Queue paused: ${queue.length} pending; /queue continue to resume`) });
    }
    void client.request('run.cancel', { sessionId }).catch((error) => push({ kind: 'error', text: error.code ?? 'run_cancel_failed' }));
  }, [client, push, queue.length, sessionId, t]);

  // 候选每次从当前草稿算出来：草稿改一个字清单就跟着变，不需要再维护一份状态（D81）。
  const templates = status?.templates ?? [];
  const picks = panel !== null || dismissedAt === draft || search !== null || detail !== null || sessionPicker !== null || ask !== null || query !== null ? [] : candidatesOf(draft, templates, undefined, locale);
  const chosen = picks.length === 0 ? 0 : Math.min(pick, picks.length - 1);
  const searched = search === null ? [] : searchHistory(entries, search.query);
  const viewLines = useMemo(() => detail === null ? [] : transcriptLines(detail.rows, Math.max(1, geometry.columns - 6), locale), [detail?.rows, geometry.columns, locale]);
  const viewHeight = Math.max(1, geometry.rows - 12 - (ask === null ? 0 : 7));
  const view = viewportPosition(detail?.cursor ?? 0, viewLines.length, viewHeight, detail?.offset ?? 0);
  const selection = detail?.anchor === undefined || detail.anchor === null ? [view.cursor, view.cursor] : [Math.min(detail.anchor, view.cursor), Math.max(detail.anchor, view.cursor)];
  const approvalLines = useMemo(() => ask === null ? [] : wrapLine(ask.content, Math.max(1, geometry.columns - 6)), [ask?.content, geometry.columns]);
  const approvalHeight = Math.max(1, geometry.rows - 12);
  const approvalView = viewportPosition(approvalCursor, approvalLines.length, approvalHeight);
  // 答题那一格要画的几样：题面、已经走过的几道各自记成了什么、这是不是最后一道（D107）。
  const asking = query === null ? null : {
    count: query.questions.length,
    current: query.questions[query.at],
    title: query.questions[query.at].header === undefined ? query.questions[query.at].question
      : `${query.questions[query.at].header} · ${query.questions[query.at].question}`,
    done: query.questions.slice(0, query.at).map((one, index) => `${index + 1}. ${answeredLine(query.picked[one.id]?.answer, locale)}`),
    last: query.at + 1 === query.questions.length,
  };
  const caretText = useMemo(() => [...GRAPHEMES.segment(draft.slice(caret))][0]?.segment ?? ' ', [draft, caret]);

  useInput((input, key) => {
    if (hit('quit', input, key)) {
      exitTui();
      return;
    }
    if (panel !== null) return;
    if (ask === null && query === null) {
      if (hit('model-picker', input, key)) { openPicker('model'); return; }
      if (hit('mode-picker', input, key)) { openPicker('mode'); return; }
      if (hit('policy-picker', input, key)) { openPicker('policy'); return; }
    }
    if (hit('expand-or-history', input, key)) {
      if (ask !== null) setApprovalExpanded((current) => !current);
      else {
        setSessionPicker(null);
        setSearch(null);
        setDetail(detail === null ? { seq: null, kind: 'transcript', rows: [], cursor: Number.MAX_SAFE_INTEGER, anchor: null, loading: true } : null);
        setExpanded(detail === null);
        if (detail === null) {
          void client.request('session.read', { sessionId, fullResults: true }).then((read) => {
            if (activeSession.current !== sessionId) return;
            const complete = read.events.flatMap((event) => projectRecord(event, locale).map((row) => ({ ...row, seq: event.seq })));
            setDetail((current) => current?.kind === 'transcript' ? { ...current, rows: complete, loading: false } : current);
          }, (error) => push({ kind: 'error', text: t(`无法读取完整记录：${error.code ?? error.message}`, `Could not read full conversation: ${error.code ?? error.message}`) }));
        }
      }
      return;
    }
    if (ask !== null && hit('approval-cancel', input, key)) {
      cancelRound();
      return;
    }
    if (ask !== null && approvalExpanded) {
      const target = hit('approval-top', input, key) ? 0 : hit('approval-bottom', input, key) ? approvalLines.length - 1
        : hit('approval-page-up', input, key) ? approvalView.cursor - approvalHeight : hit('approval-page-down', input, key) ? approvalView.cursor + approvalHeight
          : hit('approval-up', input, key) ? approvalView.cursor - 1 : hit('approval-down', input, key) ? approvalView.cursor + 1 : null;
      if (target !== null) { setApprovalCursor(target); return; }
    }
    if (ask !== null) {
      if (hit('approve', input, key)) {
        const asked = ask;
        setAsk(null);
        push({ kind: 'meta', text: t(`已允许 ${asked.tool}`, `Allowed ${asked.tool}`) });
        client.reply(asked.id, { decision: 'allow' });
      } else if (hit('deny', input, key)) {
        const asked = ask;
        setAsk(null);
        push({ kind: 'meta', text: t(`已拒绝 ${asked.tool}`, `Denied ${asked.tool}`) });
        client.reply(asked.id, { decision: 'deny' });
      }
      return;
    }
    // 答题那一格：← 在草稿空着时退回上一题，把那一题刚才写的原文放回草稿里改；改完再回车，交出去的是改过的那一份。
    // 草稿非空时这一记仍归光标移动——答题要写得了一句话，退回上一题是偶尔做的事（D107）。
    if (query !== null && draft === '' && hit('question-back', input, key)) {
      const back = Math.max(0, query.at - 1);
      resetDraft(query.picked[query.questions[back].id]?.raw ?? '');
      setQuery({ ...query, at: back });
      return;
    }
    if (detail !== null && ask === null) {
      if (hit('view-close', input, key)) { setDetail(null); setExpanded(false); return; }
      if (hit('copy-selection', input, key)) {
        void copyToClipboard(selectedText(viewLines, view.cursor, detail.anchor ?? null)).then((done) => {
          if ('code' in done) push({ kind: 'error', text: t(`复制失败：${done.code}`, `Copy failed: ${done.code}`) });
        });
        return;
      }
      // 带着 Shift 的那两记先落进「扩选」那两条，移动本身跟着走：选中的起点就是那一次按下落下的位置。
      const marked = hit('mark-up', input, key) || hit('mark-down', input, key);
      const up = hit('view-up', input, key) || hit('mark-up', input, key);
      const down = hit('view-down', input, key) || hit('mark-down', input, key);
      const target = hit('view-top', input, key) ? 0 : hit('view-bottom', input, key) ? viewLines.length - 1
        : hit('view-page-up', input, key) ? view.cursor - viewHeight : hit('view-page-down', input, key) ? view.cursor + viewHeight
          : up ? view.cursor - 1 : down ? view.cursor + 1 : null;
      if (target !== null) {
        const moved = viewportPosition(target, viewLines.length, viewHeight, view.offset);
        setDetail({ ...detail, ...moved, anchor: marked ? detail.anchor ?? view.cursor : null });
        return;
      }
      return;
    }
    if (sessionPicker !== null && ask === null) {
      if (hit('list-close', input, key)) { setSessionPicker(null); return; }
      const step = hit('list-page-up', input, key) ? -viewHeight : hit('list-page-down', input, key) ? viewHeight
        : hit('list-up', input, key) ? -1 : hit('list-down', input, key) ? 1 : null;
      const at = hit('list-first', input, key) ? 0 : hit('list-last', input, key) ? sessionPicker.items.length - 1
        : step === null ? null : Math.max(0, Math.min(sessionPicker.at + step, sessionPicker.items.length - 1));
      if (at !== null) { setSessionPicker({ ...sessionPicker, at }); return; }
      if (hit('list-open', input, key) && draft === '') {
        if (running) push({ kind: 'meta', text: t('当前轮次结束后才能切换会话', 'Wait for this turn to finish before switching sessions') });
        else runCommand('resume', sessionPicker.items[sessionPicker.at].id);
        return;
      }
      if (input !== '' && !key.ctrl && !key.meta) setSessionPicker(null);
    }
    // Ctrl+G 把草稿交给外面那一份编辑器：这一段文本走一份临时文件，回来的是它写回的那一份。
    // 让出终端这件事归 Ink（raw mode 与重画都在它手里），否则编辑器与界面抢同一把输入。
    if (hit('editor', input, key)) {
      if (info.editor === undefined || info.editor === '') {
        push({ kind: 'error', text: t('请先设置 VISUAL 或 EDITOR 环境变量', 'Set the VISUAL or EDITOR environment variable first') });
        return;
      }
      const editor = info.editor;
      void (async () => {
        let outcome: EditorOutcome = { code: 'tui_editor_failed', detail: 'external editor failed' };
        await app.suspendTerminal(async () => {
          outcome = await editInExternalEditor(editor, draft);
        });
        if (!isEditorText(outcome)) {
          push({ kind: 'error', text: t(`外部编辑失败：${outcome.code}`, `External editor failed: ${outcome.code}`) });
          return;
        }
        setDraft(outcome.text);
        setCaret(outcome.text.length);
      })();
      return;
    }
    if (hit('search-open', input, key) && search === null) {
      // 起一次反查：查询串从空开始，接着打的每个字符都往它后面加。
      setSearch({ query: '', at: 0 });
      return;
    }
    if (search !== null) {
      const found = searchHistory(entries, search.query);
      const cycle = (step: number) => setSearch(found.length === 0 ? search : { ...search, at: (search.at + step + found.length) % found.length });
      if (hit('search-close', input, key)) {
        setSearch(null);
        return;
      }
      if (hit('search-pick', input, key)) {
        const picked = found[search.at];
        if (picked !== undefined) {
          setDraft(picked);
          setCaret(picked.length);
        }
        setSearch(null);
        return;
      }
      if (hit('search-up', input, key) || hit('search-cycle', input, key)) {
        cycle(1);
        return;
      }
      if (hit('search-down', input, key)) {
        cycle(-1);
        return;
      }
      if (hit('search-back', input, key) || hit('search-back-alt', input, key)) {
        // 查询串空着时再按退格就是退出反查，不是把空格当内容删。
        setSearch(search.query === '' ? null : { query: search.query.slice(0, -1), at: 0 });
        return;
      }
      if (input !== '' && !key.ctrl && !key.meta) {
        setSearch({ query: search.query + input, at: 0 });
      }
      return;
    }
    // 路径候选开着时这几记按键归清单：Enter 是选中那一条，不是发送（方案 5.3「选中候选不能触发发送」）。
    // 一条候选都没有时 Enter 照旧发这一句——那时清单上说的是「没有对得上的文件」，不该把发送挡住。
    if (mention !== null && ask === null && query === null && detail === null && sessionPicker === null && search === null) {
      if (hit('path-close', input, key)) {
        setHiddenMention(mention.text);
        setMention(null);
        return;
      }
      const picking = hit('pick-path', input, key) || hit('pick-path-alt', input, key);
      // 那一次查询还没回来时 Enter 什么都不做：既不是选一条旧的候选，也不是把这一句发出去（方案 5.3）。
      if (mention.stopped === 'pending' && picking) return;
      if (mention.paths.length > 0 && picking) {
        const picked = mention.paths[Math.min(mention.chosen, mention.paths.length - 1)];
        const merged = insertMention(draft, caret, mention.start, picked);
        setDraft(merged.draft);
        setCaret(merged.caret);
        setHiddenMention('');
        setMention(null);
        return;
      }
      if (mention.paths.length > 0 && (hit('path-up', input, key) || hit('path-down', input, key))) {
        const step = hit('path-up', input, key) ? -1 : 1;
        setMention({ ...mention, chosen: (mention.chosen + step + mention.paths.length) % mention.paths.length });
        return;
      }
    }
    if (picks.length > 0) {
      if (hit('complete', input, key)) {
        const picked = picks[chosen];
        // 带参数提示的那一条补完留一个空格，光标落在要写参数的地方；不带的补完就能直接发。
        const completed = `/${picked.name}${picked.hint === '' ? '' : ' '}`;
        setDraft(completed);
        setCaret(completed.length);
        setPick(0);
        return;
      }
      if (hit('complete-up', input, key) || hit('complete-down', input, key)) {
        setPick(hit('complete-up', input, key) ? (chosen === 0 ? picks.length - 1 : chosen - 1) : (chosen + 1) % picks.length);
        return;
      }
      if (hit('complete-close', input, key)) {
        setDismissedAt(draft);
        return;
      }
    }
    if (hit('interrupt', input, key)) {
      if (running) cancelRound();
      return;
    }
    const up = hit('history-up', input, key) || hit('history-up-shift', input, key);
    const down = hit('history-down', input, key) || hit('history-down-shift', input, key);
    if (up || down) {
      if (draft.includes('\n')) {
        const start = draft.lastIndexOf('\n', Math.max(0, caret - 1)) + 1;
        const column = caret - start;
        if (up && start > 0) {
          const previous = draft.lastIndexOf('\n', start - 2) + 1;
          setCaret(Math.min(previous + column, start - 1));
        } else if (down) {
          const next = draft.indexOf('\n', caret);
          if (next >= 0) {
            const end = draft.indexOf('\n', next + 1);
            setCaret(Math.min(next + 1 + column, end < 0 ? draft.length : end));
          }
        }
        return;
      }
      if (entries.length === 0) return;
      if (historyAt === -1 && up) setHistoryDraft(draft);
      const next = up ? Math.min(historyAt + 1, entries.length - 1) : Math.max(historyAt - 1, -1);
      setHistoryAt(next);
      const recalled = next < 0 ? historyDraft : entries[next];
      setDraft(recalled);
      setCaret(recalled.length);
      return;
    }
    if (hit('undo-draft', input, key) || hit('redo-draft', input, key)) {
      // 退回去与再退回来：两侧各留一份栈，Ctrl+Z 退过头还能用 Ctrl+Y 拿回来——多退一步不是真的把那句草稿丢掉。
      const cell = undo.current;
      const back = hit('undo-draft', input, key);
      const target = (back ? cell.stack : cell.future).at(-1);
      if (target === undefined) return;
      const current = { draft: cell.before.draft, caret: cell.before.caret };
      if (back) {
        cell.stack = cell.stack.slice(0, -1);
        cell.future = [...cell.future.slice(-99), current];
      } else {
        cell.future = cell.future.slice(0, -1);
        cell.stack = [...cell.stack.slice(-99), current];
      }
      cell.kind = null;
      cell.before = target;
      setDraft(target.draft);
      setCaret(target.caret);
      return;
    }
    if ((hit('queue-recall', input, key) || hit('queue-recall-alt', input, key)) && draft === '' && queue.length > 0) {
      // 草稿已经空着时按退格，最后排进来的那一条收回草稿里：打错的那一句要能改，不必重新打一遍。
      setQueue((current) => current.slice(0, -1));
      const last = queue[queue.length - 1];
      setDraft(last);
      setCaret(last.length);
      return;
    }
    if (hit('send', input, key) || hit('newline-alt', input, key)) {
      if (hit('newline', input, key) || hit('newline-alt', input, key)) {
        const inserted = draft.slice(0, caret) + '\n' + draft.slice(caret);
        setDraft(inserted);
        setCaret(caret + 1);
        return;
      }
      // 空着回车本来什么都不发；答题那一格开着时它说的是「这一道不答」，要往前走下一道（D107）。
      if (draft.trim() !== '' || query !== null) send(draft);
      return;
    }
    const edited = editDraft(draft, caret, input.replace(/\r\n?/g, '\n'), key);
    setDraft(edited.draft);
    setCaret(edited.caret);
  // 没有真终端时不开这一路：Ink 在拿不到 raw mode 的输入上是报错而不是降级（检查里就传 interactive: false）。
  }, { isActive: interactive });

  // 整段粘贴走 Ink 的另一条通道：这一条开着时它替终端打上 bracketed paste，粘进来的那一段是一整串文本，
  // 不会被拆成一串按键——所以粘贴里的换行不会发一轮，审批框上的 `y` 也不会被粘贴按下去（方案 5.1、5.4）。
  usePaste((text) => {
    if (panel !== null) return;
    const inserted = editDraft(draft, caret, text.replace(/\r\n?/g, '\n'), {});
    setDraft(inserted.draft);
    setCaret(inserted.caret);
  }, { isActive: interactive });

  const shownModel = status?.model ?? info.model;
  const foldedLive = foldText(live.reasoning, expanded, 1);

  return h(Fragment, null,
    // 一换会话就重画整份：`Static` 只补索引往后新增的行，接上来的那一份记录比当前这一份短时，
    // 不加这个 key 就一条都画不出来（第 44 步）。会话 id 正是这一串行的归属，拿它当 key 不用另记一个计数。
    h(Static<TranscriptItem>, { key: sessionId, items: sessionId === firstSessionId ? [{ kind: 'welcome', text: '' }, ...rows] : rows, children: (row, index) => row.kind === 'welcome'
      ? h(Box, { key: index, flexDirection: 'column', alignItems: 'center', marginY: 1 },
          h(Text, { bold: true, color: 'green' }, `❧  ligule  v${VERSION}`),
          h(Text, null, t('欢迎使用 Ligule', 'Welcome to Ligule')),
          h(Text, { wrap: 'truncate-middle' }, titleText({ boundary: info.boundary, sessionId: '' })),
          h(Text, { dimColor: true }, t('输入 /help 查看命令与快捷键', 'Type /help for commands and shortcuts')))
      : h(Box, { key: index, flexDirection: 'column' }, h(Row, { row, expanded: false, columns: geometry.columns, locale })) }),
    foldedLive.shown === '' ? null : h(Text, { dimColor: true, wrap: 'truncate-end' }, t(`· 推理 ${foldedLive.shown}${foldedLive.hidden > 0 ? ` …还有 ${foldedLive.hidden} 字` : ''}`, `· Reasoning ${foldedLive.shown}${foldedLive.hidden > 0 ? ` …${foldedLive.hidden} more characters` : ''}`)),
    live.text === '' || detail !== null ? null : h(MarkdownRows, { text: live.text, columns: geometry.columns }),
    ask === null ? null : h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'yellow', paddingX: 1 },
      h(Text, { bold: true }, t(`允许执行 ${ask.tool}？`, `Allow ${ask.tool}?`)),
      h(Text, { wrap: 'truncate-end' }, ask.detail),
      ask.change === '' ? null : h(Text, { dimColor: true }, ask.change),
      ask.backend === '' ? null : h(Text, { dimColor: true, wrap: 'truncate-end' }, t(`执行环境 ${ask.backend}`, `Shell ${ask.backend}`)),
      ask.reason === '' ? null : h(Text, { dimColor: true, wrap: 'truncate-end' }, ask.reason),
      approvalExpanded ? h(Fragment, null,
        ...approvalLines.slice(approvalView.offset, approvalView.offset + approvalHeight).map((line, index) => h(Text, { key: index, wrap: 'truncate-end' }, line)),
        h(Text, { dimColor: true }, t(`改动 ${approvalView.cursor + 1}/${approvalLines.length} 行 · ${keyHint('approval-page-up', 'approval-page-down')} 分页 · ${keyHint('approval-top', 'approval-bottom')} 到两端`, `Changes ${approvalView.cursor + 1}/${approvalLines.length} · ${keyHint('approval-page-up', 'approval-page-down')} pages · ${keyHint('approval-top', 'approval-bottom')} start/end`))) : null,
      h(Text, { wrap: 'truncate-end' }, t(`${keyHint('approve')} 允许一次 · ${keyHint('deny')} 拒绝 · ${keyHint('expand-or-history')} 查看改动 · ${keyHint('approval-cancel')} 取消`, `${keyHint('approve')} allow once · ${keyHint('deny')} deny · ${keyHint('expand-or-history')} details · ${keyHint('approval-cancel')} cancel`))),
    asking === null || query === null ? null : h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'blue', paddingX: 1 },
      h(Text, { bold: true }, t(`等待回答 ${query.at + 1}/${asking.count}`, `Waiting for your answer ${query.at + 1}/${asking.count}`)),
      h(Text, { wrap: 'truncate-end' }, asking.title),
      ...asking.current.options.map((option, position) => h(Text, { key: `option:${position}`, dimColor: true, wrap: 'truncate-end' }, `  ${position + 1}. ${option.label}${option.description === undefined ? '' : ` —— ${option.description}`}`)),
      ...asking.done.map((line, index) => h(Text, { key: `done:${index}`, dimColor: true, wrap: 'truncate-end' }, `  ${line}`)),
      h(Text, { wrap: 'truncate-end' }, `${optionHint(asking.current, locale)} · ${asking.last ? t('Enter 提交', 'Enter to submit') : t('Enter 下一题', 'Enter for next question')}`),
      h(Text, { dimColor: true, wrap: 'truncate-end' }, t(`  ${asking.done.length > 0 ? `${keyHint('question-back')} 上一题 · ` : ''}${keyHint('interrupt')} 取消本轮 · 没有回答时限`, `  ${asking.done.length > 0 ? `${keyHint('question-back')} previous · ` : ''}${keyHint('interrupt')} cancel turn · no answer timeout`))),
    detail === null ? null : h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'cyan', paddingX: 1 },
      h(Text, { dimColor: true, wrap: 'truncate-end' }, detail.kind === 'transcript' ? t('完整历史', 'Transcript') : detailTitle(detail, locale)),
      viewLines.length === 0
        ? h(Text, { dimColor: true }, detail.loading ? t('正在读取记录…', 'Loading transcript…') : t('没有可显示的内容', 'No content to display'))
        : viewLines.slice(view.offset, view.offset + viewHeight).map((line, index) => h(Text, { key: view.offset + index, inverse: view.offset + index >= selection[0] && view.offset + index <= selection[1], wrap: 'truncate-end' }, line)),
      h(Text, { dimColor: true, wrap: 'truncate-end' }, t(`${view.cursor + 1}/${viewLines.length} 行 · ${keyHint('view-page-up', 'view-page-down')} 分页 · ${keyHint('view-top', 'view-bottom')} 到两端 · ${keyHint('mark-up', 'mark-down')} 选择 · ${keyHint('copy-selection')} 复制 · ${keyHint('view-close')} 收起`, `Line ${view.cursor + 1}/${viewLines.length} · ${keyHint('view-page-up', 'view-page-down')} pages · ${keyHint('view-top', 'view-bottom')} start/end · ${keyHint('mark-up', 'mark-down')} select · ${keyHint('copy-selection')} copy · ${keyHint('view-close')} close`))),
    sessionPicker === null ? null : h(Box, { flexDirection: 'column', borderStyle: 'round', paddingX: 1 },
      h(Text, { wrap: 'truncate-end' }, t(`历史会话 ${sessionPicker.items.length} 份 · ${keyHint('list-up', 'list-down')} 选择 · ${keyHint('list-open')} 打开 · ${keyHint('list-close')} 收起`, `${sessionPicker.items.length} sessions · ${keyHint('list-up', 'list-down')} select · ${keyHint('list-open')} open · ${keyHint('list-close')} close`)),
      sessionPicker.items.slice(Math.max(0, sessionPicker.at - viewHeight + 1), Math.max(0, sessionPicker.at - viewHeight + 1) + viewHeight).map((item) => h(Text, { key: item.id, inverse: item === sessionPicker.items[sessionPicker.at], wrap: 'truncate-end' }, sessionLines([item], sessionId, locale)[0]))),
    queue.length === 0 ? null : h(Box, { flexDirection: 'column' },
      queue.map((item, index) => h(Text, { key: `${index}:${item}`, dimColor: true }, t(`排队 ${index + 1} · ${queuedLine(item)}`, `Queued ${index + 1} · ${queuedLine(item)}`))),
      h(Text, { dimColor: true }, queuePaused
        ? t('  队列已暂停 · /queue continue 继续 · /queue drop <序号> 收回', '  Queue paused · /queue continue to resume · /queue drop <n> to recover')
        : t('  本轮结束后按顺序发送；空草稿时按退格收回最后一条', '  Sends in order after this turn; Backspace on an empty draft recovers the last message'))),
    search === null ? null : h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'magenta', paddingX: 1 },
      h(Text, null, t(`历史搜索 ${search.query}`, `History search ${search.query}`)),
      searched.length === 0
        ? h(Text, { dimColor: true }, entries.length === 0 ? t('暂无输入历史', 'No input history') : t(`没有匹配“${search.query}”的输入`, `No input matches “${search.query}”`))
        : searched.map((entry, index) => h(Box, { key: `${index}:${entry}` },
            h(Text, { inverse: index === search.at }, ` ${queuedLine(entry, 60)}`))),
      h(Text, { dimColor: true }, t(`  继续输入以筛选 · ${keyHint('search-cycle', 'search-up', 'search-down')} 选择 · ${keyHint('search-pick')} 恢复草稿 · ${keyHint('search-close')} 退出`, `  Type to filter · ${keyHint('search-cycle', 'search-up', 'search-down')} select · ${keyHint('search-pick')} restore draft · ${keyHint('search-close')} close`))),
    picks.length === 0 ? null : h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'gray', paddingX: 1 },
      picks.slice(Math.max(0, chosen - CANDIDATE_ROWS + 1), Math.max(0, chosen - CANDIDATE_ROWS + 1) + CANDIDATE_ROWS).map((candidate) => h(Box, { key: `${candidate.source}:${candidate.name}` },
        h(Text, { inverse: candidate === picks[chosen] }, ` /${candidate.name}${candidate.hint === '' ? '' : ` ${candidate.hint}`}`),
        h(Text, { dimColor: true }, ` ${candidate.text}`))),
      picks.length > CANDIDATE_ROWS ? h(Text, { dimColor: true }, t(`  还有 ${picks.length - CANDIDATE_ROWS} 条，继续输入以筛选`, `  ${picks.length - CANDIDATE_ROWS} more; type to filter`)) : null,
      h(Text, { dimColor: true }, t(` ${keyHint('complete')} 补全 · ${keyHint('complete-up', 'complete-down')} 选择 · ${keyHint('complete-close')} 收起`, ` ${keyHint('complete')} complete · ${keyHint('complete-up', 'complete-down')} select · ${keyHint('complete-close')} close`))),
    mention === null ? null : h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'gray', paddingX: 1 },
      h(Text, { dimColor: true, wrap: 'truncate-end' }, t(` 工作区 ${info.boundary}`, ` Workspace ${info.boundary}`)),
      mention.paths.length === 0
        ? h(Text, { dimColor: true }, mention.stopped === 'error'
          ? t(`无法列出文件：${mention.failed}`, `Could not list files: ${mention.failed}`)
          : mention.stopped === 'pending'
            ? t('正在查找文件…', 'Finding files…')
            : mention.stopped === 'budget'
              ? t('搜索已到遍历上限，请输入更具体的路径', 'Search limit reached; enter a more specific path')
              : t(`没有匹配“${mention.text}”的文件`, `No files match “${mention.text}”`))
        : mention.paths.map((path, index) => h(Text, { key: path, inverse: index === mention.chosen, wrap: 'truncate-end' }, ` ${path}`)),
      mention.paths.length > 0 && mention.stopped === 'budget'
        ? h(Text, { dimColor: true }, t('  列表不完整，请输入更具体的路径', '  List is incomplete; enter a more specific path')) : null,
      mention.paths.length > 0 && mention.stopped === 'unreadable'
        ? h(Text, { dimColor: true }, t('  有目录无法读取，列表不完整', '  Some directories are unreadable; list is incomplete')) : null,
      mention.paths.length === 0 ? null : h(Text, { dimColor: true }, t(` ${keyHint('pick-path', 'pick-path-alt')} 选中 · ${keyHint('path-up', 'path-down')} 选择 · ${keyHint('path-close')} 收起`, ` ${keyHint('pick-path', 'pick-path-alt')} insert · ${keyHint('path-up', 'path-down')} select · ${keyHint('path-close')} close`))),
    h(HelpPanel, { active: panel === 'help', interactive, templates, locale, columns: geometry.columns - 4, height: Math.max(1, geometry.rows - 13), onClose: closePanel }),
    h(ChoicePanel, {
      active: panel !== null && panel !== 'help', interactive,
      title: panel === 'model' ? t('选择模型', 'Select model') : panel === 'mode' ? t('选择工具模式', 'Select tool mode') : t('选择审批方式', 'Select approval mode'),
      options: choices,
      selected: panel === 'model' ? `${status?.serviceId}:${status?.selectedModel ?? status?.model}` : panel === 'mode' ? status?.mode ?? undefined : status?.policy,
      locale, columns: geometry.columns - 4, height: Math.max(1, Math.min(7, geometry.rows - 16)), loading: choicesLoading, onClose: closePanel, onSelect: (choice: PanelChoice) => chooseOption(choice.id),
    }),
    h(Box, { flexDirection: 'column', borderStyle: 'single', borderTop: true, borderBottom: true, borderLeft: false, borderRight: false, borderColor: running ? 'yellow' : 'cyan', paddingX: 1 }, h(Box, null,
      h(Text, { color: running ? 'yellow' : 'cyan' }, running ? `${SPINNER[tick % SPINNER.length]} ` : '› '),
      draft === '' && !running
        ? h(Text, { dimColor: true }, t(`描述任务 · ${keyHint('send')} 发送 · ${keyHint('newline')} 换行 · / 命令 · @ 文件`, `Describe a task · ${keyHint('send')} send · ${keyHint('newline')} new line · / commands · @ files`))
        : h(Text, { wrap: 'wrap' },
          draft.slice(0, caret),
          h(Text, { inverse: true }, caretText),
          draft.slice(caret + (caret === draft.length ? 0 : caretText.length))))),
    h(Text, { wrap: 'wrap' },
      t(`模型 ${shownModel ?? '未配置'}${status?.pendingModel ? `→${status.pendingModel}` : ''} ${keyHint('model-picker')}  ·  工具模式 ${status?.mode ?? '—'}${status?.pendingMode ? `→${status.pendingMode}` : ''} ${keyHint('mode-picker')}  ·  审批 ${status?.policy === 'never' ? '完全不需审批' : status?.policy === 'auto' ? '自动判定' : '逐次审批'} ${keyHint('policy-picker')}`, `Model ${shownModel ?? 'not configured'}${status?.pendingModel ? `→${status.pendingModel}` : ''} ${keyHint('model-picker')}  ·  Tools ${status?.mode ?? '—'}${status?.pendingMode ? `→${status.pendingMode}` : ''} ${keyHint('mode-picker')}  ·  Approval ${status?.policy === 'never' ? 'none' : status?.policy === 'auto' ? 'auto' : 'ask'} ${keyHint('policy-picker')}`)),
    h(Text, { dimColor: true, wrap: 'truncate-end' }, buildStatusLine({
      sessionId, boundary: info.boundary, status, running, seconds, expanded, columns: stdout?.columns, locale,
    })),
  );
}
