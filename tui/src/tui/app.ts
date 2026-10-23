// TUI 负责显示会话记录和流式内容，并将键盘操作转换为 Host 协议调用。
// 协议帧由 `core/src/host/connection.ts` 处理；此处不直接读写帧。
// 纯函数和命令表从此模块导出，供自动检查和界面复用。
import { resolve } from 'node:path';
import { createElement as h, Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Static, Text, useApp, useInput, usePaste } from 'ink';
import { SESSION_ROWS, answerOf, candidatesOf, describeChange, findLines, findUiCommand, insertMention, localizedCommand, mentionToken, resolveSessionId, routeInput, sessionLines } from './commands.js';
import { pushHistory } from '@ligule/core/kernel/input-history.js';
import { searchHistory } from './history.js';
import { editDraft, isTypingRun, moveDraftCaret, type DraftState } from './draft.js';
import { editInExternalEditor } from './editor.js';
import { copyToClipboard, lastAnswer } from './clipboard.js';
import { titleEscape, titleText } from './output.js';
import { providerDiagnosticText, runtimeFailureText } from './errors.js';
import { capabilityOf, projectRecord, resultParts, type TranscriptItem, type TuiRecord } from './transcript.js';
import { VERSION } from '../version.js';
import { ChoicePanel, HelpPanel, PanelFrame, type PanelChoice } from './panels.js';
import { SessionPicker } from './session-picker.js';
import { MessageRow as Row, MarkdownRows } from './message-view.js';
import { foldText } from './message-format.js';
import { ConfigurationLine, ProgressLine, Welcome } from './chrome.js';
import { DraftInput } from './input-view.js';
import { ApprovalPanel, buildApprovalLayout } from './approval-view.js';
import { TUI_COLORS } from './ui-style.js';
import { selectedText, transcriptLines, viewportPosition, wrapLine } from './viewport.js';
import { CURRENT, ENGLISH_LABELS, ENGLISH_VIEWS, KEYMAP, applyOverrides, conflictsIn, defaultSpecs, formatKeys, hit, keyHint, parseSpec } from './keymap.js';
import { displayWidth } from './commands.js';
import { textOf as chooseText, type Locale } from '@ligule/core/kernel/locale.js';
import type { InkKey, TerminalAction } from './keymap.js';
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

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
// 显示模式来源的中文名称；记录值与 Host 返回的来源标识保持一致。
const MODE_LAYERS: Readonly<Record<string, string>> = { shipped: '随包', user: '全局', project: '项目' };
// 限制列表高度，避免内容挤出输入区域。
const CANDIDATE_ROWS = 6;
// 每次向 Host 请求最多八条路径候选，避免列表超出屏幕。
const MENTION_ROWS = 8;
// 表示当前没有文本组合输入；有效光标位置不会是 -1。
const NO_TOKEN = { start: -1, text: '' } as const;

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

function externalModelFrom(events: readonly SessionEvent[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind === 'turnContext' && typeof event.model === 'string' && event.model.trim() !== '') return event.model;
  }
  return null;
}

function isAskQuestion(value: unknown): value is AskQuestion {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.question === 'string'
    && typeof value.multiSelect === 'boolean'
    && Array.isArray(value.options)
    && value.options.every((option) => isRecord(option) && typeof option.label === 'string');
}

interface TuiStatus {
  readonly model?: string | null;
  readonly pendingModel?: string | null;
  readonly mode?: string | null;
  readonly pendingMode?: string | null;
  readonly policy: string;
  readonly policySource?: string;
  readonly permission?: {
    readonly profile: 'read-only' | 'workspace-write' | 'full-access';
    readonly network: 'policy' | 'unrestricted' | 'disabled';
    readonly capabilities: {
      readonly filesystemRead: 'full' | 'partial' | 'unavailable';
      readonly filesystemWrite: 'full' | 'partial' | 'unavailable';
      readonly network: 'full' | 'partial' | 'unavailable';
      readonly process: 'full' | 'partial' | 'unavailable';
    };
    readonly profiles: {
      readonly readOnly: 'full' | 'partial' | 'unavailable';
      readonly workspaceWrite: 'full' | 'partial' | 'unavailable';
    };
    readonly limitations: readonly string[];
    readonly partialWorkspaceWriteConfirmationRequired: boolean;
    readonly partialWorkspaceWriteConfirmed: boolean;
    readonly workspaceTrusted: boolean;
    readonly execution: { readonly available: boolean; readonly code: string | null; readonly reason: string | null };
    readonly changeAllowed: boolean;
    readonly changeReason?: string;
  };
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
}

interface SessionNavigationLease {
  readonly token: number;
  readonly owner: string;
}

interface SearchState {
  readonly query: string;
  readonly at: number;
}

type PickerKind = 'model' | 'mode' | 'policy' | 'permission' | 'permission-network' | 'permission-confirm-full' | 'permission-confirm-network' | 'permission-confirm-partial'
  | 'control' | 'control-action' | 'control-revoke-confirm';
type PolicyValue = 'ask' | 'auto' | 'none' | 'never';
type PolicySelection = 'ask' | 'auto' | 'none';
type AgentGrant = {
  readonly id: string;
  readonly name: string;
  readonly projectRoot: string;
  readonly source: 'trusted-ui' | 'legacy';
  readonly defaultPermissionProfile: 'read-only' | 'workspace-write' | 'full-access';
  readonly maxPermissionProfile: 'read-only' | 'workspace-write' | 'full-access';
  readonly defaultNetwork: 'disabled' | 'policy' | 'unrestricted';
  readonly maxNetwork: 'disabled' | 'policy' | 'unrestricted';
  readonly defaultPolicy: PolicyValue;
  readonly allowedPolicies: readonly PolicyValue[];
  readonly allowOperator: boolean;
  readonly allowedMcpServers: readonly string[];
  readonly allowedMcpTools: readonly string[];
  readonly confirmedPartialWorkspaceWrite: boolean;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
};
type AgentControlSnapshot = { readonly version: string; readonly grants: readonly AgentGrant[] };
type ControlWizardValues = {
  name?: string;
  defaultPermissionProfile?: AgentGrant['defaultPermissionProfile'];
  maxPermissionProfile?: AgentGrant['maxPermissionProfile'];
  defaultNetwork?: AgentGrant['defaultNetwork'];
  maxNetwork?: AgentGrant['maxNetwork'];
  defaultPolicy?: PolicySelection;
  allowedPolicies?: PolicySelection[];
  allowOperator?: boolean;
  allowedMcpServers?: string[];
  allowedMcpTools?: string[];
  expiresAt?: string | null;
  confirmFullAccess?: boolean;
  confirmUnrestrictedNetwork?: boolean;
  confirmPartialWorkspaceWrite?: boolean;
  confirmWorkspaceTrust?: boolean;
};
type McpTrustScope = 'session' | 'project' | 'user';
type McpServerSummary = {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environmentNames: readonly string[];
  readonly identityDigest: string;
  readonly trust: { readonly scope: McpTrustScope; readonly source: 'trusted-ui'; readonly trusted: boolean } | null;
  readonly trustScopes: Readonly<Record<McpTrustScope, { readonly source: 'trusted-ui'; readonly trusted: boolean } | null>>;
};
type McpTrustSnapshot = { readonly version: string; readonly servers: readonly McpServerSummary[] };
type McpToolsSnapshot = { readonly server: string; readonly identityDigest: string; readonly tools: readonly { readonly name: string; readonly description: string; readonly digest: string }[] };
type McpTrustPending = {
  readonly server: string;
  readonly scope: McpTrustScope;
  readonly version: string;
  readonly identityDigest: string;
};
type ControlWizard = {
  readonly step: number;
  readonly values: ControlWizardValues;
  readonly mcpServers: readonly string[];
  readonly mcpTools: readonly string[];
};

function agentMcpConfig(grant: AgentGrant): string {
  const args = ['mcp-server', '--project', grant.projectRoot, '--grant', grant.id];
  if (grant.allowOperator) args.push('--operator');
  return JSON.stringify({ mcpServers: { ligule: { command: 'ligule', args } } }, null, 2);
}

function controlWizardNext(step: number, values: ControlWizardValues): number {
  if (step === 10) return 11;
  if (step === 11) return values.maxPermissionProfile !== 'read-only' ? 12
    : values.maxNetwork === 'unrestricted' ? 14 : -1;
  if (step === 12) return values.maxPermissionProfile === 'full-access' ? 13
    : values.maxNetwork === 'unrestricted' ? 14 : -1;
  if (step === 13) return values.maxNetwork === 'unrestricted' ? 14 : -1;
  if (step === 14) return -1;
  return step + 1;
}
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
  readonly rememberable: boolean;
  readonly rememberScopes: readonly McpTrustScope[];
  readonly rememberHintKey: 'file' | 'tool' | 'command' | 'mcp' | '';
  readonly rememberTargetOptions: readonly ('file' | 'workspace' | 'tool' | 'command')[];
  readonly rememberTarget?: 'file' | 'workspace' | 'tool' | 'command';
  readonly detailsRef?: string;
  readonly argumentBytes?: number;
  readonly argumentSha256?: string;
  readonly identityDigest?: string;
  readonly detailsLoading?: boolean;
  readonly detailsLoaded?: boolean;
  readonly detailsError?: string;
  readonly detailsSummary?: string;
  readonly detailSuffix?: string;
  readonly external?: boolean;
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
  readonly writerActive?: boolean;
}

interface ExternalControlSnapshot extends Record<string, unknown> {
  readonly sessionId: string;
  readonly operationId?: string;
  readonly state: 'idle' | 'running' | 'done' | 'failed' | 'cancelled';
  readonly phase?: string | null;
  readonly progress?: TuiProgress | null;
  readonly pendingInteractions: readonly {
    readonly requestId: string;
    readonly sessionId: string;
    readonly type: 'approval' | 'question';
    readonly details: Record<string, unknown>;
  }[];
  readonly events: readonly Record<string, unknown>[];
  readonly nextCursor: number;
  readonly eventGap?: boolean;
  readonly firstAvailableCursor?: number;
  readonly queue?: readonly { readonly queueItemId: string; readonly inputCharacters: number; readonly source: 'human' | 'controller' }[];
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
  readonly 'session.observe': SessionPage & { readonly writerActive: boolean };
  readonly 'session.control': ExternalControlSnapshot;
  readonly 'approval.details': { readonly requestId: string; readonly sessionId: string; readonly argumentSha256: string; readonly args: Record<string, unknown> };
  readonly 'session.export': Exported;
  readonly 'session.branch': BranchResult;
  readonly 'session.label': { readonly sessionId: string; readonly name: string; readonly archived: boolean };
  readonly 'sessions.list': { readonly sessions: SessionSummary[] };
  readonly 'sessions.search': { readonly hits: SearchHit[] };
  readonly 'paths.list': PathListing;
  readonly 'run.start': LoopResult;
  readonly 'run.cancel': { readonly cancelled: boolean };
  readonly 'status.get': TuiStatus;
  readonly 'permission.set': { readonly sessionId: string; readonly permission: NonNullable<TuiStatus['permission']>; readonly applies: 'now' | 'unchanged' };
  readonly 'model.select': { readonly model: string | null; readonly serviceId: string; readonly when: 'now' | 'round' };
  readonly 'config.get': TuiConfigResult;
  readonly 'credentials.status': CredentialStatus;
  readonly 'mode.set': { readonly mode: string | null; readonly layer: string | null; readonly pending: string | null; readonly tools: string[] };
  readonly 'policy.set': { readonly policy: string; readonly policySource: string; readonly policyDefault: string };
  readonly 'agent-control.list': AgentControlSnapshot;
  readonly 'agent-control.create': AgentControlSnapshot;
  readonly 'agent-control.revoke': AgentControlSnapshot;
  readonly 'mcp.trust.list': McpTrustSnapshot;
  readonly 'mcp.trust.set': { readonly server: string; readonly scope: McpTrustScope; readonly trusted: boolean; readonly version?: string };
  readonly 'mcp.trust.tools': McpToolsSnapshot;
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
  readonly external?: boolean;
}

// 将命令表和纯函数导出，供测试及其他界面逻辑使用。
export { SESSION_ROWS, UI_COMMANDS, answerOf, candidatesOf, describeChange, displayWidth, findLines, findUiCommand, insertMention, mentionToken, resolveSessionId, routeInput, sessionLines } from './commands.js';
export { KEYMAP, CURRENT, applyOverrides, conflictsIn, defaultSpecs, formatKeys, hit, keyHint, parseSpec, specOf } from './keymap.js';
export { markdownLines } from './markdown.js';

export { editDraft, isTypingRun } from './draft.js';

export { foldText } from './message-format.js';

export { capabilityOf, projectRecord, resultParts };

// 上下文状态显示当前投影估算、模型窗口和是否超过压力线。窗口未知时隐藏整段状态。
// Token 数是本地估算值，并使用波浪号标明，避免误认为模型服务返回的精确用量。
interface ContextUsage {
  readonly estimated: number;
  readonly window: number;
  readonly threshold: number;
}

export function contextSegment(usage: ContextUsage | null | undefined, locale: Locale = 'zh'): string {
  if (usage === null || usage === undefined) return '';
  return `ctx:~${usage.estimated}/${usage.window}${usage.estimated > usage.threshold ? chooseText(locale, ' 超限', ' over limit') : ''}`;
}

// 元数据行显示会话、目录、上下文和运行状态；模型与控制入口显示在输入框下方。
// 空间不足时先截短目录，再隐藏上下文和记录数，并保留取消提示。
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
  if (status.permission !== undefined) {
    const permission = status.permission;
    parts.push(`perm: ${permission.profile} · ${permission.network} · ${permission.execution.available ? t('Shell 可用', 'Shell available') : t('Shell 受限', 'Shell restricted')}`);
  }
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
  // 空间不足时优先隐藏条数，保留中断和展开提示。
  const hints = (running ? `${progressHint === '' ? '' : ` · ${progressHint}`}${t(` · ${Math.floor(seconds)} 秒，${keyHint('interrupt')} 打断`, ` · ${Math.floor(seconds)}s, ${keyHint('interrupt')} to stop`)}` : '')
    + (expanded ? t(` · 已展开（${keyHint('expand-or-history')} 收起）`, ` · expanded (${keyHint('expand-or-history')} to close)`) : '');
  let tail = `${chooseText(locale, `记录 ${status.eventCount} 条`, `${status.eventCount} events`)}${hints}`;
  let shown = parts;
  // 无法读取终端宽度时不截断文本，由终端自行换行。
  const line = () => [base, ...shown, tail].filter(part => part !== '').join(' · ');
  const over = () => columns !== undefined && columns > 0 && displayWidth(line()) > columns;
  const leaf = root === '' ? '' : root.split(/[\\/]/).filter(Boolean).pop() ?? '';
  if (over()) base = `${id}${leaf === '' ? '' : ` · ${leaf}`}`;
  if (over()) shown = shown.filter((part) => !part.startsWith('ctx:'));
  if (over()) shown = shown.filter((part) => !part.startsWith('perm:'));
  if (over()) base = id;
  if (over()) tail = hints === '' ? '' : hints.slice(3);
  if (over() && running && progress !== undefined && progress !== null) {
    shown = [];
    tail = `${phaseHint} · ${idleSeconds}${t('秒无新进展', 's without progress')} · ${keyHint('interrupt')} ${t('打断', 'stop')}`;
    if (over()) base = '';
  }
  return line();
}

// `/show` 使用稳定的事件序号，不使用可能随投影变化的屏幕行号。
export function findRecord(events: readonly TuiRecord[], argument: string): { readonly code: string } | { readonly record: TuiRecord | null } {
  const seq = Number(argument);
  if (!Number.isInteger(seq) || seq < 0) return { code: 'tui_show_needs_a_number' };
  return { record: events.find((event) => event.seq === seq) ?? null };
}

// `/sub` 使用父记录中的事件序号定位派生结果，并从结果中读取支线会话 ID。
export function branchOf(record: TuiRecord | undefined): { readonly code: 'tui_sub_needs_a_branch' } | { readonly sessionId: string } | { readonly code: 'tui_sub_reference_spilled'; readonly spilled: string | undefined } {
  if (record?.kind !== 'tool' || record.tool !== 'subagent') return { code: 'tui_sub_needs_a_branch' };
  const result = isRecord(record.result) ? record.result : undefined;
  const content = isRecord(result?.content) ? result.content : undefined;
  const sessionId = content?.sessionId;
  // 结果超出限制时存入溢出文件；此时支线 ID 可能不在记录内容中。
  if (typeof sessionId !== 'string' || sessionId === '') {
    return { code: 'tui_sub_reference_spilled', spilled: typeof result?.spilled === 'string' ? result.spilled : undefined };
  }
  return { sessionId };
}

// 标题注明当前显示的是主会话还是派生会话，因为两者使用各自的事件序号。
interface DetailTitleOptions {
  readonly seq: number | null;
  readonly kind: string;
  readonly branch?: string;
}

export function detailTitle(detail: DetailTitleOptions, locale: Locale = 'zh'): string {
  if (detail.branch === undefined) return chooseText(locale, `记录 ${detail.seq}（${detail.kind}）的完整内容 · /show 收起`, `Event ${detail.seq} (${detail.kind}) · /show to close`);
  return chooseText(locale, `支线 ${detail.branch}，父记录第 ${detail.seq} 那一次派生 · 这里的序号是支线自己的 · /sub 收起`, `Subtask ${detail.branch}, from event ${detail.seq} · sequence numbers belong to this subtask · /sub to close`);
}

// 审批卡显示写入操作的目标和变更摘要，便于用户检查后再决定是否允许。
export function changeSummary(tool: string, args: Record<string, unknown>, locale: Locale = 'zh'): string {
  return describeChange(tool, args, locale).summary;
}

export function controlTargetFromChoice(id: string, current: string | null): string | null {
  return id.startsWith('grant:') ? id.slice('grant:'.length) : current;
}

// 展开写入类审批时显示目标路径、原内容和新内容，并分别加上减号与加号。
// 未读取过的内容不展示；删除操作只说明文件会移入回收站。
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

// 队列预览截短为单行，避免长消息撑开输入区。
export function queuedLine(text: string, limit = 64): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

// 问题卡显示选项和自由回答。`undefined` 表示尚未回答，`null` 表示已提交空答复。
const answeredLine = (answer: AskAnswer | null | undefined, locale: Locale = 'zh') => answer === undefined ? chooseText(locale, '尚未回答', 'Not answered')
  : answer === null ? chooseText(locale, '已跳过', 'Skipped')
  : [answer.selected.join(', '), answer.custom].filter((one) => one !== '' && one !== undefined).join('; ') || chooseText(locale, '未回答', 'Not answered');

// 有选项时明确说明如何选择，避免用户误以为只接受自由文本。
const optionHint = (question: AskQuestion, locale: Locale = 'zh') => question.options.length === 0
  ? chooseText(locale, '输入回答', 'Type your answer')
  : question.multiSelect ? chooseText(locale, '输入回答或多个选项编号', 'Type an answer or multiple option numbers') : chooseText(locale, '输入回答或选项编号', 'Type an answer or an option number');

// 未提供持久化接口时，输入历史只保存在当前进程中，退出后丢失。
// 持久化接口返回写入后的列表，供组件直接使用并保持依赖稳定。
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
  // 一个提问请求包含一至四道题；逐题填写，最后一题提交后统一发送答复。
  const [query, setQuery] = useState<QuestionState | null>(null);
  const [running, setRunning] = useState(false);
  const [tick, setTick] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [panel, setPanel] = useState<PickerKind | 'help' | null>(null);
  const [choices, setChoices] = useState<RuntimeChoice[]>([]);
  const [choicesLoading, setChoicesLoading] = useState(false);
  const [controlSnapshot, setControlSnapshot] = useState<AgentControlSnapshot | null>(null);
  const [controlTarget, setControlTarget] = useState<string | null>(null);
  const [controlWizard, setControlWizard] = useState<ControlWizard | null>(null);
  const [mcpTrustPending, setMcpTrustPending] = useState<McpTrustPending | null>(null);
  const [externalControl, setExternalControl] = useState(false);
  const [externalSnapshot, setExternalSnapshot] = useState<ExternalControlSnapshot | null>(null);
  const [externalModel, setExternalModel] = useState<string | null>(null);
  const resolvedExternalInteractions = useRef(new Set<string>());
  useEffect(() => { resolvedExternalInteractions.current.clear(); }, [sessionId]);
  useEffect(() => { setMcpTrustPending(null); }, [sessionId]);
  const pickerRequest = useRef(0);
  const sessionNavigation = useRef({ generation: 0, activeToken: 0 });
  const sessionNavigationMounted = useRef(false);
  const [draft, setDraft] = useState('');
  const [caret, setCaret] = useState(0);
  // 撤销栈保存每次编辑前的草稿和光标位置；Ctrl+Z 撤销，Ctrl+Y 重做。
  // 撤销记录只保存在当前进程；草稿本身通过持久化输入状态跨退出保存。
  // 撤销和重做各保留最近 100 个状态。
  const undo = useRef<UndoState>({ stack: [], future: [], kind: null, before: { draft: '', caret: 0 } });
  useEffect(() => {
    const cell = undo.current;
    const current = { draft, caret };
    const previous = cell.before;
    cell.before = current;
    if (current.draft === previous.draft) { cell.kind = null; return; }
    const run = isTypingRun(previous, current);
    // 连续输入的字符合并为一个撤销单位。
    if (run && cell.kind === 'insert') return;
    cell.stack = [...cell.stack.slice(-99), previous];
    cell.kind = run ? 'insert' : 'text';
  }, [draft, caret]);
  // 用于替换整份草稿并清空撤销栈，避免撤销到其他会话的输入。
  const resetDraft = useCallback((text: string) => {
    const normalized = text.replace(/\r\n?/g, '\n');
    const cell = undo.current;
    cell.stack = [];
    cell.future = [];
    cell.kind = null;
    cell.before = { draft: normalized, caret: normalized.length };
    setDraft(normalized);
    setCaret(normalized.length);
  }, []);
  // 输入历史跨会话保存，不写入会话记录。最新输入位于列表前端，方向键向下浏览更早内容。
  const [entries, setEntries] = useState(history.entries);
  const [historyAt, setHistoryAt] = useState(-1);
  const [historyDraft, setHistoryDraft] = useState('');
  // Ctrl+R 反向搜索的查询文本和当前匹配位置；未搜索时为 null。
  const [search, setSearch] = useState<SearchState | null>(null);
  const [status, setStatus] = useState<TuiStatus | null>(null);
  // `Static` 不会重绘已提交行，因此查看单条详情时在动态区重新绘制。
  const [detail, setDetail] = useState<DetailState | null>(null);
  // 斜杠命令候选的当前选择索引；候选内容始终从草稿重新计算。
  const [pick, setPick] = useState(0);
  useEffect(() => { setPick(0); }, [draft]);
  // 记住按 Esc 关闭候选时的草稿；输入变化后重新显示候选。
  const [dismissedAt, setDismissedAt] = useState<string | null>(null);
  // 运行期间通过 Enter 提交的消息先排在界面队列中，不立即写入会话记录。
  const [queue, setQueue] = useState<string[]>([]);
  // 取消当前轮次后暂停队列，等待用户明确继续。
  const [queuePaused, setQueuePaused] = useState(false);
  // `@` 路径候选由 Host 提供，TUI 不直接扫描文件。
  const [mention, setMention] = useState<MentionState | null>(null);
  // 按 Esc 暂时关闭当前候选；草稿改变后再查询，文本未变时不重复弹出。
  const [hiddenMention, setHiddenMention] = useState('');
  const mentionWanted = useRef<ReturnType<typeof mentionToken> | typeof NO_TOKEN>(NO_TOKEN);
  const mentionAsked = useRef<ReturnType<typeof mentionToken> | typeof NO_TOKEN>(NO_TOKEN);
  // Ink 结束后禁止继续写入，避免迟到的答复或状态更新触发 `write after end`。
  const alive = useRef(true);
  useEffect(() => () => {
    alive.current = false;
    sessionNavigation.current.generation += 1;
  }, []);
  const push = useCallback((...added: TranscriptItem[]) => {
    if (!alive.current) return;
    setRows((current) => [...current, ...added]);
  }, []);
  // 用户快捷键覆盖存放在独立的本地文件中，不进入会话记录、模型上下文或项目配置。
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
      // 逐项报告无法保存的快捷键覆盖；其他有效覆盖和默认快捷键继续生效。
      if (refused.length > 0) push({ kind: 'meta', text: t(`${refused.length} 项快捷键无效，使用默认值：${refused.join('、')}`, `${refused.length} invalid shortcuts use defaults: ${refused.join(', ')}`) });
      else if (outcome.applied.length > 0) push({ kind: 'meta', text: t(`已加载 ${outcome.applied.length} 项自定义快捷键（/bind 查看）`, `Loaded ${outcome.applied.length} custom shortcuts (/bind to browse)`) });
    })();
  }, [keys, push, t]);
  // 草稿和队列按会话隔离；切换会话时保存当前状态，切回后恢复，避免误发或丢失输入。
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

  // 退出前将未发送草稿和队列持久化到本地输入状态文件，并按会话恢复。
  // 每份会话只在首次恢复时读取；响应返回前若已切换会话则丢弃，避免覆盖其他会话草稿。
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
      // 恢复期间若用户已输入新内容，保留新输入，不用旧草稿覆盖。
      if (saved.draft !== '' && inputNow.current.draft === '') resetDraft(saved.draft);
      // 恢复后的队列保持暂停，避免重启后自动发送用户尚未确认的消息。
      if (saved.queued.length > 0 && inputNow.current.queue.length === 0) {
        setQueue(saved.queued);
        setQueuePaused(true);
      }
    })().catch(() => inputState.current.delete(own));
  }, [info.boundary, inputs, sessionId]);

  // 输入停止 400 毫秒后保存，减少连续输入期间的磁盘写入，同时保留退出前的最新草稿。
  useEffect(() => {
    if (inputs === undefined || !inputState.current.has(sessionId)) return;
    const own = sessionId;
    const root = info.boundary ?? '';
    const timer = setTimeout(() => {
      void inputs.write(root, own, draft, queue).catch(() => push({ kind: 'error', text: t('无法保存草稿和队列，请复制后再退出', 'Could not save draft and queue; copy your input before exiting') }));
    }, 400);
    return () => clearTimeout(timer);
  }, [draft, info.boundary, inputs, push, queue, sessionId, t]);

  // `@` 候选查询在输入停止 160 毫秒后发送；查询期间文本变化时忽略旧响应。
  // 传输层不支持中途取消，因此通过丢弃过期结果避免更新界面。
  useEffect(() => {
    const token = mentionToken(draft, caret);
    if (token === null) { setMention(null); mentionAsked.current = NO_TOKEN; return; }
    mentionWanted.current = token;
    if (hiddenMention === token.text) { mentionAsked.current = NO_TOKEN; return; }
    // 用 ref 保存上一次查询文本，避免更新 state 触发 effect 重跑并取消已安排的请求。
     const asked = mentionAsked.current;
     if (asked !== null && asked.start === token.start && asked.text === token.text) return;
    // 查询文本变化后清除旧候选，避免 Enter 插入与当前输入不匹配的路径。
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
  useEffect(() => {
    pickerRequest.current += 1;
    if (sessionNavigationMounted.current) sessionNavigation.current.generation += 1;
    else sessionNavigationMounted.current = true;
    if (ask !== null || query !== null) setSessionPicker(null);
  }, [ask, query, sessionId]);
  const [approvalExpanded, setApprovalExpanded] = useState(false);
  const [approvalCursor, setApprovalCursor] = useState(0);
  const [questionCursor, setQuestionCursor] = useState(0);
  useEffect(() => setQuestionCursor(0), [query?.id, query?.at]);

  const refreshStatus = useCallback(async () => {
    // Ink 已退出时不再向已关闭的连接发送状态更新。
    if (!alive.current || externalControl) return;
    try {
      const current = await client.request('status.get', { sessionId });
      if (activeSession.current === sessionId) setStatus(current);
    } catch (error) {
      if (activeSession.current !== sessionId) return;
      setStatus(null);
      push({ kind: 'error', text: t(`无法读取状态：${errorCode(error) ?? errorMessage(error) ?? String(error)}`, `Could not read status: ${errorCode(error) ?? errorMessage(error) ?? String(error)}`) });
    }
  }, [client, externalControl, push, sessionId, t]);

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
        // 持久化事件到达后，以记录事件替换流式占位内容。
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
        // TUI 只显示当前会话的问题；后台会话的问题无法从当前终端界面回答。
        const asked = params;
        if (asked.sessionId !== sessionId || !Array.isArray(asked.questions) || asked.questions.length === 0 || !asked.questions.every(isAskQuestion)) return;
        pickerRequest.current += 1;
        sessionNavigation.current.generation += 1;
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
      sessionNavigation.current.generation += 1;
      setPanel(null);
      const args = isRecord(params.args) ? params.args : {};
      setApprovalExpanded(false);
      setApprovalCursor(0);
      setDetail(null);
      setSessionPicker(null);
      setSearch(null);
      setExpanded(false);
      // 审批摘要显示操作对象，例如命令、路径、网络地址或 MCP 工具。
      // 写入内容不在摘要行中重复显示；此处显示行数，完整内容可通过 `/show` 查看。
      const shown = typeof params.command === 'string' ? params.command : typeof args.path === 'string' ? args.path : typeof args.url === 'string' ? args.url : typeof args.server === 'string' ? `mcp:${args.server}/${typeof args.tool === 'string' ? args.tool : ''}` : '';
      const binding = isRecord(params.scriptBinding) ? params.scriptBinding : undefined;
      const bindingText = binding === undefined ? '' : `\n\n${chooseText(locale, '脚本审批绑定', 'Script approval binding')}\n${chooseText(locale, '路径', 'Path')}: ${String(binding.path ?? '')}\nSHA-256: ${String(binding.sha256 ?? '')}\n${chooseText(locale, '解释器', 'Interpreter')}: ${String(binding.interpreter ?? '')}\n${chooseText(locale, '工作区', 'Workspace')}: ${String(binding.workspaceRoot ?? '')}\n${chooseText(locale, '权限', 'Permission')}: ${isRecord(binding.permission) ? `${String(binding.permission.profile ?? '')} / ${String(binding.permission.network ?? '')} / ${JSON.stringify(binding.permission.capabilities ?? {})}` : ''}`;
      const detailsSummary = typeof params.contentBytes === 'number' && typeof params.contentSha256 === 'string'
        ? chooseText(locale, `内容 ${params.contentBytes} 字节 · SHA-256 ${params.contentSha256}`, `Content ${params.contentBytes} bytes · SHA-256 ${params.contentSha256}`)
        : typeof params.argumentSha256 === 'string'
          ? chooseText(locale, `参数 ${params.argumentBytes ?? 0} 字节 · SHA-256 ${params.argumentSha256}`, `Arguments ${params.argumentBytes ?? 0} bytes · SHA-256 ${params.argumentSha256}`)
          : '';
      setAsk({
        id: message.id,
        tool: params.tool,
        detail: shown === '' ? JSON.stringify(args) : String(shown),
        change: changeSummary(params.tool, args, locale),
        reason: typeof params.reason === 'string' ? params.reason : '',
        content: `${detailsSummary === '' ? '' : `${detailsSummary}\n\n`}${approvalBody(params.tool, args, locale)}${bindingText}`,
        // 显示本次判定和执行使用的命令语法及可执行文件。
        backend: typeof params.shell === 'string' ? `${params.shell} · ${typeof params.executable === 'string' ? params.executable : ''}` : '',
        rememberable: params.rememberable === true,
        rememberScopes: Array.isArray(params.rememberScopes)
          ? params.rememberScopes.filter((scope): scope is McpTrustScope => scope === 'session' || scope === 'project' || scope === 'user')
          : [],
        rememberHintKey: params.rememberHintKey === 'file' || params.rememberHintKey === 'command' || params.rememberHintKey === 'mcp' || params.rememberHintKey === 'tool' ? params.rememberHintKey : '',
        rememberTargetOptions: Array.isArray(params.rememberTargetOptions)
          ? params.rememberTargetOptions.filter((target): target is 'file' | 'workspace' | 'tool' | 'command' => target === 'file' || target === 'workspace' || target === 'tool' || target === 'command')
          : [],
        ...(typeof params.detailsRef === 'string' ? { detailsRef: params.detailsRef } : {}),
        ...(typeof params.argumentBytes === 'number' ? { argumentBytes: params.argumentBytes } : {}),
        ...(typeof params.argumentSha256 === 'string' ? { argumentSha256: params.argumentSha256 } : {}),
        ...(typeof params.identityDigest === 'string' ? { identityDigest: params.identityDigest } : {}),
        detailsSummary,
        detailSuffix: bindingText,
        detailsLoaded: false,
        detailsLoading: false,
      });
    };
    client.onNotification(onNotification);
    client.onRequest(onRequest);
    void refreshStatus();
  }, [client, locale, push, refreshStatus, sessionId]);

  useEffect(() => {
    if (!externalControl) return undefined;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cursor = 0;
    let operationId: string | null = null;
    let inFlight = false;
    let lastFailure = '';
    const projectRoot = info.boundary ?? '';
    const schedule = (delayMs: number) => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => { timer = undefined; void poll(); }, delayMs);
    };
    const refreshTranscript = async () => {
      const read = await client.request('session.observe', { projectRoot, sessionId, limit: 400, fullResults: true });
      if (disposed || activeSession.current !== sessionId) return;
      setRows(read.events.flatMap((event) => projectRecord(event, locale).map((row) => ({ ...row, seq: event.seq }))));
      setExternalModel(externalModelFrom(read.events));
    };
    const poll = async () => {
      if (disposed || inFlight) return;
      inFlight = true;
      let nextDelay = 1_000;
      try {
        const snapshot = await client.request('session.control', {
          projectRoot,
          sessionId,
          request: { action: 'status', after: cursor, limit: 50, waitMs: 10_000 },
        }) as ExternalControlSnapshot;
        if (disposed || activeSession.current !== sessionId) return;
        const currentOperationId = snapshot.operationId ?? null;
        if (currentOperationId !== operationId) {
          operationId = currentOperationId;
          cursor = 0;
          setExternalSnapshot(snapshot);
          nextDelay = 0;
          return;
        }
        setExternalSnapshot(snapshot);
        setRunning(snapshot.state === 'running');
        for (const event of snapshot.events) {
          if (event.kind === 'model.delta' && (event.type === 'text' || event.type === 'reasoning') && typeof event.text === 'string') {
            setLive((current) => ({ ...current, [event.type as 'text' | 'reasoning']: current[event.type as 'text' | 'reasoning'] + event.text }));
          }
          if (event.kind === 'session.event' && typeof event.eventKind === 'string') {
            if (event.eventKind === 'assistant') setLive((current) => ({ ...current, text: '' }));
            if (event.eventKind === 'reasoning') setLive((current) => ({ ...current, reasoning: '' }));
            void refreshTranscript().catch((error: unknown) => push({ kind: 'error', text: t(`外控会话转录读取失败：${errorCode(error) ?? 'session_observe_failed'}`, `Could not refresh external transcript: ${errorCode(error) ?? 'session_observe_failed'}`) }));
          }
        }
        if (snapshot.eventGap) {
          cursor = Math.max(0, (snapshot.firstAvailableCursor ?? cursor + 1) - 1);
          void refreshTranscript().catch((error: unknown) => push({ kind: 'error', text: t(`外控会话转录读取失败：${errorCode(error) ?? 'session_observe_failed'}`, `Could not refresh external transcript: ${errorCode(error) ?? 'session_observe_failed'}`) }));
        }
        cursor = Math.max(cursor, snapshot.nextCursor);
        const question = snapshot.pendingInteractions.find((item) => item.type === 'question'
          && !resolvedExternalInteractions.current.has(item.requestId));
        if (question !== undefined && Array.isArray(question.details.questions) && question.details.questions.every(isAskQuestion)) {
          setQuery((current) => current?.external === true && current.id === question.requestId
            ? current
            : { id: question.requestId, questions: question.details.questions as AskQuestion[], at: 0, picked: {}, external: true });
        } else setQuery((current) => current?.external === true ? null : current);
        const approval = snapshot.pendingInteractions.find((item) => item.type === 'approval'
          && !resolvedExternalInteractions.current.has(item.requestId));
        if (approval !== undefined) {
          const args = isRecord(approval.details.args) ? approval.details.args : {};
          const shown = typeof approval.details.command === 'string' ? approval.details.command
            : typeof args.path === 'string' ? args.path
              : typeof args.url === 'string' ? args.url
                : typeof args.server === 'string' ? `mcp:${args.server}/${typeof args.tool === 'string' ? args.tool : ''}`
                  : '';
          const detailsSummary = typeof approval.details.contentBytes === 'number' && typeof approval.details.contentSha256 === 'string'
            ? chooseText(locale, `内容 ${approval.details.contentBytes} 字节 · SHA-256 ${approval.details.contentSha256}`, `Content ${approval.details.contentBytes} bytes · SHA-256 ${approval.details.contentSha256}`)
            : typeof approval.details.argumentSha256 === 'string'
              ? chooseText(locale, `参数 ${approval.details.argumentBytes ?? 0} 字节 · SHA-256 ${approval.details.argumentSha256}`, `Arguments ${approval.details.argumentBytes ?? 0} bytes · SHA-256 ${approval.details.argumentSha256}`)
              : '';
          const approvalTool = typeof approval.details.tool === 'string' ? approval.details.tool : 'unknown';
          setAsk((current) => current?.external === true && current.id === approval.requestId
            ? current
            : {
                id: approval.requestId,
                tool: approvalTool,
                detail: shown === '' ? JSON.stringify(args) : shown,
                change: changeSummary(approvalTool, args, locale),
                content: `${detailsSummary === '' ? '' : `${detailsSummary}\n\n`}${approvalBody(approvalTool, args, locale)}`,
                backend: typeof approval.details.shell === 'string' ? `${approval.details.shell} · ${typeof approval.details.executable === 'string' ? approval.details.executable : ''}` : '',
                reason: typeof approval.details.reason === 'string' ? approval.details.reason : '',
                rememberable: approval.details.rememberable === true,
                rememberScopes: Array.isArray(approval.details.rememberScopes)
                  ? approval.details.rememberScopes.filter((scope): scope is McpTrustScope => scope === 'session' || scope === 'project' || scope === 'user')
                  : [],
                rememberHintKey: approval.details.rememberHintKey === 'file' || approval.details.rememberHintKey === 'command'
                  || approval.details.rememberHintKey === 'mcp' || approval.details.rememberHintKey === 'tool'
                  ? approval.details.rememberHintKey
                  : '',
                rememberTargetOptions: Array.isArray(approval.details.rememberTargetOptions)
                  ? approval.details.rememberTargetOptions.filter((target): target is 'file' | 'workspace' | 'tool' | 'command' => target === 'file' || target === 'workspace' || target === 'tool' || target === 'command')
                  : [],
                ...(typeof approval.details.detailsRef === 'string' ? { detailsRef: approval.details.detailsRef } : {}),
                ...(typeof approval.details.argumentBytes === 'number' ? { argumentBytes: approval.details.argumentBytes } : {}),
                ...(typeof approval.details.argumentSha256 === 'string' ? { argumentSha256: approval.details.argumentSha256 } : {}),
                ...(typeof approval.details.identityDigest === 'string' ? { identityDigest: approval.details.identityDigest } : {}),
                detailsSummary,
                detailsLoaded: false,
                detailsLoading: false,
                external: true,
              });
        } else setAsk((current) => current?.external === true ? null : current);
        lastFailure = '';
        nextDelay = snapshot.state === 'running' ? 0 : 1_000;
      } catch (error) {
        const code = errorCode(error) ?? 'external_control_failed';
        setRunning(false);
        if (lastFailure !== code) push({ kind: 'error', text: t(`外控会话不可用：${code}`, `External session unavailable: ${code}`) });
        lastFailure = code;
        nextDelay = 1_000;
      } finally {
        inFlight = false;
        if (!disposed && timer === undefined) schedule(nextDelay);
      }
    };
    void poll();
    return () => { disposed = true; if (timer !== undefined) clearTimeout(timer); };
  }, [client, externalControl, info.boundary, locale, push, sessionId, t]);

  // 终端标题显示模型、项目根和当前会话，切换会话时同步更新。
  // 非交互终端不写标题控制序列，避免污染管道输出。
  useEffect(() => {
    if (stdout?.isTTY !== true) return;
    stdout.write(titleEscape(titleText({ model: status?.model ?? info.model, boundary: info.boundary, sessionId })));
  }, [info.boundary, info.model, sessionId, status?.model, stdout]);

  // 轮次运行时显示转圈状态和经过时间，让用户知道任务仍在执行且可取消。
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
    // 只有实际发送的输入才加入历史；队列消息在发送时分别记录。
    // 先立即更新本地列表以响应按键，再替换为 Host 锁内更新后的共享列表。
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
    if (externalControl) {
      try {
        const accepted = await client.request('session.control', {
          projectRoot: info.boundary ?? '',
          sessionId,
          request: { action: 'send', input: text },
        }) as { readonly accepted?: boolean; readonly queued?: boolean };
        setRunning(true);
        push({ kind: 'meta', text: accepted.queued === true
          ? t('消息已加入外控会话队列', 'Message queued for the external session')
          : t('消息已发送到外控会话', 'Message sent to the external session') });
      } catch (error) {
        push({ kind: 'error', text: t(`外控消息发送失败：${errorCode(error) ?? 'external_control_failed'}`, `Could not send external message: ${errorCode(error) ?? 'external_control_failed'}`) });
      }
      return;
    }
    setRunning(true);
    try {
      await client.request('run.start', { sessionId, input: text });
      if (!terminalReceived.current) push({ kind: 'meta', text: t('本轮已完成', 'Turn completed') });
    } catch (error) {
      const code = errorCode(error) ?? 'run_failed';
      const diagnostics = providerDiagnosticText(isRecord(error) ? error.diagnostics : undefined, locale);
      // 根据取消位置显示对应错误码：模型请求为 `provider_cancelled`，调用组之间为 `loop_cancelled`，等待用户答复为 `ask_user_cancelled`。
      if (!terminalReceived.current) {
        if (code === 'loop_cancelled' || code === 'provider_cancelled' || code === 'ask_user_cancelled') push({ kind: 'meta', text: t('本轮已取消', 'Turn cancelled') });
        else push({ kind: 'error', text: `${t(`运行失败：${code}`, `Run failed: ${code}`)}${runtimeFailureText(code, locale) === undefined ? '' : `\n${runtimeFailureText(code, locale)}`}${diagnostics === undefined ? '' : `\n${diagnostics}`}` });
      }
    } finally {
      setAsk(null);
      setLive({ text: '', reasoning: '' });
      // 轮次取消后 Host 会记录未答问题的结果，界面移除对应问题卡片。
      setQuery(null);
      setRunning(false);
      void refreshStatus();
    }
  }, [client, externalControl, info.boundary, push, refreshStatus, remember, sessionId, t]);

  // 按第一个词解析命令，完整保留其余文本作为参数。
  const closePanel = useCallback(() => {
    pickerRequest.current += 1;
    setPanel(null);
  }, []);

  const changePermission = useCallback(async ({
    profile,
    network,
    confirmFullAccess = false,
    confirmNetwork = false,
    confirmPartialWorkspaceWrite = false,
    confirmWorkspaceTrust = false,
  }: {
    readonly profile?: 'read-only' | 'workspace-write' | 'full-access';
    readonly network?: 'policy' | 'unrestricted' | 'disabled';
    readonly confirmFullAccess?: boolean;
    readonly confirmNetwork?: boolean;
    readonly confirmPartialWorkspaceWrite?: boolean;
    readonly confirmWorkspaceTrust?: boolean;
  }) => {
    const own = sessionId;
    const current = await client.request('status.get', { sessionId: own }).catch((error: unknown) => requestFailure(error, 'status_read_failed'));
    if ('code' in current || current.permission === undefined) {
      push({ kind: 'error', text: t(`无法读取当前权限：${'code' in current ? current.code : 'permission_status_unavailable'}`, `Could not read current permissions: ${'code' in current ? current.code : 'permission_status_unavailable'}`) });
      return;
    }
    if (!current.permission.changeAllowed) {
      setStatus(current);
      push({ kind: 'error', text: t('此连接不能修改会话权限；请使用受信任的本地 TUI 或 Desktop 操作。', 'This connection cannot change session permissions; use a trusted local TUI or Desktop action.') });
      return;
    }
    const changed = await client.request('permission.set', {
      sessionId: own,
      permissionProfile: profile ?? current.permission.profile,
      ...(network === undefined ? {} : { permissionNetwork: network }),
      ...(confirmFullAccess ? { confirmFullAccess: true } : {}),
      ...(confirmNetwork ? { confirmNetwork: true } : {}),
      ...(confirmPartialWorkspaceWrite ? { confirmPartialWorkspaceWrite: true } : {}),
      ...(confirmWorkspaceTrust ? { confirmWorkspaceTrust: true } : {}),
    }).catch((error: unknown) => requestFailure(error, 'permission_change_failed'));
    if ('code' in changed) {
      push({ kind: 'error', text: t(`无法修改会话权限：${changed.code}`, `Could not change session permissions: ${changed.code}`) });
      return;
    }
    const refreshed = await client.request('status.get', { sessionId: own }).catch(() => null);
    if (activeSession.current === own) setStatus(refreshed);
    const effective = refreshed?.permission ?? changed.permission;
    push({ kind: 'meta', text: [
      t(`权限已更新：${effective.profile} · 网络 ${effective.network}`, `Permissions updated: ${effective.profile} · network ${effective.network}`),
      effective.execution.available
        ? t('Shell 隔离：可用', 'Shell sandbox: available')
        : t(`Shell 隔离：不可用（${effective.execution.code ?? effective.execution.reason ?? '原因未知'}）`, `Shell sandbox: unavailable (${effective.execution.code ?? effective.execution.reason ?? 'unknown reason'})`),
    ].join('\n') });
  }, [client, push, sessionId, t]);

  const exitTui = useCallback((savedDraft = inputNow.current.draft) => {
    if (inputs === undefined) { app.exit(); return; }
    void inputs.write(info.boundary ?? '', sessionId, savedDraft, inputNow.current.queue).then(
      () => app.exit(),
      () => push({ kind: 'error', text: t('无法保存草稿和队列，请复制后重试退出', 'Could not save draft and queue; copy your input and retry exiting') }),
    );
  }, [app, inputs, info.boundary, sessionId, push, t]);

  const openPicker = useCallback((kind: PickerKind, requestedControlTarget = controlTarget) => {
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
      if (kind === 'control') {
        const snapshot = await client.request('agent-control.list', {}) as AgentControlSnapshot;
        setControlSnapshot(snapshot);
        available = [
          { id: 'create', label: t('新建外控授权', 'Create a grant'), description: t('开始逐项填写授权上限和到期时间。', 'Enter the grant limits and expiry one step at a time.') },
          ...snapshot.grants.map((grant) => {
            const state = grant.revokedAt !== null ? t('已撤销', 'revoked')
              : grant.expiresAt !== null && Date.parse(grant.expiresAt) <= Date.now() ? t('已到期', 'expired') : t('可用', 'available');
            return {
              id: `grant:${grant.id}`,
              label: `${grant.name} · ${state}`,
              description: `${grant.maxPermissionProfile} · ${grant.maxNetwork} · ${grant.projectRoot} · ${t('进程在线状态未知', 'process status unknown')}`,
            };
          }),
        ];
      } else if (kind === 'control-action') {
        const snapshot = controlSnapshot ?? await client.request('agent-control.list', {}) as AgentControlSnapshot;
        const grant = snapshot.grants.find((item) => item.id === requestedControlTarget);
        if (grant === undefined) throw new Error('agent_control_grant_not_found');
        const expired = grant.expiresAt !== null && Date.parse(grant.expiresAt) <= Date.now();
        available = [
          { id: 'copy-config', label: t('复制 MCP 配置', 'Copy MCP config'), description: t('只包含 CLI、项目路径和授权 ID，不包含密钥。', 'Contains the CLI, project path, and grant ID; no credentials.') },
          ...(grant.revokedAt === null && !expired ? [{ id: 'revoke', label: t('撤销此授权', 'Revoke this grant'), description: t('取消正在运行的任务并拒绝该授权的后续调用。', 'Cancel active work and reject later calls using this grant.') }] : []),
          { id: 'back', label: t('返回授权列表', 'Back to grants') },
        ];
      } else if (kind === 'control-revoke-confirm') {
        available = [
          { id: 'confirm', label: t('确认撤销授权', 'Confirm revocation'), description: t('MCP Host 会检查撤销并取消运行中的任务。', 'The MCP Host checks revocation and cancels active work.') },
          { id: 'cancel', label: t('取消', 'Cancel') },
        ];
      } else if (kind === 'model') {
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
      } else if (kind === 'policy') {
        available = [
          { id: 'ask', label: t('逐次审批', 'Ask for each tool'), description: t('工具执行前询问；已有拒绝规则和访问边界继续生效。', 'Ask before tools execute; denial rules and access boundaries still apply.') },
          { id: 'auto', label: t('自动判定', 'Automatic decisions'), description: t('由现有规则判定；仍可能请求审批，访问边界不变。', 'Use the existing rules; approvals may still be requested and access boundaries stay unchanged.') },
          { id: 'none', label: t('不受审批', 'No approval'), description: t('普通权限内工具不等待逐项审批；工作区边界、拒绝规则和独立信任要求仍生效。', 'Ordinary in-bound tools do not wait for approval; workspace boundaries, deny rules, and separate trust requirements remain active.') },
          { id: 'reset', label: t('使用配置默认', 'Use configured default'), description: t('撤销当前会话的审批方式覆盖。', 'Clear this session’s approval-mode override.') },
        ];
      } else {
        const current = await client.request('status.get', { sessionId: own });
        if (activeSession.current !== own || pickerRequest.current !== token) return;
        setStatus(current);
        const permission = current.permission;
        if (permission === undefined) throw new Error('permission_status_unavailable');
        if (!permission.changeAllowed) {
          available = [];
          if (permission.changeReason !== undefined) {
            push({ kind: 'meta', text: t(
              `权限暂不可更改：${permission.changeReason}`,
              `Permissions cannot be changed now: ${permission.changeReason}`,
            ) });
          }
        } else if (kind === 'permission') {
          const capabilities = permission.capabilities;
          const enforcement = [
            `${t('读取', 'read')} ${capabilities.filesystemRead}`,
            `${t('写入', 'write')} ${capabilities.filesystemWrite}`,
            `${t('网络', 'network')} ${capabilities.network}`,
            `${t('进程', 'process')} ${capabilities.process}`,
            `${t('只读 Shell', 'read-only Shell')} ${permission.profiles.readOnly}`,
            `${t('工作区写入 Shell', 'workspace-write Shell')} ${permission.profiles.workspaceWrite}`,
          ].join(' · ');
          available = [
            { id: 'read-only', label: t('只读 · read-only', 'Read only · read-only'), description: t(`当前：${permission.profile} · 网络 ${permission.network} · 隔离能力：${enforcement} · Shell ${permission.execution.available ? '可用' : `不可用（${permission.execution.code ?? '能力不足'}）`}`, `Current: ${permission.profile} · network ${permission.network} · isolation: ${enforcement} · Shell ${permission.execution.available ? 'available' : `unavailable (${permission.execution.code ?? 'capability limits'})`}`) },
            { id: 'workspace-write', label: t('工作区可写 · workspace-write', 'Workspace write · workspace-write'), description: t(`Shell ${permission.profiles.workspaceWrite} · 项目 ${permission.workspaceTrusted ? '已信任' : '未信任'}；Windows 部分隔离可能无法限制读取、网络及硬链接或父目录删除权限越界；正常清理会撤销临时 ACE，但自动继承元数据标记可能保留。Shell 每次运行使用临时用户配置目录，用户级缓存不会沿用。${permission.limitations[0] ?? ''}`, `Shell ${permission.profiles.workspaceWrite} · project ${permission.workspaceTrusted ? 'trusted' : 'untrusted'}; Windows partial isolation may not restrict reads, network, hard links, or delete-child access on parent folders. Normal cleanup revokes temporary ACEs, but auto-inheritance metadata may remain. Each Shell command uses a temporary user profile, so user-level caches are not reused. ${permission.limitations[0] ?? ''}`) },
            { id: 'full-access', label: t('完整访问 · full-access', 'Full access · full-access'), description: t('需要再次确认。范围仍受当前 OS 用户权限和 Policy 硬拒绝约束。', 'Requires a second confirmation. OS user permissions and hard Policy denials still apply.') },
            { id: 'network', label: t(`网络：${permission.network}`, `Network: ${permission.network}`), description: t('单独设置网络访问；这不会改变文件权限档位。', 'Configure network access separately; this does not change the filesystem profile.') },
          ];
        } else if (kind === 'permission-network') {
          available = [
            { id: 'policy', label: t('按 Policy 控制 · policy', 'Controlled by Policy · policy'), description: t('网络工具继续经过 Policy；Shell 只能在后端能阻止其联网时执行。', 'Network tools stay subject to Policy; Shell runs only when the backend can block its network access.') },
            { id: 'disabled', label: t('禁用网络 · disabled', 'Disable network · disabled'), description: t('拒绝网络工具和 Shell 的网络访问。', 'Deny network tools and Shell network access.') },
            { id: 'unrestricted', label: t('不受限网络 · unrestricted', 'Unrestricted network · unrestricted'), description: t('需要再次确认；Shell、MCP 和扩展可访问当前 OS 用户可用的网络。', 'Requires a second confirmation; Shell, MCP, and extensions can use the network available to this OS user.') },
          ];
        } else if (kind === 'permission-confirm-full') {
          available = [
            { id: 'confirm', label: t('我确认启用 full-access', 'Confirm full-access'), description: t(`允许当前 OS 用户可访问的文件和进程。Policy 与硬拒绝适用于 Host 工具调用；已加载的扩展是可信代码，可绕过这些检查直接使用 OS 能力。当前 Shell：${permission.execution.available ? '可用' : `不可用（${permission.execution.code ?? permission.execution.reason ?? '隔离能力不足'}）`}`, `Allow files and processes available to the current OS user. Policy and hard denials apply to Host tool calls; loaded extensions are trusted code and can use OS capabilities directly. Shell: ${permission.execution.available ? 'available' : `unavailable (${permission.execution.code ?? permission.execution.reason ?? 'sandbox limits'})`}`) },
            { id: 'cancel', label: t('取消', 'Cancel') },
          ];
        } else if (kind === 'permission-confirm-partial') {
          available = [
            { id: 'confirm', label: t('我信任此项目并接受适用的部分隔离限制', 'Trust this project and accept applicable partial-isolation limits'), description: t('Host 会在执行时检查平台。若使用 Windows 部分隔离，Shell 无法限制文件读取或网络；硬链接、重解析点或可写父目录删除权限可能越界，也不适合运行恶意代码。正常清理会撤销临时 ACE，但自动继承元数据标记可能保留。Shell 每次运行使用临时用户配置目录，用户级缓存不会沿用。', 'The Host checks the backend at execution time. If it uses Windows partial isolation, Shell cannot restrict file reads or network; hard links, reparse points, or delete-child rights on writable parent folders may escape the boundary, so it is not a container for hostile code. Normal cleanup revokes temporary ACEs, but auto-inheritance metadata may remain. Each Shell command uses a temporary user profile, so user-level caches are not reused.') },
            { id: 'cancel', label: t('取消', 'Cancel') },
          ];
        } else {
          available = [
            { id: 'confirm', label: t('我确认启用不受限网络', 'Confirm unrestricted network'), description: t('命令、MCP 服务器和扩展可能向外发送数据；普通工具审批和危险操作硬拒绝仍按原规则执行。', 'Commands, MCP servers, and extensions may send data externally; ordinary tool approvals and hard dangerous-operation denials remain active.') },
            { id: 'cancel', label: t('取消', 'Cancel') },
          ];
        }
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
  }, [client, controlSnapshot, controlTarget, info.boundary, modes, push, sessionId, t]);

  const beginSessionNavigation = useCallback((owner: string): SessionNavigationLease | undefined => {
    const navigation = sessionNavigation.current;
    if (navigation.activeToken !== 0) {
      push({ kind: 'meta', text: t('会话切换正在进行，请稍后重试。', 'A session switch is in progress; try again shortly.') });
      return undefined;
    }
    const token = ++navigation.generation;
    navigation.activeToken = token;
    return { token, owner };
  }, [push, t]);

  const sessionNavigationIsCurrent = useCallback((lease: SessionNavigationLease): boolean => {
    const navigation = sessionNavigation.current;
    return alive.current
      && navigation.activeToken === lease.token
      && navigation.generation === lease.token
      && activeSession.current === lease.owner;
  }, []);

  const finishSessionNavigation = useCallback((lease: SessionNavigationLease): void => {
    if (sessionNavigation.current.activeToken === lease.token) sessionNavigation.current.activeToken = 0;
  }, []);

  const closeUnadoptedSession = useCallback(async (targetId: string, owner: string, force = false): Promise<string | undefined> => {
    if (!force && targetId === owner) return undefined;
    const closed = await client.request('session.close', { sessionId: targetId })
      .catch((error: unknown) => requestFailure(error, 'session_close_failed'));
    return 'code' in closed ? closed.code : undefined;
  }, [client]);

  const runCommand = useCallback((name: string, argument = '') => {
    pickerRequest.current += 1;
    if (name === 'mcp') {
      const [action = 'list', serverName = '', scopeText = ''] = argument.trim().split(/\s+/, 3);
      const scopes: readonly McpTrustScope[] = ['session', 'project', 'user'];
      const scope = scopes.includes(scopeText as McpTrustScope) ? scopeText as McpTrustScope : undefined;
      if (action === 'confirm') {
        const pending = mcpTrustPending;
        if (pending === null) {
          push({ kind: 'error', text: t('没有待确认的 MCP Server 信任请求。', 'No MCP server trust request is pending.') });
          return;
        }
        void (async () => {
          try {
            const snapshot = await client.request('mcp.trust.list', { projectRoot: info.boundary, sessionId });
            const current = snapshot.servers.find((server) => server.name === pending.server);
            if (current === undefined || current.identityDigest !== pending.identityDigest) {
              setMcpTrustPending(null);
              throw new Error('mcp_server_config_changed');
            }
            await client.request('mcp.trust.set', {
              projectRoot: info.boundary, sessionId, server: pending.server, identityDigest: pending.identityDigest, scope: pending.scope, trusted: true,
              confirmTrust: true, confirmExternalAccess: true,
              ...(pending.scope === 'session' ? {} : { version: snapshot.version }),
            });
            setMcpTrustPending(null);
            push({ kind: 'meta', text: t(`已在${pending.scope}范围信任 ${pending.server}。`, `${pending.server} is trusted at ${pending.scope} scope.`) });
          } catch (error) {
            push({ kind: 'error', text: t(`MCP Server 未获信任：${errorCode(error) ?? errorMessage(error) ?? 'mcp_trust_failed'}`, `MCP server was not trusted: ${errorCode(error) ?? errorMessage(error) ?? 'mcp_trust_failed'}`) });
          }
        })();
        return;
      }
      if (action === 'list' || action === '') {
        void client.request('mcp.trust.list', { projectRoot: info.boundary, sessionId }).then((snapshot) => {
          const lines = snapshot.servers.length === 0 ? [t('当前项目没有配置 MCP Server。', 'No MCP servers are configured for this project.')]
            : snapshot.servers.map((server) => `${server.name} · ${server.trust === null ? t('未信任', 'untrusted') : server.trust.trusted ? t(`已信任 ${server.trust.scope}（可信本机界面）`, `trusted ${server.trust.scope} (trusted local UI)`) : t(`已阻止 ${server.trust.scope}`, `blocked ${server.trust.scope}`)} · ${server.command} ${server.args.join(' ')} · cwd ${server.cwd}`);
          push({ kind: 'meta', text: lines.join('\n') });
        }, (error: unknown) => push({ kind: 'error', text: t(`无法读取 MCP Server：${errorCode(error) ?? 'mcp_trust_list_failed'}`, `Could not read MCP servers: ${errorCode(error) ?? 'mcp_trust_list_failed'}`) }));
        return;
      }
      if (action === 'trust') {
        if (serverName === '' || scope === undefined) {
          push({ kind: 'error', text: t('用法：/mcp trust <Server> <session|project|user>', 'Usage: /mcp trust <server> <session|project|user>') });
          return;
        }
        if (scope === 'session' && sessionId === '') {
          push({ kind: 'error', text: t('当前没有会话，不能保存会话范围的信任。', 'There is no active session for session-scoped trust.') });
          return;
        }
        void client.request('mcp.trust.list', { projectRoot: info.boundary, sessionId }).then((snapshot) => {
          const server = snapshot.servers.find((item) => item.name === serverName);
          if (server === undefined) throw new Error('mcp_server_unknown');
          setMcpTrustPending({ server: server.name, scope, version: snapshot.version, identityDigest: server.identityDigest });
          push({ kind: 'meta', text: t(
            `待确认：${server.name}\n程序：${server.command}\n参数：${server.args.join(' ') || '无'}\n工作目录：${server.cwd}\n环境变量名：${server.environmentNames.join(', ') || '无'}\n它在 Shell 沙箱外运行，可访问当前 OS 用户可访问的文件和网络。输入 /mcp confirm 确认信任范围 ${scope}。`,
            `Pending trust: ${server.name}\nProgram: ${server.command}\nArguments: ${server.args.join(' ') || 'none'}\nWorking directory: ${server.cwd}\nEnvironment variable names: ${server.environmentNames.join(', ') || 'none'}\nIt runs outside the Shell sandbox and may access files and networks available to this OS user. Type /mcp confirm to trust at ${scope} scope.`,
          ) });
        }, (error: unknown) => push({ kind: 'error', text: t(`无法读取 MCP Server：${errorCode(error) ?? 'mcp_trust_list_failed'}`, `Could not read MCP server: ${errorCode(error) ?? 'mcp_trust_list_failed'}`) }));
        return;
      }
      if (action === 'revoke') {
        if (serverName === '' || scope === undefined) {
          push({ kind: 'error', text: t('用法：/mcp revoke <Server> <session|project|user>', 'Usage: /mcp revoke <server> <session|project|user>') });
          return;
        }
        void (async () => {
          try {
            const snapshot = await client.request('mcp.trust.list', { projectRoot: info.boundary, sessionId });
            const server = snapshot.servers.find((item) => item.name === serverName);
            if (server === undefined) throw new Error('mcp_server_unknown');
            await client.request('mcp.trust.set', {
              projectRoot: info.boundary, sessionId, server: serverName, identityDigest: server.identityDigest, scope, trusted: false,
              ...(scope === 'session' ? {} : { version: snapshot.version }),
            });
            setMcpTrustPending(null);
            push({ kind: 'meta', text: t(`已撤销 ${serverName} 的 ${scope} 信任。`, `Revoked ${scope} trust for ${serverName}.`) });
          } catch (error) {
            push({ kind: 'error', text: t(`撤销 MCP Server 信任失败：${errorCode(error) ?? errorMessage(error) ?? 'mcp_trust_failed'}`, `Could not revoke MCP server trust: ${errorCode(error) ?? errorMessage(error) ?? 'mcp_trust_failed'}`) });
          }
        })();
        return;
      }
      if (action === 'tools') {
        if (serverName === '') {
          push({ kind: 'error', text: t('用法：/mcp tools <Server>', 'Usage: /mcp tools <server>') });
          return;
        }
        push({ kind: 'meta', text: t(`正在启动已信任的 ${serverName} 并读取工具清单；不会调用工具。`, `Starting trusted server ${serverName} to list tools; no tools will be called.`) });
        void client.request('mcp.trust.tools', { projectRoot: info.boundary, sessionId, server: serverName }).then((listed) => {
          push({ kind: 'meta', text: listed.tools.map((tool) => `${tool.name}${tool.description === '' ? '' : ` · ${tool.description}`}`).join('\n') || t('此 Server 没有工具。', 'This server has no tools.') });
        }, (error: unknown) => push({ kind: 'error', text: t(`无法读取 MCP 工具：${errorCode(error) ?? 'mcp_tool_list_failed'}`, `Could not read MCP tools: ${errorCode(error) ?? 'mcp_tool_list_failed'}`) }));
        return;
      }
      push({ kind: 'error', text: t('用法：/mcp [list|trust <Server> <scope>|confirm|revoke <Server> <scope>|tools <Server>]', 'Usage: /mcp [list|trust <server> <scope>|confirm|revoke <server> <scope>|tools <server>]') });
      return;
    }
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
    if (name === 'control') {
      const [action = '', wanted = ''] = argument.trim().split(/\s+/, 2);
      if (action === '') {
        openPicker('control');
        return;
      }
      if (action === 'create' && wanted === '') {
        if (info.boundary === undefined || info.boundary === '') {
          push({ kind: 'error', text: t('当前没有已选择的项目目录。', 'No project directory is selected.') });
          return;
        }
        void (async () => {
          try {
            const trust = await client.request('mcp.trust.list', { projectRoot: info.boundary });
            const mcpServers = trust.servers.filter((server) =>
              server.trustScopes.project?.trusted === true || server.trustScopes.user?.trusted === true,
            ).map((server) => server.name);
            setControlWizard({ step: 0, values: {}, mcpServers, mcpTools: [] });
            setPanel(null);
            push({ kind: 'meta', text: t(
              `开始创建授权；每一步按 Enter 确认，输入 cancel 可取消。已信任的 MCP Server：${mcpServers.join(', ') || '无'}`,
              `Grant setup started. Press Enter after each answer; type cancel to stop. Trusted MCP servers: ${mcpServers.join(', ') || 'none'}`,
            ) });
          } catch (error) {
            push({ kind: 'error', text: t(`无法读取 MCP Server 信任状态：${errorCode(error) ?? 'mcp_trust_list_failed'}`, `Could not read MCP server trust: ${errorCode(error) ?? 'mcp_trust_list_failed'}`) });
          }
        })();
        return;
      }
      if (action !== 'list' && action !== 'copy' && action !== 'revoke') {
        push({ kind: 'error', text: t('用法：/control [list|create|copy <id>|revoke <id>]', 'Usage: /control [list|create|copy <id>|revoke <id>]') });
        return;
      }
      void (async () => {
        try {
          const snapshot = await client.request('agent-control.list', {}) as AgentControlSnapshot;
          setControlSnapshot(snapshot);
          if (action === 'list') {
            const lines = snapshot.grants.length === 0 ? [t('尚未创建外控授权。', 'No external Agent grants have been created.')]
              : snapshot.grants.map((grant) => {
                const state = grant.revokedAt !== null ? t('已撤销', 'revoked')
                  : grant.expiresAt !== null && Date.parse(grant.expiresAt) <= Date.now() ? t('已到期', 'expired') : t('可用', 'available');
                const expiry = grant.expiresAt === null ? t('无到期时间', 'no expiry') : `${t('到期', 'expires')} ${new Date(grant.expiresAt).toLocaleString()}`;
                const source = grant.source === 'trusted-ui'
                  ? t('可信界面创建', 'Trusted UI')
                  : t('历史记录未保存来源', 'Legacy record; source not recorded');
                return `${grant.id} · ${grant.name} · ${state} · ${t('权限', 'permission')} ${grant.defaultPermissionProfile} / ${grant.maxPermissionProfile} · ${t('网络', 'network')} ${grant.defaultNetwork} / ${grant.maxNetwork} · Policy ${grant.defaultPolicy} (${grant.allowedPolicies.join(', ')}) · MCP ${grant.allowedMcpServers.join(', ') || t('无', 'none')} · ${t('工具', 'tools')} ${grant.allowedMcpTools.join(', ') || t('无', 'none')} · ${expiry} · ${t('来源', 'source')} ${source} · ${grant.projectRoot} · ${t('在线状态未知', 'online status unknown')}`;
              });
            push({ kind: 'meta', text: lines.join('\n') });
            return;
          }
          const matches = snapshot.grants.filter((grant) => grant.id === wanted || grant.id.startsWith(wanted));
          if (matches.length !== 1) {
            push({ kind: 'error', text: matches.length === 0
              ? t(`未找到授权 ${wanted}`, `Grant ${wanted} was not found`)
              : t(`授权编号 ${wanted} 不唯一，请输入更多字符`, `Grant ID ${wanted} is ambiguous; enter more characters`) });
            return;
          }
          const grant = matches[0]!;
          if (action === 'copy') {
            const copied = await copyToClipboard(agentMcpConfig(grant));
            push('program' in copied
              ? { kind: 'meta', text: t(`已复制授权 ${grant.id} 的本地 MCP 配置`, `Copied local MCP configuration for grant ${grant.id}`) }
              : { kind: 'error', text: t(`复制配置失败：${copied.code}`, `Could not copy configuration: ${copied.code}`) });
            return;
          }
          if (grant.revokedAt !== null || (grant.expiresAt !== null && Date.parse(grant.expiresAt) <= Date.now())) {
            push({ kind: 'error', text: t('此授权已撤销或到期，不能再次撤销。', 'This grant is revoked or expired and cannot be revoked again.') });
            return;
          }
          setControlTarget(grant.id);
          openPicker('control-revoke-confirm');
        } catch (error) {
          push({ kind: 'error', text: t(`外控授权操作失败：${errorCode(error) ?? 'agent_control_failed'}`, `Agent Control operation failed: ${errorCode(error) ?? 'agent_control_failed'}`) });
        }
      })();
      return;
    }
    if (name === 'quit') {
      exitTui('');
      return;
    }
    if (name === 'new') {
      const lease = beginSessionNavigation(sessionId);
      if (lease === undefined) return;
      const owner = lease.owner;
      const wasExternal = externalControl;
      void (async () => {
        let createdId: string | undefined;
        let adopted = false;
        try {
          const created = await client.request('session.create', {});
          createdId = created.sessionId;
          if (!sessionNavigationIsCurrent(lease)) return;
          if (!wasExternal && owner !== created.sessionId) {
            const retired = await client.request('session.close', { sessionId: owner })
              .catch((error: unknown) => requestFailure(error, 'session_close_failed'));
            if ('code' in retired) {
              push({ kind: 'error', text: t(`无法关闭当前会话：${retired.code}`, `Could not close the current session: ${retired.code}`) });
              return;
            }
          }
          // Closing the old session is the commit point. No transition can overlap this operation.
          // If the TUI was unmounted after that point, Host release will retire the created session.
          if (!alive.current || activeSession.current !== owner) return;
          adopted = true;
          setSessionId(created.sessionId);
          setExternalControl(false);
          setExternalSnapshot(null);
          setExternalModel(null);
          setRunning(false);
          setAsk(null);
          setQuery(null);
          setStatus(null);
          setDetail(null);
          setSessionPicker(null);
          setRows([]);
          setLive({ text: '', reasoning: '' });
          push({ kind: 'meta', text: t(`新会话 ${created.sessionId.slice(0, 8)}`, `New session ${created.sessionId.slice(0, 8)}`) });
        } catch (error) {
          if (sessionNavigationIsCurrent(lease)) {
            push({ kind: 'error', text: t(`无法创建会话：${errorCode(error) ?? errorMessage(error) ?? 'unknown'}`, `Could not create session: ${errorCode(error) ?? errorMessage(error) ?? 'unknown'}`) });
          }
        } finally {
          if (createdId !== undefined && !adopted) {
            const cleanup = await closeUnadoptedSession(createdId, owner);
            if (cleanup !== undefined && alive.current) {
              push({ kind: 'error', text: t(`无法释放未采用的新会话：${cleanup}`, `Could not release the unused new session: ${cleanup}`) });
            }
          }
          finishSessionNavigation(lease);
        }
      })();
      return;
    }
    if (name === 'copy') {
      void (async () => {
        // 只复制记录中已落盘的最后一条回答，不复制尚未完成的流式片段。
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
        // 排版和写入由 Host 完成；这里仅根据当前工作目录解析用户提供的目标路径。
        const done = await client.request('session.export', { sessionId, path: resolve(argument) }).catch((error: unknown) => requestFailure(error, 'session_export_failed'));
        if ('code' in done) {
          push({ kind: 'error', text: t(`导出失败：${done.code}`, `Export failed: ${done.code}`) });
          return;
        }
        // 区分派生会话记录读取失败和目标文件已存在两种无法导出的情况。
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
      const token = pickerRequest.current;
      const own = sessionId;
      void (async () => {
        // 会话列表由 Host 扫描，TUI 不直接访问记录目录。
        const listed = await client.request('sessions.list', { projectRoot: info.boundary }).catch((error: unknown) => requestFailure(error, 'session_list_failed'));
        if (!alive.current || activeSession.current !== own || pickerRequest.current !== token) return;
        if ('code' in listed) {
          push({ kind: 'error', text: t(`无法读取会话列表：${listed.code}`, `Could not list sessions: ${listed.code}`) });
          return;
        }
        if (listed.sessions.length === 0) push({ kind: 'meta', text: t('此工作区暂无会话', 'No sessions in this workspace') });
        else {
          setDetail(null);
          setExpanded(false);
          setSearch(null);
          setSessionPicker({ items: listed.sessions });
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
        // 搜索由 Host 扫描记录并返回会话和事件序号；TUI 不直接访问记录目录。
        // 搜索当前会话时读取溢出文件中的完整内容，跨会话搜索只检查记录内的文本。
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
      const lease = beginSessionNavigation(sessionId);
      if (lease === undefined) return;
      const owner = lease.owner;
      const wasExternal = externalControl;
      // 第二个词指定恢复会话时使用的模式；模式摘要变化时，用户必须明确选择模式才能继续。
      const [wanted, chosenMode] = argument.split(/\s+/);
      void (async () => {
        let targetId: string | undefined;
        let targetOpenedHere = false;
        let targetAdopted = false;
        try {
          const listed = await client.request('sessions.list', { projectRoot: info.boundary })
            .catch((error: unknown) => requestFailure(error, 'session_list_failed'));
          if (!sessionNavigationIsCurrent(lease)) return;
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
          targetId = picked.id;
          if (picked.id === owner && chosenMode === undefined) {
            setSessionPicker(null);
            push({ kind: 'meta', text: t('已打开此会话', 'This session is already open') });
            return;
          }
          // 外控 Host 持有写锁时读取其持久化记录，不抢锁创建第二个写入者。
          const opened = await client.request('session.open', {
            sessionId: picked.id,
            projectRoot: info.boundary ?? '',
            ...(chosenMode === undefined ? {} : { mode: chosenMode }),
          }).catch((error: unknown) => requestFailure(error, 'session_open_failed'));
          targetOpenedHere = !('code' in opened);
          if (!sessionNavigationIsCurrent(lease)) return;

          let observingExternal = false;
          let read: SessionPage & { readonly writerActive?: boolean } | { readonly code: string };
          if ('code' in opened && opened.code === 'session_locked' && chosenMode === undefined) {
            read = await client.request('session.observe', { projectRoot: info.boundary ?? '', sessionId: picked.id })
              .catch((error: unknown) => requestFailure(error, 'session_observe_failed'));
            if (!sessionNavigationIsCurrent(lease)) return;
            observingExternal = !('code' in read) && read.writerActive === true;
            if (!observingExternal) read = { code: 'session_writer_unavailable' };
          } else if ('code' in opened) {
            read = opened;
          } else {
            read = await client.request('session.read', { sessionId: picked.id })
              .catch((error: unknown) => requestFailure(error, 'session_read_failed'));
          }
          if (!sessionNavigationIsCurrent(lease)) return;
          if ('code' in read) {
            push({ kind: 'error', text: t(`无法恢复会话：${read.code}`, `Could not resume session: ${read.code}`)
              + (read.code === 'resume_mode_changed' ? t(`；请指定工具模式：/resume ${wanted} <模式名>`, `; specify a tool mode: /resume ${wanted} <mode>`) : '')
              + (read.code === 'session_is_branch' ? t('；请用 /sub <序号> 查看子任务', '; use /sub <seq> to view the subtask') : '') });
            return;
          }
          if (!wasExternal && picked.id !== owner) {
            const retired = await client.request('session.close', { sessionId: owner })
              .catch((error: unknown) => requestFailure(error, 'session_close_failed'));
            if ('code' in retired) {
              push({ kind: 'error', text: t(`无法关闭上一会话，已保留当前会话：${retired.code}`, `Could not close the previous session; keeping it active: ${retired.code}`) });
              return;
            }
          }
          // Closing the previous session is the commit point. Apply the new session state without another await.
          if (!alive.current || activeSession.current !== owner) return;
          targetAdopted = true;
          setSessionId(picked.id);
          setExternalControl(observingExternal);
          setExternalSnapshot(null);
          setExternalModel(observingExternal ? externalModelFrom(read.events) : null);
          setRunning(false);
          setStatus(picked.id === owner ? status : null);
          setAsk(null);
          setQuery(null);
          setSessionPicker(null);
          setRows(read.events.flatMap((event) => projectRecord(event, locale).map((row) => ({ ...row, seq: event.seq }))));
          setLive({ text: '', reasoning: '' });
          setDetail(null);
          const row = listed.sessions.find((item) => item.id === picked.id);
          if (picked.id === owner) void refreshStatus();
          push({
            kind: 'meta',
            text: t(`已恢复会话 ${picked.id.slice(0, 8)}`, `Resumed session ${picked.id.slice(0, 8)}`)
              + (row === undefined || row.unanswered === 0 ? '' : t(`；已修复 ${row.unanswered} 条未完成调用`, `; repaired ${row.unanswered} unresolved calls`)),
          });
        } catch (error) {
          if (sessionNavigationIsCurrent(lease)) {
            push({ kind: 'error', text: t(`无法恢复会话：${errorCode(error) ?? errorMessage(error) ?? 'session_resume_failed'}`, `Could not resume session: ${errorCode(error) ?? errorMessage(error) ?? 'session_resume_failed'}`) });
          }
        } finally {
          if (targetOpenedHere && !targetAdopted && targetId !== undefined) {
            const cleanup = await closeUnadoptedSession(targetId, owner);
            if (cleanup !== undefined && alive.current) {
              push({ kind: 'error', text: t(`无法释放未采用的会话 ${targetId.slice(0, 8)}：${cleanup}`, `Could not release unused session ${targetId.slice(0, 8)}: ${cleanup}`) });
            }
          }
          finishSessionNavigation(lease);
        }
      })();
      return;
    }
    if (name === 'takeover') {
      if (!externalControl) {
        push({ kind: 'meta', text: t('当前会话不由外部 Agent 控制', 'The current session is not externally controlled') });
        return;
      }
      const lease = beginSessionNavigation(sessionId);
      if (lease === undefined) return;
      const owner = lease.owner;
      void (async () => {
        let localSessionOpened = false;
        let adopted = false;
        let transferred = false;
        try {
          if (!sessionNavigationIsCurrent(lease)) return;
          const result = await client.request('session.control', {
            projectRoot: info.boundary ?? '', sessionId: owner, request: { action: 'takeover' },
          }).catch((error: unknown) => requestFailure(error, 'external_control_takeover_failed'));
          if ('code' in result) {
            if (sessionNavigationIsCurrent(lease)) {
              push({ kind: 'error', text: t(`无法接管外控会话：${result.code}`, `Could not take over external session: ${result.code}`) });
            }
            return;
          }
          // The control request has transferred ownership. Complete the local reopen even if
          // a pending external interaction invalidated the ordinary navigation generation.
          transferred = true;
          const opened = await client.request('session.open', { sessionId: owner, projectRoot: info.boundary ?? '' })
            .catch((error: unknown) => requestFailure(error, 'session_open_failed'));
          if ('code' in opened) {
            if (alive.current && activeSession.current === owner) {
              setExternalControl(false);
              setExternalSnapshot(null);
              setExternalModel(null);
              setRunning(false);
              setStatus(null);
              setAsk(null);
              setQuery(null);
              push({ kind: 'error', text: t(`外控已停止，但本地会话无法打开：${opened.code}；可用 /resume ${owner.slice(0, 8)} 重试`, `External control stopped, but the local session could not open: ${opened.code}; retry with /resume ${owner.slice(0, 8)}`) });
            }
            return;
          }
          localSessionOpened = true;
          if (!alive.current || activeSession.current !== owner) return;
          const read = await client.request('session.read', { sessionId: owner }).catch((error: unknown) => requestFailure(error, 'session_read_failed'));
          if (!alive.current || activeSession.current !== owner) return;
          setExternalControl(false);
          setExternalSnapshot(null);
          setExternalModel(null);
          setRunning(false);
          setStatus(null);
          setAsk(null);
          setQuery(null);
          setDetail(null);
          setSearch(null);
          setSessionPicker(null);
          if ('code' in read) {
            // This is still the active session and the local Host lock is now intentionally adopted.
            adopted = true;
            push({ kind: 'error', text: t(`已接管会话，但转录读取失败：${read.code}`, `Session taken over, but its transcript could not be read: ${read.code}`) });
            return;
          }
          adopted = true;
          setRows(read.events.flatMap((event) => projectRecord(event, locale).map((row) => ({ ...row, seq: event.seq }))));
          setLive({ text: '', reasoning: '' });
          push({ kind: 'meta', text: t('已接管外控会话，后续输入由 TUI 直接提交。', 'External session taken over; new input now runs through this TUI.') });
        } catch (error) {
          if (transferred && alive.current && activeSession.current === owner) {
            setExternalControl(false);
            setExternalSnapshot(null);
            setExternalModel(null);
            setRunning(false);
            setAsk(null);
            setQuery(null);
          }
          if (alive.current) {
            push({ kind: 'error', text: t(`接管外控会话失败：${errorCode(error) ?? errorMessage(error) ?? 'external_control_takeover_failed'}`, `Could not complete takeover: ${errorCode(error) ?? errorMessage(error) ?? 'external_control_takeover_failed'}`) });
          }
        } finally {
          if (localSessionOpened && !adopted) {
            const cleanup = await closeUnadoptedSession(owner, owner, true);
            if (cleanup !== undefined && alive.current) {
              push({ kind: 'error', text: t(`无法释放未采用的本地会话锁：${cleanup}`, `Could not release the unused local session lock: ${cleanup}`) });
            }
          }
          finishSessionNavigation(lease);
        }
      })();
      return;
    }
    if (name === 'branch') {
      // 不指定序号时复制整个会话；指定整数时从该已完成轮次创建分支。
      // 序号无效时明确报错，不猜测分支位置。
      const wanted = argument.trim();
      const at = wanted === '' ? undefined : Number(wanted);
      if (at !== undefined && !Number.isInteger(at)) {
        push({ kind: 'error', text: t('分支点须为完整轮次的记录序号：/branch [序号]', 'Branch point must be a completed turn’s sequence: /branch [seq]') });
        return;
      }
      const lease = beginSessionNavigation(sessionId);
      if (lease === undefined) return;
      const owner = lease.owner;
      void (async () => {
        try {
          const branched = await client.request('session.branch', { sessionId: owner, ...(at === undefined ? {} : { at }) }).catch((error: unknown) => requestFailure(error, 'session_branch_failed'));
          if (!sessionNavigationIsCurrent(lease)) return;
          if ('code' in branched) {
            push({ kind: 'error', text: t(`无法创建分支：${branched.code}`, `Could not create branch: ${branched.code}`) });
            return;
          }
          push({ kind: 'meta', text: t(`已创建分支会话 ${branched.sessionId.slice(0, 8)}（截至记录 ${branched.at}）`, `Created branch ${branched.sessionId.slice(0, 8)} through event ${branched.at}`) });
          // Branch records do not hold a session lock. Release this lease and immediately
          // start the serialized resume transaction for the new branch.
          finishSessionNavigation(lease);
          runCommand('resume', branched.sessionId);
        } finally {
          finishSessionNavigation(lease);
        }
      })();
      return;
    }
    if (name === 'bind') {
      // 只修改动作对应的按键，动作名称保持稳定；显示文本和实际按键行为共用同一配置。
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
      // 保存前校验按键绑定，拒绝同一作用范围内的冲突。
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
      // 队列由界面暂存；此命令只负责继续发送或将消息收回草稿，不修改会话记录。
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
      // 将收回的消息放回草稿，保留用户输入。
      // 命令已从草稿中移除，因此恢复后的草稿不会与命令文本拼接。
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
        const permission = current?.permission === undefined ? '' : t(
          ` · 权限 ${current.permission.profile} · 网络 ${current.permission.network} · Shell ${current.permission.execution.available ? '可用' : `不可用（${current.permission.execution.code ?? '能力不足'}）`}`,
          ` · permission ${current.permission.profile} · network ${current.permission.network} · Shell ${current.permission.execution.available ? 'available' : `unavailable (${current.permission.execution.code ?? 'capability limits'})`}`,
        );
        push({ kind: 'meta', text: current === null ? t('无法读取状态', 'Could not read status')
          : t(`工具模式 ${current.mode ?? '-'} · 审批 ${current.policy} · 连续拒绝 ${current.denials.consecutive} / 累计 ${current.denials.total} · ${current.eventCount} 条记录`, `Mode ${current.mode ?? '-'} · approvals ${current.policy} · denials ${current.denials.consecutive} consecutive / ${current.denials.total} total · ${current.eventCount} events`)
            + permission + (context === '' ? '' : ` · ${context}`) });
      })();
      return;
    }
    if (name === 'name' || name === 'archive' || name === 'unarchive') {
      // 会话名称和归档状态由 Host 写入记录，TUI 不维护第二份副本。
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
        // Host 负责调用模型生成摘要并写入检查点；TUI 显示成功或无法压缩的原因。
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
        if (asked !== 'default' && asked !== 'ask' && asked !== 'auto' && asked !== 'none') {
          push({ kind: 'error', text: t('用法：/policy ask|auto|none|reset', 'Usage: /policy ask|auto|none|reset') });
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
    if (name === 'permission') {
      const [target, value, ...extra] = argument.trim().split(/\s+/).filter((part) => part !== '');
      if (target === undefined) { openPicker('permission'); return; }
      if (extra.length > 0) {
        push({ kind: 'error', text: t('用法：/permission [read-only|workspace-write|full-access|network [policy|disabled|unrestricted]]', 'Usage: /permission [read-only|workspace-write|full-access|network [policy|disabled|unrestricted]]') });
        return;
      }
      if (target === 'network') {
        if (value === undefined) { openPicker('permission-network'); return; }
        if (value !== 'policy' && value !== 'disabled' && value !== 'unrestricted') {
          push({ kind: 'error', text: t('网络选项须为 policy、disabled 或 unrestricted。', 'Network must be policy, disabled, or unrestricted.') });
        } else if (value === 'unrestricted') {
          openPicker('permission-confirm-network');
        } else {
          void changePermission({ network: value });
        }
        return;
      }
      if (target !== 'read-only' && target !== 'workspace-write' && target !== 'full-access') {
        push({ kind: 'error', text: t('用法：/permission [read-only|workspace-write|full-access|network [policy|disabled|unrestricted]]', 'Usage: /permission [read-only|workspace-write|full-access|network [policy|disabled|unrestricted]]') });
        return;
      }
      if (target === 'full-access') {
        if (status?.permission?.profile === 'full-access') void changePermission({ profile: target });
        else openPicker('permission-confirm-full');
      } else if (target === 'workspace-write' && status?.permission !== undefined
        && (!status.permission.workspaceTrusted || status.permission.partialWorkspaceWriteConfirmationRequired
          && !status.permission.partialWorkspaceWriteConfirmed)) {
        openPicker('permission-confirm-partial');
      } else {
        void changePermission({ profile: target });
      }
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
        // 派生会话通过相同的记录读取接口读取；它没有当前运行时状态。
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
  }, [app, beginSessionNavigation, changePermission, client, closeUnadoptedSession, externalControl, finishSessionNavigation, info, keyOverrides, keys, locale, mcpTrustPending, push, queue, queuePaused, refreshStatus, sessionId, sessionNavigationIsCurrent, status, stdout, t, trust, openPicker, exitTui]);

  const chooseOption = useCallback((id: string) => {
    const choice = choices.find(item => item.id === id);
    if (choice === undefined || panel === null || panel === 'help') return;
    const currentPanel = panel;
    closePanel();
    if (currentPanel === 'control') {
      if (id === 'create') {
        runCommand('control', 'create');
        return;
      }
      if (id.startsWith('grant:')) {
        const target = controlTargetFromChoice(id, controlTarget);
        setControlTarget(target);
        openPicker('control-action', target ?? undefined);
      }
      return;
    }
    if (currentPanel === 'control-action') {
      if (id === 'back') { openPicker('control'); return; }
      const grant = controlSnapshot?.grants.find((item) => item.id === controlTarget);
      if (grant === undefined) { push({ kind: 'error', text: t('授权已不存在，请重新读取。', 'Grant is no longer available. Reload the list.') }); return; }
      if (id === 'copy-config') {
        void copyToClipboard(agentMcpConfig(grant)).then((copied) => push('program' in copied
          ? { kind: 'meta', text: t(`已复制授权 ${grant.id} 的本地 MCP 配置`, `Copied local MCP configuration for grant ${grant.id}`) }
          : { kind: 'error', text: t(`复制失败：${copied.code}`, `Copy failed: ${copied.code}`) }));
      } else if (id === 'revoke') openPicker('control-revoke-confirm');
      return;
    }
    if (currentPanel === 'control-revoke-confirm') {
      if (id !== 'confirm') return;
      const target = controlTarget;
      const version = controlSnapshot?.version;
      if (target === null || version === undefined) { push({ kind: 'error', text: t('无法确认授权版本，请重新读取。', 'Grant version is unavailable. Reload the list.') }); return; }
      void client.request('agent-control.revoke', { grantId: target, version }).then((result) => {
        const updated = result as AgentControlSnapshot;
        setControlSnapshot(updated);
        push({ kind: 'meta', text: t(`授权 ${target} 已撤销。`, `Grant ${target} revoked.`) });
      }, async (error: unknown) => {
        push({ kind: 'error', text: t(`撤销失败：${errorCode(error) ?? 'agent_control_revoke_failed'}`, `Could not revoke grant: ${errorCode(error) ?? 'agent_control_revoke_failed'}`) });
        const refreshed = await client.request('agent-control.list', {}).catch(() => null) as AgentControlSnapshot | null;
        if (refreshed !== null) setControlSnapshot(refreshed);
      });
      return;
    }
    if (currentPanel === 'permission') {
      if (id === 'network') { openPicker('permission-network'); return; }
      if (id === 'full-access') { openPicker('permission-confirm-full'); return; }
      if (id === 'workspace-write' && status?.permission !== undefined
        && (!status.permission.workspaceTrusted || status.permission.partialWorkspaceWriteConfirmationRequired
          && !status.permission.partialWorkspaceWriteConfirmed)) { openPicker('permission-confirm-partial'); return; }
      if (id === 'read-only' || id === 'workspace-write') void changePermission({ profile: id });
      return;
    }
    if (currentPanel === 'permission-network') {
      if (id === 'unrestricted') { openPicker('permission-confirm-network'); return; }
      if (id === 'policy' || id === 'disabled') void changePermission({ network: id });
      return;
    }
    if (currentPanel === 'permission-confirm-full') {
      if (id === 'confirm') void changePermission({ profile: 'full-access', confirmFullAccess: true });
      return;
    }
    if (currentPanel === 'permission-confirm-partial') {
      if (id === 'confirm') void changePermission({ profile: 'workspace-write', confirmPartialWorkspaceWrite: true, confirmWorkspaceTrust: true });
      return;
    }
    if (currentPanel === 'permission-confirm-network') {
      if (id === 'confirm') void changePermission({ network: 'unrestricted', confirmNetwork: true });
      return;
    }
    if (choice.selection === undefined) {
      runCommand(currentPanel, choice.id);
      return;
    }
    const own = sessionId;
    void client.request('model.select', { sessionId, ...choice.selection }).then(async changed => {
      if (activeSession.current !== own) return;
      await refreshStatus();
      push({ kind: 'meta', text: changed.when === 'round' ? t(`下轮使用 ${changed.model}`, `${changed.model} will apply next turn`) : t(`已切换至 ${changed.model}`, `Switched to ${changed.model}`) });
    }, (error: unknown) => push({ kind: 'error', text: t(`无法选择模型：${errorCode(error) ?? 'model_select_failed'}`, `Could not select model: ${errorCode(error) ?? 'model_select_failed'}`) }));
  }, [choices, panel, closePanel, openPicker, changePermission, runCommand, client, sessionId, refreshStatus, push, t, info.boundary, controlSnapshot, controlTarget]);

  const loadApprovalDetails = useCallback(async () => {
    const current = ask;
    const requestId = current?.detailsRef ?? current?.id;
    if (current === null || requestId === undefined || current.detailsLoaded === true || current.detailsLoading === true) return;
    setAsk({ ...current, detailsLoading: true, detailsError: undefined });
    try {
      const result = current.external
        ? await client.request('session.control', {
            projectRoot: info.boundary ?? '', sessionId,
            request: { action: 'details', requestId },
          }) as unknown as { args?: unknown }
        : await client.request('approval.details', { sessionId, requestId });
      if (!isRecord(result.args)) throw new Error('approval_details_invalid');
      const args = result.args;
      const tool = current.tool;
      setAsk((latest) => latest?.id === current.id ? {
        ...latest,
        detail: typeof args.command === 'string' ? args.command : typeof args.path === 'string' ? args.path : latest.detail,
        change: changeSummary(tool, args, locale),
        content: `${current.detailsSummary === '' ? '' : `${current.detailsSummary}\n\n`}${approvalBody(tool, args, locale)}${current.detailSuffix ?? ''}`,
        detailsLoading: false,
        detailsLoaded: true,
      } : latest);
    } catch (error) {
      setAsk((latest) => latest?.id === current.id ? { ...latest, detailsLoading: false, detailsError: errorCode(error) ?? 'approval_details_failed' } : latest);
    }
  }, [ask, client, info.boundary, locale, sessionId]);

  // 每次回车提交当前问题并进入下一题；完成最后一题后统一发送全部答案。
  // 空回车表示未回答该题，由 Host 按未答记录，不由界面补造答案。
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
    push({ kind: 'meta', text: head.external
      ? t(`已提交 ${answers.length}/${head.questions.length} 个回答（外控会话）`, `Submitted ${answers.length}/${head.questions.length} answers to the external session`)
      : t(`已提交 ${answers.length}/${head.questions.length} 个回答`, `Submitted ${answers.length}/${head.questions.length} answers`) });
    if (head.external) {
      resolvedExternalInteractions.current.add(head.id);
      void client.request('session.control', {
        projectRoot: info.boundary ?? '',
        sessionId,
        request: { action: 'reply', requestId: head.id, type: 'question', answers },
      }).catch((error: unknown) => {
        resolvedExternalInteractions.current.delete(head.id);
        push({ kind: 'error', text: t(`外控答复失败：${errorCode(error) ?? 'external_control_reply_failed'}`, `Could not submit external answer: ${errorCode(error) ?? 'external_control_reply_failed'}`) });
      });
    } else client.reply(head.id, { answers });
  }, [client, externalControl, info.boundary, push, query, resetDraft, sessionId, t]);

  const advanceControlWizard = useCallback(async (raw: string) => {
    const wizard = controlWizard;
    if (wizard === null) return false;
    const input = raw.trim();
    if (input.toLowerCase() === 'cancel' || input.toLowerCase() === '/cancel') {
      setControlWizard(null);
      resetDraft('');
      push({ kind: 'meta', text: t('已取消外控授权创建。', 'Agent Control grant creation cancelled.') });
      return true;
    }
    const values: ControlWizardValues = { ...wizard.values };
    const fail = (message: string) => push({ kind: 'error', text: message });
    if (wizard.step === 0) {
      if (input === '' || input.length > 80) { fail(t('名称须为 1 到 80 个字符。', 'Name must contain 1 to 80 characters.')); return true; }
      values.name = input;
    } else if (wizard.step === 1 || wizard.step === 2) {
      if (!['read-only', 'workspace-write', 'full-access'].includes(input)) {
        fail(t('请输入 read-only、workspace-write 或 full-access。', 'Enter read-only, workspace-write, or full-access.')); return true;
      }
      if (wizard.step === 1) values.defaultPermissionProfile = input as AgentGrant['defaultPermissionProfile'];
      else {
        const max = input as AgentGrant['maxPermissionProfile'];
        const rank = { 'read-only': 0, 'workspace-write': 1, 'full-access': 2 };
        if (values.defaultPermissionProfile !== undefined && rank[max] < rank[values.defaultPermissionProfile]) {
          fail(t('权限上限不能低于默认权限。', 'The permission ceiling cannot be lower than its default.')); return true;
        }
        values.maxPermissionProfile = max;
      }
    } else if (wizard.step === 3 || wizard.step === 4) {
      if (!['disabled', 'policy', 'unrestricted'].includes(input)) {
        fail(t('请输入 disabled、policy 或 unrestricted。', 'Enter disabled, policy, or unrestricted.')); return true;
      }
      if (wizard.step === 3) values.defaultNetwork = input as AgentGrant['defaultNetwork'];
      else {
        const max = input as AgentGrant['maxNetwork'];
        const rank = { disabled: 0, policy: 1, unrestricted: 2 };
        if (values.defaultNetwork !== undefined && rank[max] < rank[values.defaultNetwork]) {
          fail(t('网络上限不能低于默认网络范围。', 'The network ceiling cannot be lower than its default.')); return true;
        }
        values.maxNetwork = max;
      }
    } else if (wizard.step === 5) {
      if (!['ask', 'auto', 'none'].includes(input)) { fail(t('请输入 ask、auto 或 none。', 'Enter ask, auto, or none.')); return true; }
      values.defaultPolicy = input as PolicySelection;
    } else if (wizard.step === 6) {
      const allowed = input.split(',').map((part) => part.trim()).filter(Boolean);
      if (allowed.length === 0 || allowed.some((part) => !['ask', 'auto', 'none'].includes(part))
        || new Set(allowed).size !== allowed.length || !allowed.includes(values.defaultPolicy ?? 'ask')) {
        fail(t('请输入不重复的 Policy 列表，例如 ask,none，并包含默认 Policy。', 'Enter distinct Policy modes such as ask,none, including the default.')); return true;
      }
      values.allowedPolicies = allowed as PolicySelection[];
    } else if (wizard.step === 7) {
      if (!['y', 'yes', 'n', 'no'].includes(input.toLowerCase())) { fail(t('请输入 yes 或 no。', 'Enter yes or no.')); return true; }
      values.allowOperator = ['y', 'yes'].includes(input.toLowerCase());
    } else if (wizard.step === 8) {
      const allowed = input === '' || input.toLowerCase() === 'none' ? [] : input.split(',').map((part) => part.trim()).filter(Boolean);
      if (new Set(allowed).size !== allowed.length || allowed.some((server) => !wizard.mcpServers.includes(server))) {
        fail(t(`请输入已信任的 Server 名称列表：${wizard.mcpServers.join(', ') || 'none'}。`, `Enter a list of trusted server names: ${wizard.mcpServers.join(', ') || 'none'}.`)); return true;
      }
      values.allowedMcpServers = allowed;
      let tools: string[] = [];
      if (allowed.length > 0) {
        try {
          const listed = await Promise.all(allowed.map((server) => client.request('mcp.trust.tools', {
            projectRoot: info.boundary ?? '', server,
          })));
          tools = listed.flatMap((entry) => entry.tools.map((tool) => `mcp:${entry.server}/${tool.name}`));
        } catch (error) {
          fail(t(`读取 MCP 工具失败：${errorCode(error) ?? 'mcp_tool_list_failed'}`, `Could not list MCP tools: ${errorCode(error) ?? 'mcp_tool_list_failed'}`)); return true;
        }
      }
      values.allowedMcpTools = [];
      resetDraft('');
      setControlWizard({ step: 9, values, mcpServers: wizard.mcpServers, mcpTools: tools });
      push({ kind: 'meta', text: t(
        `可授权的 MCP 工具：${tools.join(', ') || '无'}。输入完整能力名列表，或 none。`,
        `MCP tools available to grant: ${tools.join(', ') || 'none'}. Enter exact capability names or none.`,
      ) });
      return true;
    } else if (wizard.step === 9) {
      const allowed = input === '' || input.toLowerCase() === 'none' ? [] : input.split(',').map((part) => part.trim()).filter(Boolean);
      if (new Set(allowed).size !== allowed.length || allowed.some((tool) => !wizard.mcpTools.includes(tool))) {
        fail(t(`请输入可授权清单中的完整能力名：${wizard.mcpTools.join(', ') || 'none'}。`, `Enter exact capability names from the available list: ${wizard.mcpTools.join(', ') || 'none'}.`)); return true;
      }
      values.allowedMcpTools = allowed;
    } else if (wizard.step === 10) {
      if (input === '' || input.toLowerCase() === 'none') values.expiresAt = null;
      else {
        const expiry = input.length === 10 ? Date.parse(`${input}T23:59:59`) : Date.parse(input);
        if (!Number.isFinite(expiry) || expiry <= Date.now()) { fail(t('请输入未来的日期/时间或 none。', 'Enter a future date/time or none.')); return true; }
        values.expiresAt = new Date(expiry).toISOString();
      }
    } else if (wizard.step === 11) {
      if (!['y', 'yes'].includes(input.toLowerCase())) {
        setControlWizard(null); resetDraft('');
        fail(t('未确认信任此项目，授权未创建。', 'Project trust was not confirmed; no grant was created.')); return true;
      }
      values.confirmWorkspaceTrust = true;
    } else if (wizard.step === 12) {
      if (!['y', 'yes'].includes(input.toLowerCase())) {
        setControlWizard(null); resetDraft('');
        fail(t('未确认工作区部分隔离限制，授权未创建。', 'Partial workspace-write limits were not confirmed; no grant was created.')); return true;
      }
      values.confirmPartialWorkspaceWrite = true;
    } else if (wizard.step === 13) {
      if (!['y', 'yes'].includes(input.toLowerCase())) {
        setControlWizard(null); resetDraft('');
        fail(t('未确认 full-access，授权未创建。', 'Full-access was not confirmed; no grant was created.')); return true;
      }
      values.confirmFullAccess = true;
    } else if (wizard.step === 14) {
      if (!['y', 'yes'].includes(input.toLowerCase())) {
        setControlWizard(null); resetDraft('');
        fail(t('未确认不受限网络，授权未创建。', 'Unrestricted network was not confirmed; no grant was created.')); return true;
      }
      values.confirmUnrestrictedNetwork = true;
    }
    resetDraft('');
    const next = controlWizardNext(wizard.step, values);
    if (next >= 0) {
      setControlWizard({ step: next, values, mcpServers: wizard.mcpServers, mcpTools: wizard.mcpTools });
      return true;
    }
    void (async () => {
      try {
        const projectRoot = info.boundary;
        if (projectRoot === undefined || projectRoot === '') throw new Error('workspace_required');
        const current = await client.request('agent-control.list', {}) as AgentControlSnapshot;
        const created = await client.request('agent-control.create', {
          version: current.version,
          grantName: values.name!,
          projectRoot,
          defaultPermissionProfile: values.defaultPermissionProfile!,
          maxPermissionProfile: values.maxPermissionProfile!,
          defaultNetwork: values.defaultNetwork!,
          maxNetwork: values.maxNetwork!,
          defaultPolicy: values.defaultPolicy!,
          allowedPolicyAsk: values.allowedPolicies!.includes('ask'),
          allowedPolicyAuto: values.allowedPolicies!.includes('auto'),
          allowedPolicyNone: values.allowedPolicies!.includes('none'),
          allowOperator: values.allowOperator!,
          allowedMcpServers: values.allowedMcpServers ?? [],
          allowedMcpTools: values.allowedMcpTools ?? [],
          confirmFullAccess: values.confirmFullAccess === true,
          confirmUnrestrictedNetwork: values.confirmUnrestrictedNetwork === true,
          confirmPartialWorkspaceWrite: values.confirmPartialWorkspaceWrite === true,
          confirmWorkspaceTrust: values.confirmWorkspaceTrust === true,
          expiresAt: values.expiresAt ?? '',
        }) as AgentControlSnapshot;
        setControlSnapshot(created);
        const grant = created.grants.at(-1);
        setControlWizard(null);
        push({ kind: 'meta', text: grant === undefined
          ? t('外控授权已创建。', 'Agent Control grant created.')
          : t(`外控授权 ${grant.name} 已创建：${grant.id} · /control copy ${grant.id.slice(0, 8)} 可复制 MCP 配置`, `Grant ${grant.name} created: ${grant.id} · use /control copy ${grant.id.slice(0, 8)} to copy the MCP config`) });
      } catch (error) {
        setControlWizard(null);
        push({ kind: 'error', text: t(`外控授权创建失败：${errorCode(error) ?? errorMessage(error) ?? 'agent_control_create_failed'}`, `Could not create Agent Control grant: ${errorCode(error) ?? errorMessage(error) ?? 'agent_control_create_failed'}`) });
      }
    })();
    return true;
  }, [client, controlWizard, info.boundary, push, resetDraft, t]);

  const send = useCallback((text: string) => {
    const route = routeInput(text, running);
    const answering = query !== null && !text.trim().startsWith('/');
    if (sessionNavigation.current.activeToken !== 0 && !answering && !(route.kind === 'command' && route.name === 'quit')) {
      push({ kind: 'meta', text: t('会话切换完成前不会提交输入，草稿已保留。', 'Input is held until the session switch completes; the draft is preserved.') });
      return;
    }
    if (controlWizard !== null) { advanceControlWizard(text); return; }
    // 问题面板打开时，回车提交当前答案；斜杠命令仍可运行，例如 `/status` 和 `/queue`。
    if (answering) {
      answerQuery(text);
      return;
    }
    if (route.kind === 'blocked') {
      push({ kind: 'meta', text: t(`请先按 ${keyHint('interrupt')} 停止当前轮次，再执行此命令`, `Stop this turn with ${keyHint('interrupt')} before using this command`) });
      return;
    }
    resetDraft('');
    setHistoryAt(-1);
    setPick(0);
    setDismissedAt(null);
    // 轮次运行期间的消息加入队列，结束后按顺序发送。
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
  }, [advanceControlWizard, answerQuery, controlWizard, loadApprovalDetails, locale, push, query, remember, runCommand, running, submit, t]);

  // 轮次结束后每次发送一条队列消息；取消后队列保持暂停，需用户明确继续。
  useEffect(() => {
    if (running || queuePaused || queue.length === 0) return;
    const [next, ...rest] = queue;
    setQueue(rest);
    void submit(next);
  }, [queue, queuePaused, running, submit]);

  // 审批面板和普通输入共用同一取消处理，统一暂停队列。
  const cancelRound = useCallback(() => {
    if (queue.length > 0) {
      setQueuePaused(true);
      push({ kind: 'meta', text: t(`队列已暂停：${queue.length} 条待发送，/queue continue 继续`, `Queue paused: ${queue.length} pending; /queue continue to resume`) });
    }
    const request = externalControl
      ? client.request('session.control', { projectRoot: info.boundary ?? '', sessionId, request: { action: 'cancel' } })
      : client.request('run.cancel', { sessionId });
    void request.catch((error) => push({ kind: 'error', text: errorCode(error) ?? 'run_cancel_failed' }));
  }, [client, externalControl, info.boundary, push, queue.length, sessionId, t]);

  // 候选由当前草稿计算，输入变化后自动更新。
  const templates = status?.templates ?? [];
  const picks = panel !== null || dismissedAt === draft || search !== null || detail !== null || sessionPicker !== null || ask !== null || query !== null ? [] : candidatesOf(draft, templates, undefined, locale);
  const chosen = picks.length === 0 ? 0 : Math.min(pick, picks.length - 1);
  const candidateHeight = Math.max(1, Math.min(CANDIDATE_ROWS, geometry.rows - 12));
  const pathHeight = Math.max(1, Math.min(MENTION_ROWS, geometry.rows - 10));
  const searched = search === null ? [] : searchHistory(entries, search.query);
  const viewLines = useMemo(() => detail === null ? [] : transcriptLines(detail.rows, Math.max(1, geometry.columns - 6), locale), [detail?.rows, geometry.columns, locale]);
  const viewHeight = Math.max(1, geometry.rows - 6 - (ask === null ? 0 : 7));
  const view = viewportPosition(detail?.cursor ?? 0, viewLines.length, viewHeight, detail?.offset ?? 0);
  const selection = detail?.anchor === undefined || detail.anchor === null ? [view.cursor, view.cursor] : [Math.min(detail.anchor, view.cursor), Math.max(detail.anchor, view.cursor)];
  const approvalLayout = useMemo(() => ask === null ? null : buildApprovalLayout(ask, approvalExpanded,
    geometry.columns, Math.max(1, geometry.rows - 1), locale), [ask, approvalExpanded, geometry.columns, geometry.rows, locale]);
  const approvalLines = approvalLayout?.bodyLines ?? [];
  const approvalHeight = approvalLayout?.bodyHeight ?? 0;
  const approvalView = viewportPosition(approvalCursor, approvalLines.length, approvalHeight);
  // 问题面板显示题目、已提交答案和当前题是否为最后一题。
  const asking = query === null ? null : {
    count: query.questions.length,
    current: query.questions[query.at],
    title: query.questions[query.at].header === undefined ? query.questions[query.at].question
      : `${query.questions[query.at].header} · ${query.questions[query.at].question}`,
    done: query.questions.slice(0, query.at).map((one, index) => `${index + 1}. ${answeredLine(query.picked[one.id]?.answer, locale)}`),
    last: query.at + 1 === query.questions.length,
  };
  const questionLines = asking === null ? [] : wrapLine([
    asking.title,
    ...asking.current.options.map((option, position) => `${position + 1}. ${option.label}${option.description === undefined ? '' : ` —— ${option.description}`}`),
    ...asking.done,
  ].join('\n'), Math.max(1, geometry.columns - 3));
  const composerHeight = Math.max(1, Math.min(query === null ? 5 : 3, geometry.rows - 10));
  const questionHeight = Math.max(1, geometry.rows - composerHeight - 6);
  const questionView = viewportPosition(questionCursor, questionLines.length, questionHeight);
  const controlPrompt = controlWizard === null ? null
    : controlWizard.step === 8
      ? t(`允许外控启动哪些已信任的 MCP Server？逗号分隔：${controlWizard.mcpServers.join(', ') || '无'}；输入 none 表示不允许。`, `Which trusted MCP servers may the controller start? Comma-separated: ${controlWizard.mcpServers.join(', ') || 'none'}; type none for no servers.`)
      : controlWizard.step === 9
        ? t(`允许外控调用哪些工具？逗号分隔完整能力名：${controlWizard.mcpTools.join(', ') || '无'}；输入 none 表示不允许。`, `Which tools may the controller call? Comma-separated exact capabilities: ${controlWizard.mcpTools.join(', ') || 'none'}; type none for no tools.`)
        : [
          t('授权名称（最多 80 字符）', 'Grant name (up to 80 characters)'),
          t('默认权限：read-only / workspace-write / full-access', 'Default permission: read-only / workspace-write / full-access'),
          t('最大权限：read-only / workspace-write / full-access', 'Maximum permission: read-only / workspace-write / full-access'),
          t('默认网络：disabled / policy / unrestricted', 'Default network: disabled / policy / unrestricted'),
          t('网络上限：disabled / policy / unrestricted', 'Maximum network: disabled / policy / unrestricted'),
          t('默认 Policy：ask / auto / none', 'Default Policy: ask / auto / none'),
          t('允许的 Policy，以逗号分隔，例如 ask,auto', 'Allowed Policy modes, comma-separated, e.g. ask,auto'),
          t('允许 --operator 处理普通审批和会话设置？yes / no', 'Allow --operator for ordinary approvals and session settings? yes / no'),
          '', '',
          t('到期时间，输入 ISO 时间或 none', 'Expiry time as an ISO date/time, or none'),
          t('确认信任此项目以供项目代码、Git 命令与 Hook 使用？yes / no', 'Trust this project for project code, Git commands, and hooks? yes / no'),
          t('接受 workspace-write 可能存在的部分隔离限制？yes / no', 'Accept possible partial workspace-write isolation limits? yes / no'),
          t('单独确认 full-access 授权？输入 yes 确认', 'Separately confirm the full-access ceiling? Type yes to confirm'),
          t('单独确认 unrestricted network？输入 yes 确认', 'Separately confirm the unrestricted network ceiling? Type yes to confirm'),
        ][controlWizard.step] ?? t('输入 yes 确认', 'Type yes to confirm');
  const externalControlLabel = externalSnapshot?.pendingInteractions.some((item) => item.type === 'approval') === true
    ? t('外控会话等待审批', 'External session is waiting for approval')
    : externalSnapshot?.pendingInteractions.some((item) => item.type === 'question') === true
      ? t('外控会话等待回答', 'External session is waiting for an answer')
      : externalSnapshot?.state === 'running' ? t('外控 Agent 正在运行', 'External agent is running')
        : t('外控会话已连接 · /takeover 接管', 'External session connected · /takeover to take over');

  useInput((input, key) => {
    if (hit('quit', input, key)) {
      exitTui();
      return;
    }
    if (panel !== null || sessionPicker !== null && ask === null && query === null) return;
    if (ask === null && query === null) {
      if (hit('model-picker', input, key)) { openPicker('model'); return; }
      if (hit('mode-picker', input, key)) { openPicker('mode'); return; }
      if (hit('policy-picker', input, key)) { openPicker('policy'); return; }
    }
    if (hit('expand-or-history', input, key)) {
      if (ask !== null) {
        const expanding = !approvalExpanded;
        setApprovalExpanded(expanding);
        if (expanding) void loadApprovalDetails();
      }
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
    if (ask !== null) {
      const target = hit('approval-top', input, key) ? 0 : hit('approval-bottom', input, key) ? approvalLines.length - 1
        : hit('approval-page-up', input, key) ? approvalView.cursor - approvalHeight : hit('approval-page-down', input, key) ? approvalView.cursor + approvalHeight
          : hit('approval-up', input, key) ? approvalView.cursor - 1 : hit('approval-down', input, key) ? approvalView.cursor + 1 : null;
      if (target !== null) { setApprovalCursor(target); return; }
    }
    if (ask !== null) {
      if (ask.rememberable && ask.rememberTargetOptions.includes('file') && ask.rememberTargetOptions.includes('workspace') && input.toLowerCase() === 'w') {
        setAsk({ ...ask, rememberTarget: ask.rememberTarget === 'workspace' ? 'file' : 'workspace' });
        return;
      }
      const option = /^\d$/u.test(input) ? Number(input) - 2 : -1;
      const rememberScope = ask.rememberable && option >= 0 ? ask.rememberScopes[option] : undefined;
      if (hit('approve', input, key) || ask.rememberable && input === '1' || rememberScope !== undefined) {
        if (approvalLayout?.canApprove !== true) return;
        const asked = ask;
        setAsk(null);
        const rememberedTarget = asked.rememberTarget ?? asked.rememberTargetOptions[0];
        const scopeLabel = rememberScope === 'session' ? t('并记住到本会话', 'and remembered for this session')
          : rememberScope === 'project' ? t('并记住到本项目', 'and remembered for this project')
            : rememberScope === 'user' ? t('并记住到所有项目', 'and remembered for all projects')
              : '';
        const chosenTargetLabel = asked.rememberHintKey === 'file'
          ? rememberedTarget === 'workspace' ? t('此工作区同类操作', 'this operation type in this workspace') : t('仅此文件', 'this file only')
          : asked.rememberHintKey === 'command' ? t('此命令', 'this command')
            : asked.rememberHintKey === 'mcp' ? t('此组 MCP 参数', 'these MCP arguments')
              : t('此工具能力', 'this tool capability');
        const targetLabel = rememberScope === undefined ? '' : ` · ${chosenTargetLabel}`;
        push({ kind: 'meta', text: t(`已允许 ${asked.tool} ${scopeLabel}${targetLabel}`, `Allowed ${asked.tool} ${scopeLabel}${targetLabel}`) });
        if (asked.external) {
          resolvedExternalInteractions.current.add(asked.id);
          void client.request('session.control', {
            projectRoot: info.boundary ?? '', sessionId,
            request: {
              action: 'reply', requestId: asked.id, type: 'approval', decision: 'allow',
              ...(rememberScope === undefined ? {} : { rememberScope }),
              ...(rememberScope === undefined || rememberedTarget === undefined ? {} : { rememberTarget: rememberedTarget }),
            },
          }).catch((error: unknown) => {
            resolvedExternalInteractions.current.delete(asked.id);
            push({ kind: 'error', text: t(`外控审批答复失败：${errorCode(error) ?? 'external_control_reply_failed'}`, `Could not approve external action: ${errorCode(error) ?? 'external_control_reply_failed'}`) });
          });
        }
        else client.reply(asked.id, {
          decision: 'allow',
          ...(rememberScope === undefined ? {} : { rememberScope }),
          ...(rememberScope === undefined || rememberedTarget === undefined ? {} : { rememberTarget: rememberedTarget }),
        });
      } else if (hit('deny', input, key)) {
        const asked = ask;
        setAsk(null);
        push({ kind: 'meta', text: t(`已拒绝 ${asked.tool}`, `Denied ${asked.tool}`) });
        if (asked.external) {
          resolvedExternalInteractions.current.add(asked.id);
          void client.request('session.control', {
            projectRoot: info.boundary ?? '', sessionId,
            request: { action: 'reply', requestId: asked.id, type: 'approval', decision: 'deny' },
          }).catch((error: unknown) => {
            resolvedExternalInteractions.current.delete(asked.id);
            push({ kind: 'error', text: t(`外控审批答复失败：${errorCode(error) ?? 'external_control_reply_failed'}`, `Could not deny external action: ${errorCode(error) ?? 'external_control_reply_failed'}`) });
          });
        }
        else client.reply(asked.id, { decision: 'deny' });
      }
      return;
    }
    if (query !== null && detail === null && search === null
      && (hit('question-page-up', input, key) || hit('question-page-down', input, key))) {
      setQuestionCursor(questionView.cursor + (hit('question-page-up', input, key) ? -questionHeight : questionHeight));
      return;
    }
    // 草稿为空时，左方向键返回上一题并恢复原答案供修改。
    // 草稿非空时保留普通光标移动行为。
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
      // Shift+左右方向键扩展选择范围，光标按对应方向移动。
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
    // Ctrl+G 使用外部编辑器修改草稿，并通过临时文件传递文本。
    // 由 Ink 暂停 raw mode 并恢复终端，避免编辑器与界面争用输入。
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
        const normalized = outcome.text.replace(/\r\n?/g, '\n');
        setDraft(normalized);
        setCaret(normalized.length);
      })();
      return;
    }
    if (hit('search-open', input, key) && search === null) {
      // 开始反向搜索，查询文本初始为空，后续输入逐字符追加。
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
        // 查询文本为空时按退格退出搜索，而不是删除内容。
        setSearch(search.query === '' ? null : { query: search.query.slice(0, -1), at: 0 });
        return;
      }
      if (input !== '' && !key.ctrl && !key.meta) {
        setSearch({ query: search.query + input, at: 0 });
      }
      return;
    }
    // 路径候选打开且有结果时，Enter 用于选择，不发送消息。
    // 没有候选时 Enter 仍发送当前输入。
    if (mention !== null && ask === null && query === null && detail === null && sessionPicker === null && search === null) {
      if (hit('path-close', input, key)) {
        setHiddenMention(mention.text);
        setMention(null);
        return;
      }
      const picking = hit('pick-path', input, key) || hit('pick-path-alt', input, key);
      // 候选查询未完成时，Enter 不选择旧结果，也不发送消息。
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
        // 命令有参数提示时，补全后追加空格并将光标留在参数位置。
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
        setCaret(moveDraftCaret(draft, caret, up ? 'up' : 'down'));
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
      // 撤销和重做使用独立历史栈，允许恢复已撤销的草稿内容。
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
      // 草稿为空时按退格，将队列最后一条收回草稿供修改。
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
      // 问题面板打开时，空回车表示跳过当前题；普通输入状态下不发送空消息。
      if (draft.trim() !== '' || query !== null) send(draft);
      return;
    }
    const edited = editDraft(draft, caret, input.replace(/\r\n?/g, '\n'), key);
    setDraft(edited.draft);
    setCaret(edited.caret);
  // 仅在交互式终端中启动 Ink；非交互终端使用命令行模式。
  }, { isActive: interactive });

  // 通过 Ink 的 bracketed paste 通道一次接收整段粘贴内容，不将换行解释为发送或审批按键。
  usePaste((text) => {
    if (panel !== null || sessionPicker !== null || ask !== null || detail !== null) return;
    if (search !== null) {
      setSearch({ query: search.query + text.replace(/[\r\n\t]+/gu, ' '), at: 0 });
      return;
    }
    const inserted = editDraft(draft, caret, text.replace(/\r\n?/g, '\n'), {});
    setDraft(inserted.draft);
    setCaret(inserted.caret);
  }, { isActive: interactive });

  const shownModel = externalControl ? externalModel : status?.model ?? info.model;
  const foldedLive = foldText(live.reasoning, expanded, 1);
  const showComposer = ask === null && detail === null && panel === null && sessionPicker === null && search === null;
  const showSettings = showComposer && query === null && controlWizard === null && picks.length === 0 && mention === null;

  return h(Fragment, null,
    // 会话切换时用会话 ID 重建静态转录，避免新记录短于旧记录时沿用旧行索引。
    h(Static<TranscriptItem>, { key: sessionId, items: sessionId === firstSessionId ? [{ kind: 'welcome', text: '' }, ...rows] : rows, children: (row, index) => row.kind === 'welcome'
      ? h(Welcome, { key: index, version: VERSION, boundary: titleText({ boundary: info.boundary, sessionId: '' }), columns: geometry.columns, locale })
      : h(Box, { key: index, flexDirection: 'column' }, h(Row, { row, expanded: false, columns: geometry.columns, locale })) }),
    !showComposer || foldedLive.shown === '' ? null : h(Text, { color: TUI_COLORS.muted, wrap: 'truncate-end' }, t(`· 推理 ${foldedLive.shown}${foldedLive.hidden > 0 ? ` …还有 ${foldedLive.hidden} 字` : ''}`, `· Reasoning ${foldedLive.shown}${foldedLive.hidden > 0 ? ` …${foldedLive.hidden} more characters` : ''}`)),
    live.text === '' || !showSettings ? null : h(MarkdownRows, { text: live.text, columns: geometry.columns }),
    approvalLayout === null ? null : h(ApprovalPanel, { layout: approvalLayout, cursor: approvalCursor }),
    asking === null || query === null || ask !== null || panel !== null || detail !== null || sessionPicker !== null || search !== null ? null : h(PanelFrame, { tone: 'info', width: geometry.columns },
      h(Text, { bold: true }, t(`等待回答 ${query.at + 1}/${asking.count}`, `Waiting for your answer ${query.at + 1}/${asking.count}`)),
      ...questionLines.slice(questionView.offset, questionView.offset + questionHeight).map((line, index) => h(Text, { key: questionView.offset + index, wrap: 'truncate-end' }, line)),
      questionLines.length <= questionHeight ? null : h(Text, { color: TUI_COLORS.muted, wrap: 'truncate-end' }, `${questionView.cursor + 1}/${questionLines.length} · ${keyHint('question-page-up', 'question-page-down')}`),
      h(Text, { wrap: 'truncate-end' }, `${optionHint(asking.current, locale)} · ${asking.last ? t('Enter 提交', 'Enter to submit') : t('Enter 下一题', 'Enter for next question')}`),
      h(Text, { dimColor: true, wrap: 'truncate-end' }, t(`  ${asking.done.length > 0 ? `${keyHint('question-back')} 上一题 · ` : ''}${keyHint('interrupt')} 取消本轮 · 没有回答时限`, `  ${asking.done.length > 0 ? `${keyHint('question-back')} previous · ` : ''}${keyHint('interrupt')} cancel turn · no answer timeout`))),
    detail === null || ask !== null || panel !== null ? null : h(PanelFrame, { width: geometry.columns },
      h(Text, { dimColor: true, wrap: 'truncate-end' }, detail.kind === 'transcript' ? t('完整历史', 'Transcript') : detailTitle(detail, locale)),
      viewLines.length === 0
        ? h(Text, { dimColor: true }, detail.loading ? t('正在读取记录…', 'Loading transcript…') : t('没有可显示的内容', 'No content to display'))
        : viewLines.slice(view.offset, view.offset + viewHeight).map((line, index) => h(Text, { key: view.offset + index, inverse: view.offset + index >= selection[0] && view.offset + index <= selection[1], wrap: 'truncate-end' }, line)),
      h(Text, { dimColor: true, wrap: 'truncate-end' }, t(`${view.cursor + 1}/${viewLines.length} 行 · ${keyHint('view-page-up', 'view-page-down')} 分页 · ${keyHint('view-top', 'view-bottom')} 到两端 · ${keyHint('mark-up', 'mark-down')} 选择 · ${keyHint('copy-selection')} 复制 · ${keyHint('view-close')} 收起`, `Line ${view.cursor + 1}/${viewLines.length} · ${keyHint('view-page-up', 'view-page-down')} pages · ${keyHint('view-top', 'view-bottom')} start/end · ${keyHint('mark-up', 'mark-down')} select · ${keyHint('copy-selection')} copy · ${keyHint('view-close')} close`))),
    h(SessionPicker, {
      active: sessionPicker !== null && ask === null && query === null,
      items: sessionPicker?.items ?? [], current: sessionId, locale, height: viewHeight, columns: geometry.columns,
      running, interactive, onClose: () => setSessionPicker(null), onSelect: (id) => runCommand('resume', id),
    }),
    queue.length === 0 || !showSettings ? null : h(Text, { color: TUI_COLORS.muted, wrap: 'truncate-end' }, queuePaused
      ? t(`队列已暂停：${queue.length} 条 · /queue continue 继续 · /queue list 查看`, `Queue paused: ${queue.length} · /queue continue to resume · /queue list to view`)
      : t(`排队 ${queue.length} 条 · 空草稿按退格收回最后一条 · /queue list 查看`, `${queue.length} queued · Backspace on empty draft recalls last · /queue list to view`)),
    search === null || ask !== null || panel !== null ? null : h(PanelFrame, { width: geometry.columns },
      h(Text, { wrap: 'truncate-end' }, t(`历史搜索 ${search.query}`, `History search ${search.query}`)),
      searched.length === 0
        ? h(Text, { dimColor: true }, entries.length === 0 ? t('暂无输入历史', 'No input history') : t(`没有匹配“${search.query}”的输入`, `No input matches “${search.query}”`))
        : searched.map((entry, index) => h(Box, { key: `${index}:${entry}` },
            h(Text, { inverse: index === search.at, wrap: 'truncate-end' }, ` ${queuedLine(entry, 60)}`))),
      h(Text, { color: TUI_COLORS.muted, wrap: 'truncate-end' }, t(`继续输入筛选 · ${keyHint('search-up', 'search-down')} 选择 · ${keyHint('search-pick')} 恢复 · ${keyHint('search-close')} 退出`, `Type to filter · ${keyHint('search-up', 'search-down')} select · ${keyHint('search-pick')} restore · ${keyHint('search-close')} close`))),
    picks.length === 0 ? null : h(PanelFrame, { width: geometry.columns },
      picks.slice(Math.max(0, chosen - candidateHeight + 1), Math.max(0, chosen - candidateHeight + 1) + candidateHeight).map((candidate) => h(Text, { key: `${candidate.source}:${candidate.name}`, wrap: 'truncate-end' },
        h(Text, { inverse: candidate === picks[chosen] }, ` /${candidate.name}${candidate.hint === '' ? '' : ` ${candidate.hint}`}`),
        h(Text, { dimColor: true }, ` ${candidate.text}`))),
      h(Text, { dimColor: true }, t(`  ${chosen + 1}/${picks.length} · 继续输入名称或说明以筛选`, `  ${chosen + 1}/${picks.length} · type a name or description to filter`)),
      h(Text, { dimColor: true }, t(` ${keyHint('complete')} 补全 · ${keyHint('complete-up', 'complete-down')} 选择 · ${keyHint('complete-close')} 收起`, ` ${keyHint('complete')} complete · ${keyHint('complete-up', 'complete-down')} select · ${keyHint('complete-close')} close`))),
    mention === null ? null : h(PanelFrame, { width: geometry.columns },
      h(Text, { dimColor: true, wrap: 'truncate-end' }, t(` 工作区 ${info.boundary}`, ` Workspace ${info.boundary}`)),
      mention.paths.length === 0
        ? h(Text, { dimColor: true }, mention.stopped === 'error'
          ? t(`无法列出文件：${mention.failed}`, `Could not list files: ${mention.failed}`)
          : mention.stopped === 'pending'
            ? t('正在查找文件…', 'Finding files…')
            : mention.stopped === 'budget'
              ? t('搜索已到遍历上限，请输入更具体的路径', 'Search limit reached; enter a more specific path')
              : t(`没有匹配“${mention.text}”的文件`, `No files match “${mention.text}”`))
        : mention.paths.slice(Math.max(0, mention.chosen - pathHeight + 1), Math.max(0, mention.chosen - pathHeight + 1) + pathHeight)
          .map((path) => h(Text, { key: path, inverse: path === mention.paths[mention.chosen], wrap: 'truncate-end' }, ` ${path}`)),
      mention.paths.length > 0 && mention.stopped === 'budget'
        ? h(Text, { dimColor: true }, t('  列表不完整，请输入更具体的路径', '  List is incomplete; enter a more specific path')) : null,
      mention.paths.length > 0 && mention.stopped === 'unreadable'
        ? h(Text, { dimColor: true }, t('  有目录无法读取，列表不完整', '  Some directories are unreadable; list is incomplete')) : null,
      mention.paths.length === 0 ? null : h(Text, { dimColor: true }, t(` ${keyHint('pick-path', 'pick-path-alt')} 选中 · ${keyHint('path-up', 'path-down')} 选择 · ${keyHint('path-close')} 收起`, ` ${keyHint('pick-path', 'pick-path-alt')} insert · ${keyHint('path-up', 'path-down')} select · ${keyHint('path-close')} close`))),
    h(HelpPanel, { active: panel === 'help', interactive, templates, locale, columns: geometry.columns, height: Math.max(1, geometry.rows - 8), onClose: closePanel }),
    h(ChoicePanel, {
      active: panel !== null && panel !== 'help', interactive,
      title: panel === 'model' ? t('选择模型', 'Select model')
        : panel === 'mode' ? t('选择工具模式', 'Select tool mode')
          : panel === 'policy' ? t('选择审批方式', 'Select approval mode')
            : panel === 'permission' ? t('会话权限', 'Session permissions')
              : panel === 'permission-network' ? t('设置网络权限', 'Set network access')
                : panel === 'permission-confirm-full' ? t('确认完整访问', 'Confirm full access')
                  : panel === 'permission-confirm-partial' ? t('确认工作区部分隔离', 'Confirm partial workspace isolation')
                  : panel === 'permission-confirm-network' ? t('确认不受限网络', 'Confirm unrestricted network')
                    : panel === 'control' ? t('外部 Agent 授权', 'External Agent grants')
                      : panel === 'control-action' ? t('授权操作', 'Grant actions')
                        : panel === 'control-revoke-confirm' ? t('确认撤销授权', 'Confirm grant revocation')
                    : '',
      options: choices,
      selected: panel === 'model' ? `${status?.serviceId}:${status?.selectedModel ?? status?.model}`
        : panel === 'mode' ? status?.mode ?? undefined
          : panel === 'policy' ? status?.policy
            : panel === 'permission' ? status?.permission?.profile
              : panel === 'permission-network' ? status?.permission?.network
                : panel === 'control' ? 'create'
                : undefined,
      locale, columns: geometry.columns, height: Math.max(1, geometry.rows - 8), loading: choicesLoading, onClose: closePanel, onSelect: (choice: PanelChoice) => chooseOption(choice.id),
    }),
    controlWizard === null ? null : h(PanelFrame, { tone: 'warning', width: geometry.columns },
      h(Text, { bold: true }, t('创建外控授权', 'Create Agent Control grant')),
      h(Text, { wrap: 'wrap' }, controlPrompt),
      h(Text, { dimColor: true }, t('Enter 提交当前项 · 输入 cancel 取消', 'Enter submits this value · type cancel to stop'))),
    externalControl ? h(Text, { color: running ? 'yellow' : 'cyan', wrap: 'truncate-end' }, externalControlLabel) : null,
    running && showSettings ? h(ProgressLine, { progress: status?.progress, seconds, marker: SPINNER[tick % SPINNER.length], columns: geometry.columns, locale }) : null,
    showComposer ? h(DraftInput, {
      draft, caret, columns: geometry.columns, height: composerHeight,
      placeholder: controlWizard !== null ? t('输入授权设置答案', 'Enter the grant setting')
        : query !== null ? t('输入回答', 'Type your answer')
          : externalControl ? t('给外控 Agent 发消息 · /takeover 接管', 'Message the external agent · /takeover to take over')
            : t('描述任务 · / 命令 · @ 文件', 'Describe a task · / commands · @ files')
              + (geometry.columns >= 72 ? t(` · ${keyHint('newline')} 换行`, ` · ${keyHint('newline')} new line`) : ''),
    }) : null,
    showSettings ? h(ConfigurationLine, {
      model: `${shownModel ?? t('未配置', 'not configured')}${status?.pendingModel ? `→${status.pendingModel}` : ''}`,
      mode: `${status?.mode ?? '—'}${status?.pendingMode ? `→${status.pendingMode}` : ''}`,
      policy: status?.policy ?? 'ask', external: externalControl, columns: geometry.columns, locale,
    }) : null,
    showSettings && !running && geometry.rows >= 20 ? h(Text, { color: TUI_COLORS.muted, wrap: 'truncate-end' }, buildStatusLine({
      sessionId, boundary: info.boundary, status, running: false, seconds, expanded, columns: geometry.columns, locale,
    })) : null,
  );
}
