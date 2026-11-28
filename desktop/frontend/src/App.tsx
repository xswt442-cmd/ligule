import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { DropdownMenu } from 'radix-ui';
import { type FlatIndexLocationWithAlign, type VirtuosoHandle } from 'react-virtuoso';
import { code, createClient, type Client, type Transport } from './protocol';
import { ApprovalCard } from './components/ApprovalCard';
import { QuestionCard, type QuestionDrafts } from './components/QuestionCard';
import { Icon } from './components/Icon';
import { SettingsDialog, type SettingsSectionId } from './components/Settings';
import { BranchPanel } from './components/BranchPanel';
import { WorkbenchDock } from './components/WorkbenchDock';
import { ProjectFilesPanel } from './components/ProjectFilesPanel';
import { ProjectFileView } from './components/ProjectFileView';
import { ProjectGitPanel } from './components/ProjectGitPanel';
import { DeliveryPanel, ArtifactDetailPanel, CheckDetailPanel } from './components/DeliveryPanel';
import { SideSessionPanel } from './components/SideSessionPanel';
import { HoldSheet } from './components/HoldSheet';
import { QuitSheet } from './components/QuitSheet';
import { holdReasons, report as reportEdit, type EditGate } from './edit-gate';
import { reopenSessionWriter } from './session-reopen';
import { requestIsCurrent, type RequestIdentity } from './request-identity';
import { SessionRail } from './components/SessionRail';
import type { SearchHit } from './components/rail/types';
import { createCallOf, type WorkspaceRoster } from './rail';
import { SessionActions } from './components/SessionActions';
import { DiagnosticsPanel } from './components/DiagnosticsPanel';
import { ExportPanel } from './components/ExportPanel';
import { HelpPanel } from './components/HelpPanel';
import { UsageMeter } from './components/UsageMeter';
import { BrowserControl } from './components/BrowserControl';
import { TranscriptViewport, FIRST_INDEX, streamAnchor } from './components/TranscriptViewport';
import { Palette, type Command } from './components/Palette';
import { keepEscape } from './components/ui';
import { CURRENT, actionOf, formatKeys, isCapturing, isComposing, loadBindings, specOf } from './hotkeys';
import { insertMention, mentionToken } from './mentions';
import type { ModelSelection } from './model-catalog';
import { thinkingRequest } from './thinking-request';
import { createSlotRegistry, SLOTS, type Panel } from './slots';
import { appendProjectedRecords, metaRow, projectRecord, shownIn, type Record_, type Row } from './rows';
import { taskSummaryLabelOf, taskSummaryOf, type Status } from './status';
import { loadSettings, mergeQueueIntoDraft, readSettings, saveSettings, saveWorkbenchSettings, updateSettings, type Settings } from './settings';
import { addWorkbenchCommand, closeWorkbenchCommand, closeWorkbenchTab, openWorkbenchResource, registerWorkbenchCommand, registerWorkbenchResource, selectWorkbenchCommand,
  selectWorkbenchTab, updateWorkbenchFileDraft, workbenchStateFrom,
  type WorkbenchCommandReference, type WorkbenchFileDraft, type WorkbenchResource } from './workbench';
import { LocaleProvider, localeOf } from './locale';
import { useNotifications } from './use-notifications';
import { useApprovalsAndQuestions } from './use-approvals-and-questions';
import { useQuitGate } from './use-quit-gate';
import { SessionStreamBuffer } from './session-stream';
import { SessionWindow, olderRecoveryPage } from './session-window';
import { observeExternalSession } from './external-session-observation';
import { clearExternalSessionDraftIfCurrent, externalSessionDraftFor, externalSessionDraftRevisionFor, updateExternalSessionDrafts, type ExternalSessionDrafts } from './external-session-drafts';
import { clearSessionDraftIfCurrent, sessionDraftRevisionFor, updateSessionDraftRevision, type SessionDraftRevisions } from './session-draft-revisions';
import { Composer } from './components/Composer';
import { CommandWorkspace } from './components/CommandWorkspace';
import { SideChatDialog } from './components/SideChatDialog';
import { useSideChat } from './use-side-chat';
import { ExternalSessionComposer, ExternalSessionControlPanel } from './components/ExternalSessionControlPanel';
import type { MentionState } from './mentions';
import type { PermissionConfirmations, PermissionTarget } from './permission-control';
import { object } from './guards.ts';

// 流式输出显示在已落盘记录之后，并保持固定 ID，避免每个增量都重建行并丢失展开状态。
const LIVE_REASONING: Row = { id: -2, kind: 'reasoning', text: '' };
const LIVE_ANSWER: Row = { id: -1, kind: 'answer', text: '' };
type PolicySelection = 'always' | 'ask' | 'auto' | 'never';

type ModelViewTarget = Extract<WorkbenchResource, { kind: 'file' | 'directory' | 'git' | 'subrun' }>
  | { readonly kind: 'command'; readonly reference: WorkbenchCommandReference };

type ModelViewRequest = {
  readonly requestId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly target: ModelViewTarget;
  readonly ready: boolean;
  readonly opening: boolean;
};

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function modelViewTarget(value: unknown): ModelViewTarget | undefined {
  if (!object(value)) return undefined;
  if (value.kind === 'command') {
    const reference = value.reference;
    if (!object(reference) || !['sourceSessionId', 'operationSessionId', 'operationId', 'executionId']
      .every(key => boundedString(reference[key], 160))
      || Object.keys(reference).some(key => !['sourceSessionId', 'operationSessionId', 'operationId', 'executionId'].includes(key))) return undefined;
    return { kind: 'command', reference: {
      sourceSessionId: reference.sourceSessionId as string,
      operationSessionId: reference.operationSessionId as string,
      operationId: reference.operationId as string,
      executionId: reference.executionId as string,
    } };
  }
  if (value.kind === 'file' && boundedString(value.projectRoot, 4096) && boundedString(value.path, 4096)
    && typeof value.version === 'string' && /^(?:[a-f0-9]{16}|[a-f0-9]{64})$/iu.test(value.version)) {
    return { kind: 'file', projectRoot: value.projectRoot, path: value.path, version: value.version };
  }
  if (value.kind === 'directory' && boundedString(value.projectRoot, 4096) && boundedString(value.path, 4096)) {
    return { kind: 'directory', projectRoot: value.projectRoot, path: value.path };
  }
  if (value.kind === 'git' && boundedString(value.projectRoot, 4096) && boundedString(value.path, 4096)
    && typeof value.version === 'string' && /^[a-f0-9]{64}$/iu.test(value.version)) {
    return { kind: 'git', projectRoot: value.projectRoot, path: value.path, version: value.version };
  }
  if (value.kind === 'subrun' && boundedString(value.sessionId, 160) && boundedString(value.parentRunId, 160)
    && boundedString(value.subrunId, 160) && boundedString(value.childSessionId, 160) && boundedString(value.childRunId, 160)) {
    return { kind: 'subrun', sessionId: value.sessionId, parentRunId: value.parentRunId,
      subrunId: value.subrunId, childSessionId: value.childSessionId, childRunId: value.childRunId };
  }
  return undefined;
}

function sameProjectRoot(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const path = value.replaceAll('\\', '/').replace(/\/+$/u, '');
    return /^[a-z]:$/iu.test(path) ? `${path}/` : path;
  };
  const first = normalize(left);
  const second = normalize(right);
  const insensitive = /^[a-z]:\//iu.test(first) || first.startsWith('//');
  return insensitive ? first.toLowerCase() === second.toLowerCase() : first === second;
}

function modelViewTargetLabel(target: ModelViewTarget, t: (chinese: string, english: string) => string): string {
  switch (target.kind) {
    case 'file': return `${t('文件', 'File')} · ${target.path}`;
    case 'directory': return `${t('目录', 'Directory')} · ${target.path}`;
    case 'git': return `${t('差异', 'Diff')} · ${target.path}`;
    case 'subrun': return `${t('子任务', 'Subtask')} · ${target.subrunId}`;
    case 'command': return `${t('命令', 'Command')} · ${target.reference.executionId}`;
  }
}

// 每次向前读取一页事件；打开会话时先取最近页，再按游标读取更早记录。
const RENDER_WINDOW = 400;
type PanelProps = {
  client: Client;
  status: Status | null;
  sessionId: string | null;
  running: boolean;
  // 统计其他会话中正在运行的轮次，供顶栏显示后台活动状态。
  othersRunning: number;
  // 左侧栏按会话显示运行状态和未读完成状态。
  runningIds: string[];
  unread: string[];
  // 当前窗口额外显示的工作区保存在界面偏好中。
  projects: string[];
  onProjects: (roots: string[]) => void;
  // 当前会话所属项目决定模型配置和审批规则的读取与写入范围。
  projectRoot: string;
  // Host 重启后代次递增，面板的迟到读取据此失效。
  hostRevision: number;
  // 在指定项目中创建会话；未指定时使用 Host 的默认项目。
  createIn: (root?: string) => void;
  // 当前设置页有未保存编辑时，关闭或切换前先请求用户确认。
  onEdit?: (reason: string) => void;
  seconds: number;
  waiting: number;
  counts: { sent: number; received: number };
  link: string | null;
  logs: string[];
  onReconnect: () => void;
  openSession: (id: string, projectRoot?: string) => void;
  // 搜索结果包含会话和事件序号；先打开会话，再定位到该事件。
  openHit: (hit: SearchHit, projectRoot?: string) => void;
  openProjectFile: (root: string, path: string, version?: string) => void;
  openProjectGit: (root: string) => void;
  openArtifact: (artifactKey: string) => void;
  openCheck: (runId: string, eventSeq: number) => void;
  openDiagnostics: () => void;
  // 新建分支后递增此值，触发左侧栏重新加载会话列表。
  sessionsRevision: number;
  settings: Settings;
  patch: (part: Partial<Settings>) => void;
};

// 表示当前没有文本组合输入；有效光标位置不会是 -1。
const NO_TOKEN = { start: -1, text: '' };
const DEFAULT_NEW_SESSION_PERMISSION: PermissionTarget = { profile: 'read-only', network: 'policy' };
const NO_PERMISSION_CONFIRMATIONS: PermissionConfirmations = { fullAccess: false, network: false, partialWorkspaceWrite: false, workspaceTrust: false };

// 已打开的会话。右侧面板显示当前会话状态，不重复提供会话浮层已有的控制项。
/**
 * 返回持久工作区登记中的默认目录。未设置默认目录或读取失败时返回 undefined。
 * Desktop 不使用 Host 继承的进程当前目录作为工作区。
 */
async function defaultWorkspaceOf(client: Client): Promise<string | undefined> {
  const roster = await client.call('workspaces.list', {}, 15_000).catch(() => null) as WorkspaceRoster | null;
  return roster === null ? undefined : roster.workspaces.find((one) => one.identity === roster.default)?.directory;
}

/**
 * 首次启动时请 Electron 壳创建默认工作区并登记选择，以便后续启动和侧栏继续使用。
 * 获取目录、创建目录或写入登记失败时返回原因，不自动切换到其他目录。
 */
async function registerShellWorkspace(getDirectory: () => Promise<string>, client: Client): Promise<{ directory?: string; failed?: string }> {
  try {
    const directory = await getDirectory();
    await client.call('workspace.default.set', { directory }, 15_000);
    return { directory };
  } catch (error) {
    return { failed: String((error as { message?: unknown })?.message ?? error) };
  }
}

const menuPanels: Panel<PanelProps>[] = [
  {
    id: 'panel.delivery',
    title: '交付',
    view: ({ client, sessionId, projectRoot, status, hostRevision, openProjectFile, openProjectGit, openArtifact, openCheck, openDiagnostics, openHit }) => (
      <DeliveryPanel client={client} sessionId={sessionId} projectRoot={projectRoot} status={status} hostRevision={hostRevision}
        onOpenFile={path => openProjectFile(projectRoot, path)}
        onOpenEvent={(seq, kind) => sessionId !== null && openHit({ sessionId, name: '', seq, kind, text: '' }, projectRoot)}
        onOpenArtifact={openArtifact} onOpenCheck={openCheck} onOpenProjectChanges={() => openProjectGit(projectRoot)}
        onOpenDiagnostics={openDiagnostics} />
    ),
  },
  {
    id: 'panel.diagnostics',
    title: '诊断',
    view: ({ client, sessionId, status, counts, waiting, link, logs, onReconnect }) => <DiagnosticsPanel client={client} sessionId={sessionId} status={status} counts={counts} waiting={waiting} link={link} logs={logs} onReconnect={onReconnect} />,
  },
  {
    id: 'panel.branch',
    title: '派生支线',
    view: ({ client, sessionId, status, settings }) => <BranchPanel client={client} sessionId={sessionId}
      activeRunId={status?.activeRunId ?? null} runStatusKnown={status !== null} verbosity={settings.verbosity} />,
  },
  {
    id: 'panel.export',
    title: '导出全文',
    view: ({ client, sessionId }) => <ExportPanel client={client} sessionId={sessionId} />,
  },
  {
    id: 'panel.help',
    title: '使用手册',
    // 直接显示随包的使用手册内容，不读取磁盘或请求网络；该面板与当前会话无关。
    view: () => <HelpPanel />,
  },
];

// 左侧栏从 `sessions.list` 读取会话，并通过已声明的界面槽位渲染。
const railPanels: Panel<PanelProps>[] = [
  {
    id: 'rail.sessions',
    title: '会话',
    view: ({ client, sessionId, openSession, openHit, sessionsRevision, runningIds, unread, projects, onProjects, createIn, settings, patch }) => (
      <SessionRail client={client} current={sessionId} onOpen={openSession} onOpenHit={openHit} revision={sessionsRevision} running={runningIds} unread={unread} projects={projects} hidden={settings.hiddenProjects} onHidden={(hiddenProjects) => patch({ hiddenProjects })} onProjects={onProjects} onCreate={createIn} />
    ),
  },
];

export function App({ transport }: { transport: Transport }) {
  const client = useMemo(() => createClient(transport), [transport]);
  const registry = useMemo(() => {
    const created = createSlotRegistry<PanelProps>(SLOTS);
    for (const panel of menuPanels) created.register('rail.menu', panel);
    for (const panel of railPanels) created.register('rail.sessions', panel);
    return created;
  }, []);

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionLabel, setSessionLabel] = useState({ name: '', archived: false });
  const [starting, setStarting] = useState(false);
  const creating = useRef(false);
  const newParameters = useRef<ReturnType<typeof createCallOf>>({});
  const booted = useRef(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [live, setLive] = useState({ text: '', reasoning: '' });
  // 按会话分别保存流式片段；切回后台会话时可先显示尚未落盘的输出。
  const liveStreamRef = useRef<SessionStreamBuffer | null>(null);
  if (liveStreamRef.current === null) liveStreamRef.current = new SessionStreamBuffer();
  const liveBySession = liveStreamRef.current;
  // 已应用的记录序号；打开会话期间收到的记录先缓存在这里，等快照落定后再按序应用。
  const sessionWindowRef = useRef<SessionWindow<Record_> | null>(null);
  if (sessionWindowRef.current === null) sessionWindowRef.current = new SessionWindow<Record_>();
  const sessionWindow = sessionWindowRef.current;
  const pendingRecords = useRef<Record_[] | null>(null);
  const appendRecord = useCallback((record: Record_) => {
    if (record?.kind === 'assistant') {
      for (const call of record.toolCalls ?? []) dispatchAt.current.set(call.id, Date.now());
    }
    // 事件不保存逐条计时；运行时长由界面在轮次进行期间测量。
    const started = record?.kind === 'tool' && record.callId !== undefined ? dispatchAt.current.get(record.callId) : undefined;
    if (started !== undefined && record?.callId !== undefined) dispatchAt.current.delete(record.callId);
    const added = projectRecord(record, started === undefined ? {} : { startedAt: started });
    if (added.length > 0) setRows((current) => [...current, ...added]);
  }, []);
  const acceptExternalDelta = useCallback((kind: 'text' | 'reasoning', text: string) => {
    const held = liveBySession.append(sessionId ?? '', kind, text);
    if (held !== null && sessionId !== null) setLive(held);
  }, [liveBySession, sessionId]);
  const settleExternalEvent = useCallback((kind: string) => {
    if (sessionId === null) return;
    const held = liveBySession.settle(sessionId, kind);
    setLive(held);
  }, [liveBySession, sessionId]);
  const terminalBySession = useRef(new Map<string, number>());
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const active = useRef<string | null>(null);
  const {
    asks, queries, questionDrafts, receive: receiveInteraction, keepQuestionDraft, takeEchoes, outstandingApprovals,
    dropAsksOf, dropQueriesOf, resetInteractions, loadApprovalDetails, answer, answerQuestion,
  } = useApprovalsAndQuestions(client, sessionId, active, composerRef, setRows);
  const externalQuestionDrafts = useRef(new Map<string, Map<string, QuestionDrafts>>());
  const getExternalQuestionDraft = useCallback((owner: string, id: string) => externalQuestionDrafts.current.get(owner)?.get(id), []);
  const keepExternalQuestionDraft = useCallback((owner: string, id: string, drafts: QuestionDrafts | null) => {
    const sessionDrafts = externalQuestionDrafts.current.get(owner);
    if (drafts === null) {
      sessionDrafts?.delete(id);
      if (sessionDrafts?.size === 0) externalQuestionDrafts.current.delete(owner);
      return;
    }
    const nextSessionDrafts = sessionDrafts ?? new Map<string, QuestionDrafts>();
    nextSessionDrafts.set(id, drafts);
    if (sessionDrafts === undefined) externalQuestionDrafts.current.set(owner, nextSessionDrafts);
  }, []);
  // 每个会话独立维护运行状态、取消信号和输入队列。
  // 轮次完成状态只更新所属会话，切换前台会话不会改变其他会话的显示。
  const [runningIds, setRunningIds] = useState<string[]>([]);
  const running = sessionId !== null && runningIds.includes(sessionId);
  const othersRunning = runningIds.filter((id) => id !== sessionId).length;
  // 保存各会话轮次的开始时间；顶栏只显示当前会话的运行时长。
  const roundStart = useRef(new Map<string, number>());
  const [tick, setTick] = useState(Date.now());
  const seconds = sessionId === null ? 0 : Math.max(0, Math.floor((tick - (roundStart.current.get(sessionId) ?? tick)) / 1000));
  // 后台会话结束时标记为有未读结果；用户切回该会话时清除标记。
  const [unread, setUnread] = useState<string[]>([]);
  // 记录允许继续发送队列的会话 ID；只在该会话自身结束或用户明确选择继续时设置。
  // 使用 ref 保存该控制标记，不额外触发界面渲染。
  const allowSend = useRef(new Set<string>());
  const [status, setStatus] = useState<Status | null>(null);
  const [hostRevision, setHostRevision] = useState(0);
  const [modelViewRequest, setModelViewRequest] = useState<ModelViewRequest | null>(null);
  const modelViewRequestRef = useRef<ModelViewRequest | null>(null);
  useEffect(() => {
    if (modelViewRequestRef.current === null || modelViewRequestRef.current.sessionId === sessionId) return;
    modelViewRequestRef.current = null;
    setModelViewRequest(null);
  }, [sessionId]);
  const [taskSnapshotAt, setTaskSnapshotAt] = useState(Date.now());
  const [newSessionSettingsRevision, setNewSessionSettingsRevision] = useState(0);
  const [newSessionMode, setNewSessionMode] = useState<string | null>(null);
  const [newSessionPolicy, setNewSessionPolicy] = useState<PolicySelection | null>(null);
  const [newSessionPermission, setNewSessionPermission] = useState<PermissionTarget>(DEFAULT_NEW_SESSION_PERMISSION);
  const [newSessionPermissionConfirmations, setNewSessionPermissionConfirmations] = useState<PermissionConfirmations>(NO_PERMISSION_CONFIRMATIONS);
  const [draft, setDraftState] = useState('');
  const [caret, setCaret] = useState(0);
  // `@` 路径候选由 Host 提供，前端不扫描项目目录。
  const [mention, setMention] = useState<MentionState | null>(null);
  // 按 Esc 暂时关闭当前候选；输入文本改变后重新查询相应候选。
  const [hiddenMention, setHiddenMention] = useState('');
  const mentionWanted = useRef(NO_TOKEN);
  const mentionAsked = useRef(NO_TOKEN);
  // 从会话记录首行读取草稿和队列所属的项目身份；保存失败时只提示一次。
  const [projectRoot, setProjectRoot] = useState('');
  // 当前草稿所属的会话。打开会话时，需等恢复请求完成后再保存草稿，避免把旧草稿写入新会话。
  const [inputOwner, setInputOwner] = useState<string | null>(null);
  const [readOnlySessionId, setReadOnlySessionId] = useState<string | null>(null);
  const [writerLockNoticeSessionId, setWriterLockNoticeSessionId] = useState<string | null>(null);
  const [sessionWriterActive, setSessionWriterActive] = useState(false);
  const [externalControlSessionId, setExternalControlSessionId] = useState<string | null>(null);
  const [externalSessionDrafts, setExternalSessionDrafts] = useState<ExternalSessionDrafts>(() => new Map());
  const saveWarned = useRef(false);
  // Host 重连期间暂停发送队列，也不触发轮次结束后的自动发送。
  const reconnecting = useRef(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // 右侧面板存在未保存编辑或进行中的写入时，关闭或切换前先确认。
  const [dockGate, setDockGate] = useState<EditGate>({});
  const [dockHold, setDockHold] = useState<{ reasons: string[]; go: () => void } | null>(null);
  const reportDock = useCallback((reason: string) => setDockGate((now) => reportEdit(now, 'dock', reason)), []);
  const leaveDock = useCallback((go: () => void) => {
    const reasons = holdReasons(dockGate);
    if (reasons.length === 0) go();
    else setDockHold({ reasons, go });
  }, [dockGate]);
  const [settings, setSettings] = useState(readSettings);
  const workbenchRef = useRef(settings.workbench);
  const workbenchEditRevision = useRef(0);
  const workbenchDraftSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [workbenchError, setWorkbenchError] = useState<string | null>(null);
  const activeWorkbenchTab = settings.workbench.tabs.find(tab => tab.key === settings.workbench.activeKey) ?? null;
  const activePanelId = activeWorkbenchTab?.resource.kind === 'panel' ? activeWorkbenchTab.resource.panelId : null;
  const panel = activePanelId === null ? null : menuPanels.find(item => item.id === activePanelId) ?? null;
  const language = localeOf(settings.language);
  const t = useCallback((chinese: string, english: string) => language === 'zh' ? chinese : english, [language]);
  const progress = status?.progress ?? null;
  const observingExternalSession = sessionId !== null && readOnlySessionId === sessionId;
  const progressPhase = progress === null ? '' : {
    preparing: t('准备上下文', 'Preparing context'),
    model_request: t('请求模型', 'Requesting model'),
    tool_execution: t('执行工具', 'Running tools'),
    compaction: t('压缩上下文', 'Compacting context'),
    awaiting_approval: t('等待审批', 'Waiting for approval'),
    awaiting_input: t('等待用户输入', 'Waiting for your input'),
    settling: t('正在收尾', 'Finishing'),
  }[progress.phase];
  const progressIdleSeconds = progress === null ? 0 : Math.max(0, Math.floor((tick - progress.lastProgressAt) / 1000));
  const taskSummary = taskSummaryOf(status?.task, status?.taskLimits, progress, taskSnapshotAt, tick);
  const taskLabel = taskSummary !== null
    ? ` · ${taskSummaryLabelOf(taskSummary, language)}`
    : status?.running === true
      ? ` · ${t('Run 预算准备中', 'run budget initializing')}`
      : '';
  const fallbackCallsLabel = taskSummary === null
    ? ` · ${progress?.modelCalls ?? 0} ${t('次模型调用', 'model calls')}` : '';
  const progressLabel = `${progressPhase || t('运行中', 'Running')} · ${progressIdleSeconds}${t('秒无新进展', 's without progress')}${fallbackCallsLabel} · ${progress?.toolCalls ?? 0} ${t('个工具调用', 'tool calls')}${status?.outputTokens === null || status?.outputTokens === undefined ? '' : ` · ${status.outputTokens} ${t('个输出token', 'output tokens')}`}${taskLabel}`;
  const panelTitle = useCallback((item: Panel<PanelProps>) => {
    const titles: Record<string, [string, string]> = {
      'panel.delivery': ['交付', 'Deliveries'],
      'panel.diagnostics': ['诊断', 'Diagnostics'],
      'panel.branch': ['派生支线', 'Subtasks'],
      'panel.export': ['导出全文', 'Export transcript'],
      'panel.help': ['使用手册', 'User guide'],
      'rail.sessions': ['会话', 'Conversations'],
    };
    const title = titles[item.id];
    return title === undefined ? item.title : t(title[0], title[1]);
  }, [t]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modelCatalogRevision, setModelCatalogRevision] = useState(0);
  const settingsEdits = useRef<string[]>([]);
  const reportSettingsEdits = useCallback((reasons: string[]) => { settingsEdits.current = reasons; }, []);
  const dockEdits = useRef<string[]>([]);
  dockEdits.current = holdReasons(dockGate);
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId>('general');
  const openModelSettings = useCallback(() => { setSettingsSection('model'); setSettingsOpen(true); }, []);
  const openSecuritySettings = useCallback(() => { setSettingsSection('security'); setSettingsOpen(true); }, []);
  const [diagnosticLogs, setDiagnosticLogs] = useState<string[]>([]);
  const reportTrayFailure = useCallback((message: string) => {
    setDiagnosticLogs(current => [...current, message].slice(-50));
  }, []);
  const {
    problem: notificationProblem, setProblem: setNotificationProblem,
    destination: notificationDestination, setDestination: setNotificationDestination, sessions: notificationSessions, notify,
  } = useNotifications(transport.notifications, settings.notifications, language, asks.length + queries.length, runningIds.length, reportTrayFailure);
  // 当前会话的模式和策略面板由顶栏对应按钮打开。
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const [reading, setReading] = useState(false);
  const verbosity = settings.verbosity;
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 760px)').matches);
  const [mobileSidebar, setMobileSidebar] = useState(false);
  const collapsed = settings.collapsed || (narrow && !mobileSidebar);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 760px)');
    const change = () => { setNarrow(media.matches); setMobileSidebar(false); };
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  // 输入历史由 Host 在共享文件中维护；界面使用 `-1` 表示当前未发送草稿。
  const [history, setHistory] = useState<string[]>([]);
  const [walk, setWalk] = useState(-1);
  // 运行期间的新输入按会话保存在前端队列中；取消后暂停，等待用户明确继续。
  const [queues, setQueues] = useState<Record<string, { items: string[]; paused: boolean }>>({});
  const queue = readOnlySessionId === sessionId ? { items: [] as string[], paused: false }
    : queues[sessionId ?? ''] ?? { items: [] as string[], paused: false };
  const patchQueue = useCallback((own: string, next: (current: { items: string[]; paused: boolean }) => { items: string[]; paused: boolean }) => {
    setQueues((current) => ({ ...current, [own]: next(current[own] ?? { items: [], paused: false }) }));
  }, []);
  const updateExternalControlAvailability = useCallback((owner: string, available: boolean) => {
    if (active.current !== owner) return;
    setExternalControlSessionId(available ? owner : null);
  }, []);
  // 阅读位置在底部时自动跟随新内容；用户向上滚动后暂停跟随，并显示返回最新内容的按钮。
  const list = useRef<VirtuosoHandle | null>(null);
  const [pinned, setPinned] = useState(true);
  // 只有用户滚动会改变跟随状态；布局测量和程序定位不视为用户滚动。
  const readerScrolling = useRef(false);
  // `before` 保存当前最早事件的序号，`hasMore` 表示 Host 是否还有更早记录。
  // 前端只保留已加载页面，完整记录由 Host 持有。
  const [page, setPage] = useState<{ before: number; hasMore: boolean } | null>(null);
  const [olderLoading, setOlderLoading] = useState(false);
  const [firstIndex, setFirstIndex] = useState(FIRST_INDEX);
  const prependAnchor = useRef<{ id: number; offset: number; request: number } | null>(null);
  const renderedStream = useRef({ rows: [] as Row[], firstIndex: FIRST_INDEX, verbosity });
  // 当前跳转目标，来源可以是搜索结果或恢复的阅读位置。
  const [wanted, setWanted] = useState<{ sessionId: string; seq: number; kind: string } | null>(null);
  const [stamp, setStamp] = useState(0);
  const [initialIndex, setInitialIndex] = useState<FlatIndexLocationWithAlign>({ index: 'LAST', align: 'end' });
  // 分支创建成功后触发左侧栏重新加载会话列表。
  const [sessionsRevision, setSessionsRevision] = useState(0);
  // 按会话保存最上方可见事件序号；切回时仅在该记录已加载的页面范围内恢复位置。
  const anchors = useRef(new Map<string, number>());
  // 标记当前读取请求所属会话，切换会话后丢弃过期响应。
  const opening = useRef<string | null>(null);
  // 每次打开会话都生成新的请求编号，避免 A→B→A 时旧请求释放新请求的输入保护。
  const openRequest = useRef(0);
  const renderedSessionRequest: RequestIdentity = { scope: sessionId, generation: openRequest.current };
  // 短暂高亮定位目标，帮助用户在长转录中确认跳转位置。
  const [flash, setFlash] = useState<number | null>(null);
  // 按调用 ID 记录派发时间，用于计算工具运行耗时。
  const dispatchAt = useRef(new Map<string, number>());
  // 记录 Host 连接状态；null 表示连接正常，其他值是 Host 返回的错误信息。
  const [link, setLink] = useState<string | null>(null);
  const connectionLost = useRef(false);

  // 窗口打开和 Host 重启时读取共享输入历史。读取失败时按空列表显示；写入由 Host 在锁内合并，避免覆盖其他客户端的更新。
  useEffect(() => {
    client.call('history.read', {}, 60_000).then(
      (read) => setHistory((read as { entries: string[] }).entries),
      () => setHistory([]),
    );
  }, [client]);

  // 桌面偏好以应用数据根中的文档为准，打开窗口时从 Host 读取。
  // 只有该文档不存在且 WebView 缓存仍有内容时，才将缓存迁入数据根。
  // 读取完成前不保存默认值，避免覆盖已有草稿或队列。
  const prefsSettled = useRef<Promise<void>>(Promise.resolve());
  const [settingsReady, setSettingsReady] = useState(false);
  const unsavedInputs = useRef(new Map<string, { root: string; id: string; draft?: string; items?: string[] }>());
  const draftRevisions = useRef<SessionDraftRevisions>(new Map());
  const draftState = useRef(draft);
  draftState.current = draft;
  const draftOwnerState = useRef({ root: projectRoot, id: inputOwner ?? sessionId ?? '$new' });
  draftOwnerState.current = {
    root: projectRoot || notificationSessions.current.get(inputOwner ?? sessionId ?? '$new')?.root || '',
    id: inputOwner ?? sessionId ?? '$new',
  };
  const inputOwnerState = useRef(inputOwner);
  inputOwnerState.current = inputOwner;
  const setDraft = useCallback((
    update: string | ((current: string) => string),
    owner: { root: string; id: string } | null = draftOwnerState.current,
  ) => {
    const previous = draftState.current;
    const next = typeof update === 'function' ? update(previous) : update;
    if (next !== previous && owner !== null) {
      const key = JSON.stringify([owner.root, owner.id]);
      draftRevisions.current = updateSessionDraftRevision(draftRevisions.current, key, next);
      unsavedInputs.current.set(key, {
        ...unsavedInputs.current.get(key), root: owner.root, id: owner.id, draft: next,
      });
    }
    draftState.current = next;
    setDraftState(next);
  }, []);
  // 只为后台会话保存草稿，不替换当前输入框。
  const saveBackgroundDraft = useCallback((text: string, owner: { root: string; id: string }) => {
    const key = JSON.stringify([owner.root, owner.id]);
    draftRevisions.current = updateSessionDraftRevision(draftRevisions.current, key, text);
    unsavedInputs.current.set(key, {
      ...unsavedInputs.current.get(key), root: owner.root, id: owner.id, draft: text,
    });
  }, []);
  const [prefsFailure, setPrefsFailure] = useState<string | null>(null);
  const [prefsDetails, setPrefsDetails] = useState('');
  const [prefsRevision, setPrefsRevision] = useState(0);
  const applyWorkbenchState = useCallback((value: ReturnType<typeof workbenchStateFrom>) => {
    if (workbenchDraftSaveTimer.current !== null) {
      clearTimeout(workbenchDraftSaveTimer.current);
      workbenchDraftSaveTimer.current = null;
    }
    const next = workbenchStateFrom(value);
    workbenchRef.current = next;
    const revision = workbenchEditRevision.current + 1;
    workbenchEditRevision.current = revision;
    setSettings(current => ({ ...current, workbench: next }));
    void Promise.resolve(prefsSettled.current).then(() => saveWorkbenchSettings(client, next)).then(() => {
      if (workbenchEditRevision.current === revision) workbenchEditRevision.current = 0;
    }).catch(error => {
      setPrefsFailure(code(error));
      setPrefsDetails(error instanceof Error ? error.message : String(error));
    });
  }, [client]);
  const updateProjectFileDraft = useCallback((key: string, draft: WorkbenchFileDraft | undefined) => {
    try {
      const next = updateWorkbenchFileDraft(workbenchRef.current, key, draft);
      workbenchRef.current = next;
      const revision = workbenchEditRevision.current + 1;
      workbenchEditRevision.current = revision;
      setSettings(current => ({ ...current, workbench: next }));
      if (workbenchDraftSaveTimer.current !== null) clearTimeout(workbenchDraftSaveTimer.current);
      workbenchDraftSaveTimer.current = setTimeout(() => {
        workbenchDraftSaveTimer.current = null;
        if (workbenchEditRevision.current !== revision) return;
        void Promise.resolve(prefsSettled.current).then(() => saveWorkbenchSettings(client, workbenchRef.current)).then(() => {
          if (workbenchEditRevision.current === revision) workbenchEditRevision.current = 0;
        }).catch(error => {
          setPrefsFailure(code(error));
          setPrefsDetails(error instanceof Error ? error.message : String(error));
        });
      }, 250);
      return true;
    } catch (error) {
      setWorkbenchError(code(error));
      return false;
    }
  }, [client]);
  const openPanel = useCallback((item: Panel<PanelProps>) => {
    const panelIds = ['panel.delivery', 'panel.diagnostics', 'panel.branch', 'panel.export', 'panel.help'] as const;
    const panelId = panelIds.find(id => id === item.id);
    if (panelId === undefined) return;
    leaveDock(() => {
      const resource: WorkbenchResource = panelId === 'panel.help'
        ? { kind: 'panel', panelId }
        : { kind: 'panel', panelId,
          ...(projectRoot === '' ? {} : { projectRoot }),
          ...(sessionId === null ? {} : { sessionId }) };
      try {
        applyWorkbenchState(openWorkbenchResource(workbenchRef.current, resource, panelTitle(item)));
        setWorkbenchError(null);
      } catch (error) {
        setWorkbenchError(code(error));
      }
    });
  }, [applyWorkbenchState, leaveDock, panelTitle, projectRoot, sessionId]);
  const openProjectDirectory = useCallback((root: string, path: string) => {
    if (sessionId === null || projectRoot === '' || !sameProjectRoot(root, projectRoot)) {
      setWorkbenchError('project_files_session_required');
      return;
    }
    leaveDock(() => {
      const title = path === '.' ? t('项目文件', 'Files') : path.split('/').at(-1) ?? path;
      try {
        applyWorkbenchState(openWorkbenchResource(workbenchRef.current, { kind: 'directory', projectRoot: root, path }, title));
        setWorkbenchError(null);
      } catch (error) { setWorkbenchError(code(error)); }
    });
  }, [applyWorkbenchState, leaveDock, projectRoot, sessionId, t]);
  const openProjectGit = useCallback((root: string) => {
    if (sessionId === null || projectRoot === '' || !sameProjectRoot(root, projectRoot)) {
      setWorkbenchError('project_files_session_required');
      return;
    }
    leaveDock(() => {
      try {
        applyWorkbenchState(openWorkbenchResource(workbenchRef.current, { kind: 'git', projectRoot: root }, t('项目改动', 'Project changes')));
        setWorkbenchError(null);
      } catch (error) { setWorkbenchError(code(error)); }
    });
  }, [applyWorkbenchState, leaveDock, projectRoot, sessionId, t]);
  const openProjectFile = useCallback((root: string, path: string, version?: string) => {
    if (sessionId === null || projectRoot === '' || !sameProjectRoot(root, projectRoot)) {
      setWorkbenchError('project_files_session_required');
      return;
    }
    leaveDock(() => {
      const title = path.split('/').at(-1) ?? path;
      try {
        applyWorkbenchState(openWorkbenchResource(workbenchRef.current,
          { kind: 'file', projectRoot: root, path, ...(version === undefined ? {} : { version }) }, title));
        setWorkbenchError(null);
      } catch (error) { setWorkbenchError(code(error)); }
    });
  }, [applyWorkbenchState, leaveDock, projectRoot, sessionId]);
  const openArtifactResource = useCallback((artifactKey: string) => {
    if (sessionId === null || projectRoot === '') {
      setWorkbenchError('project_files_session_required');
      return;
    }
    leaveDock(() => {
      try {
        applyWorkbenchState(openWorkbenchResource(workbenchRef.current,
          { kind: 'artifact', projectRoot, sessionId, artifactKey }, t('交付物', 'Artifact')));
        setWorkbenchError(null);
      } catch (error) { setWorkbenchError(code(error)); }
    });
  }, [applyWorkbenchState, leaveDock, projectRoot, sessionId, t]);
  const openCheckResource = useCallback((runId: string, eventSeq: number) => {
    if (sessionId === null) {
      setWorkbenchError('session_id_required');
      return;
    }
    leaveDock(() => {
      try {
        applyWorkbenchState(openWorkbenchResource(workbenchRef.current,
          { kind: 'check', ...(projectRoot === '' ? {} : { projectRoot }), sessionId, runId, eventSeq },
          t(`检查 ${eventSeq}`, `Check ${eventSeq}`)));
        setWorkbenchError(null);
      } catch (error) { setWorkbenchError(code(error)); }
    });
  }, [applyWorkbenchState, leaveDock, projectRoot, sessionId, t]);
  const openSideSessionResource = useCallback((sideSessionId: string, originSessionId: string, root: string) => {
    leaveDock(() => {
      try {
        applyWorkbenchState(openWorkbenchResource(workbenchRef.current,
          { kind: 'side-session', projectRoot: root, sessionId: sideSessionId, originSessionId }, t('侧聊来源', 'Side chat source')));
        setWorkbenchError(null);
      } catch (error) { setWorkbenchError(code(error)); }
    });
  }, [applyWorkbenchState, leaveDock, t]);
  // 后台回执只登记资源，不激活工作台页面，也不改变前台正在看的文件。
  const registerSideSessionResource = useCallback((sideSessionId: string, originSessionId: string, root: string) => {
    try {
      applyWorkbenchState(registerWorkbenchResource(workbenchRef.current,
        { kind: 'side-session', projectRoot: root, sessionId: sideSessionId, originSessionId }, t('侧聊来源', 'Side chat source')));
      setWorkbenchError(null);
    } catch (error) { setWorkbenchError(code(error)); }
  }, [applyWorkbenchState, t]);
  const selectWorkbench = useCallback((key: string) => {
    leaveDock(() => applyWorkbenchState(selectWorkbenchTab(workbenchRef.current, key)));
  }, [applyWorkbenchState, leaveDock]);
  const closeWorkbench = useCallback((key: string) => {
    leaveDock(() => applyWorkbenchState(closeWorkbenchTab(workbenchRef.current, key)));
  }, [applyWorkbenchState, leaveDock]);
  const addCommandReference = useCallback((reference: WorkbenchCommandReference, activate: boolean) => {
    try {
      // 迟到的成功回执只登记引用这一事实，不打开工作台、不改变当前选中项。
      applyWorkbenchState(activate
        ? addWorkbenchCommand(workbenchRef.current, reference)
        : registerWorkbenchCommand(workbenchRef.current, reference));
      setWorkbenchError(null);
    } catch (error) { setWorkbenchError(code(error)); }
  }, [applyWorkbenchState]);
  const clearModelViewRequest = useCallback(() => {
    modelViewRequestRef.current = null;
    setModelViewRequest(null);
  }, []);
  const resolveModelViewRequest = useCallback((request: ModelViewRequest, action: 'opened' | 'dismissed') => {
    void client.call('view.request.ack', {
      sessionId: request.sessionId, runId: request.runId, requestId: request.requestId, action,
    }, 10_000).then(() => {
      if (modelViewRequestRef.current?.requestId === request.requestId) clearModelViewRequest();
    }).catch(error => {
      setWorkbenchError(code(error));
      const current = modelViewRequestRef.current;
      if (current?.requestId === request.requestId) {
        const retry = { ...current, opening: false };
        modelViewRequestRef.current = retry;
        setModelViewRequest(retry);
      }
    });
  }, [clearModelViewRequest, client]);
  const dismissModelViewRequest = useCallback(() => {
    const request = modelViewRequestRef.current;
    if (request === null || !request.ready || request.opening) return;
    const opening = { ...request, opening: true };
    modelViewRequestRef.current = opening;
    setModelViewRequest(opening);
    resolveModelViewRequest(opening, 'dismissed');
  }, [resolveModelViewRequest]);
  const openModelViewRequest = useCallback(() => {
    const request = modelViewRequestRef.current;
    if (request === null || !request.ready || request.opening) return;
    if (request.sessionId !== active.current || request.sessionId !== sessionId) {
      setWorkbenchError('view_request_stale');
      clearModelViewRequest();
      return;
    }
    const target = request.target;
    if ((target.kind === 'file' || target.kind === 'directory' || target.kind === 'git')
      && !sameProjectRoot(target.projectRoot, projectRoot)
      || target.kind === 'subrun' && target.sessionId !== request.sessionId
      || target.kind === 'command' && target.reference.sourceSessionId !== request.sessionId) {
      setWorkbenchError('view_request_stale');
      clearModelViewRequest();
      return;
    }
    if (target.kind === 'command') {
      const opening = { ...request, opening: true };
      modelViewRequestRef.current = opening;
      setModelViewRequest(opening);
      try {
        applyWorkbenchState(addWorkbenchCommand(workbenchRef.current, target.reference));
        setWorkbenchError(null);
        resolveModelViewRequest(opening, 'opened');
      } catch (error) {
        setWorkbenchError(code(error));
        const retry = { ...opening, opening: false };
        modelViewRequestRef.current = retry;
        setModelViewRequest(retry);
      }
      return;
    }
    const title = target.kind === 'file' ? target.path.split('/').at(-1) ?? target.path
      : target.kind === 'directory' ? target.path === '.' ? t('项目文件', 'Files') : target.path.split('/').at(-1) ?? target.path
        : target.kind === 'git' ? t(`差异 · ${target.path}`, `Diff · ${target.path}`)
          : t(`子任务 ${target.subrunId}`, `Subtask ${target.subrunId}`);
    leaveDock(() => {
      if (modelViewRequestRef.current?.requestId !== request.requestId) return;
      const opening = { ...request, opening: true };
      modelViewRequestRef.current = opening;
      setModelViewRequest(opening);
      try {
        applyWorkbenchState(openWorkbenchResource(workbenchRef.current, target, title));
        setWorkbenchError(null);
        resolveModelViewRequest(opening, 'opened');
      } catch (error) {
        setWorkbenchError(code(error));
        const retry = { ...opening, opening: false };
        modelViewRequestRef.current = retry;
        setModelViewRequest(retry);
      }
    });
  }, [applyWorkbenchState, clearModelViewRequest, leaveDock, projectRoot, resolveModelViewRequest, sessionId, t]);
  const selectCommandReference = useCallback((key: string) => {
    applyWorkbenchState(selectWorkbenchCommand(workbenchRef.current, key));
  }, [applyWorkbenchState]);
  const closeCommandReference = useCallback((key: string) => {
    applyWorkbenchState(closeWorkbenchCommand(workbenchRef.current, key));
  }, [applyWorkbenchState]);
  const hideWorkbench = useCallback(() => {
    leaveDock(() => applyWorkbenchState({ ...workbenchRef.current, rightOpen: false }));
  }, [applyWorkbenchState, leaveDock]);
  const toggleWorkbench = useCallback(() => {
    if (workbenchRef.current.rightOpen) hideWorkbench();
    else applyWorkbenchState({ ...workbenchRef.current, rightOpen: true });
  }, [applyWorkbenchState, hideWorkbench]);
  const toggleCommandArea = useCallback(() => {
    applyWorkbenchState({ ...workbenchRef.current, bottomOpen: !workbenchRef.current.bottomOpen });
  }, [applyWorkbenchState]);
  const hideCommandArea = useCallback(() => {
    applyWorkbenchState({ ...workbenchRef.current, bottomOpen: false });
  }, [applyWorkbenchState]);
  const startDockResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const startX = event.clientX;
    const startWidth = settings.workbench.rightWidth;
    let resizedWidth = startWidth;
    const target = event.currentTarget;
    const dock = target.closest<HTMLElement>('.workbench-dock');
    event.preventDefault();
    try { target.setPointerCapture(event.pointerId); } catch { /* 全局监听仍可完成拖动 */ }
    const move = (moveEvent: PointerEvent) => {
      const delta = settings.dock === 'left' ? moveEvent.clientX - startX : startX - moveEvent.clientX;
      resizedWidth = Math.min(900, Math.max(320, startWidth + delta));
      dock?.setAttribute('data-resizing', 'true');
      if (dock !== null) {
        dock.style.flexBasis = `min(${resizedWidth}px, 100vw)`;
        dock.style.inlineSize = `min(${resizedWidth}px, 100vw)`;
      }
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      dock?.removeAttribute('data-resizing');
      try { target.releasePointerCapture(event.pointerId); } catch { /* 指针已经松开 */ }
      applyWorkbenchState({ ...workbenchRef.current, rightWidth: Math.round(resizedWidth) });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
  }, [applyWorkbenchState, settings.dock, settings.workbench.rightWidth]);
  const startBottomResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const startY = event.clientY;
    const startHeight = settings.workbench.bottomHeight;
    const target = event.currentTarget;
    const panel = target.closest<HTMLElement>('.bottom-workbench');
    event.preventDefault();
    try { target.setPointerCapture(event.pointerId); } catch { /* 全局监听仍可完成拖动 */ }
    const move = (moveEvent: PointerEvent) => {
      const maximum = Math.max(160, Math.min(680, window.innerHeight - 260));
      const height = `${Math.min(maximum, Math.max(160, startHeight + startY - moveEvent.clientY))}px`;
      if (panel !== null) {
        panel.setAttribute('data-resizing', 'true');
        panel.style.flexBasis = height;
        panel.style.height = height;
      }
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      panel?.removeAttribute('data-resizing');
      try { target.releasePointerCapture(event.pointerId); } catch { /* 指针已经松开 */ }
      const raw = Number.parseFloat(panel?.style.height ?? '');
      if (Number.isFinite(raw)) applyWorkbenchState({ ...workbenchRef.current, bottomHeight: Math.round(raw) });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
  }, [applyWorkbenchState, settings.workbench.bottomHeight]);
  useEffect(() => {
    let live = true;
    setSettingsReady(false);
    setPrefsFailure(null);
    setPrefsDetails('');
    const settled = loadSettings(client).then(
      (adopted) => {
        if (!live) return;
        const workbench = workbenchEditRevision.current > 0 ? workbenchRef.current : adopted.workbench;
        workbenchRef.current = workbench;
        setSettings({ ...adopted, workbench });
        saveWarned.current = false;
        setSettingsReady(true);
      },
      (error) => {
        if (live) {
          setPrefsFailure(code(error));
          setPrefsDetails(error instanceof Error ? error.message : String(error));
        }
        throw error;
      },
    );
    // 读取失败显示在横幅中；会话恢复也等待此结果，避免用缓存覆盖正式偏好。
    void settled.catch(() => undefined);
    prefsSettled.current = settled;
    return () => {
      live = false;
    };
  }, [client, prefsRevision]);

  // 每秒更新当前会话的运行时长。
  useEffect(() => {
    if (runningIds.length === 0) return;
    const timer = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [runningIds]);

  // 每三秒通过只读状态请求检查连接；请求失败时由界面发起一次重连。
  // Host 进程的启动和重启由 Electron 壳负责。
  const beat = useCallback(async (timeoutMs = 5_000) => {
    if (sessionId === null) return;
    const request: RequestIdentity = { scope: sessionId, generation: openRequest.current };
    const isCurrent = () => requestIsCurrent(request, active.current, openRequest.current);
    try {
      if (readOnlySessionId === sessionId) {
        await client.call('session.observe', { projectRoot, sessionId, limit: 1 }, timeoutMs);
      } else await client.call('status.get', { sessionId }, timeoutMs);
      if (!isCurrent()) return;
      connectionLost.current = false;
      setLink(null);
    } catch (error) {
      if (!isCurrent()) return;
      if (!connectionLost.current) notify('disconnected');
      connectionLost.current = true;
      setLink(code(error));
    }
  }, [client, notify, projectRoot, readOnlySessionId, sessionId]);

  useEffect(() => {
    const removeFault = transport.onFault?.((reason) => {
      setLink(reason);
      if (!connectionLost.current) notify('disconnected');
      connectionLost.current = true;
    });
    const timer = sessionId === null ? undefined : setInterval(() => void beat(), 3_000);
    return () => { if (timer !== undefined) clearInterval(timer); if (typeof removeFault === 'function') removeFault(); };
  }, [beat, notify, sessionId, transport]);

  const jumpToLatest = useCallback(() => {
    readerScrolling.current = false;
    list.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior: 'smooth' });
    setPinned(true);
  }, []);

  // 更早的记录由 Host 分页读取；游标采用当前页最早事件的稳定序号。
  const showEarlier = useCallback(async () => {
    if (sessionId === null || page === null || !page.hasMore || olderLoading) return;
    const request = openRequest.current;
    let restoring = false;
    readerScrolling.current = false;
    setPinned(false);
    setOlderLoading(true);
    try {
      const observing = readOnlySessionId === sessionId;
      const older = await client.call(observing ? 'session.observe' : 'session.read', {
        ...(observing ? { projectRoot } : {}),
        sessionId, before: page.before, limit: RENDER_WINDOW, fullResults: true,
      }, 15_000) as { events: Record_[]; hasMore: boolean };
      // 用户已切换会话时忽略过期响应，不更改新会话的列表和游标。
      if (opening.current !== sessionId || openRequest.current !== request) return;
      const added = older.events.flatMap((record) => projectRecord(record));
      const rendered = renderedStream.current;
      const addedShown = added.filter((row) => shownIn(rendered.verbosity, row)).length;
      const anchor = addedShown === 0 ? null : streamAnchor(rendered.rows, rendered.firstIndex);
      prependAnchor.current = anchor === null ? null : { ...anchor, request };
      restoring = anchor !== null;
      // 前插一页时按实际加入 `visible` 的行数调整全局起始索引，保持视口锚点不变。
      setFirstIndex((current) => current - addedShown);
      setRows((current) => [...added, ...current]);
      setPage({ before: older.events.length === 0 ? page.before : Number(older.events[0]?.seq), hasMore: older.hasMore });
    } catch (error) {
      if (openRequest.current === request) setRows((current) => [...current, metaRow('error', `无法读取更早的记录：${code(error)}`, `Could not load earlier records: ${code(error)}`)]);
    } finally {
      if (!restoring && openRequest.current === request) setOlderLoading(false);
    }
  }, [client, olderLoading, page, projectRoot, readOnlySessionId, sessionId]);

  // 草稿和队列按项目与会话保存到 Host 管理的偏好文档；WebView 存储只用于首屏缓存。
  // 切换会话、打开设置、查看历史或断连时保留输入。保存失败时明确提示用户。
  const persistInputs = useCallback(async () => {
    if (!settingsReady) throw Object.assign(new Error('prefs_reload_required'), { code: 'prefs_reload_required' });
    const draftId = sessionId ?? '$new';
    const remember = (root: string, id: string, value: { draft?: string; items?: string[] }) => {
      const key = JSON.stringify([root, id]);
      if (value.draft !== undefined && draftRevisions.current.get(key)?.text !== value.draft) return;
      unsavedInputs.current.set(key, { ...unsavedInputs.current.get(key), root, id, ...value });
    };
    if (inputOwner === sessionId) remember(projectRoot, draftId, { draft });
    for (const [id, queue] of Object.entries(queues)) {
      const root = notificationSessions.current.get(id)?.root;
      if (root !== undefined) remember(root, id, { items: queue.items });
    }
    // 重新读取会替换缓存；读取失败时保留内存中其他会话尚未保存的输入。
    const pending = new Map(unsavedInputs.current);
    // 草稿为空且队列已发完时删除该会话的偏好条目。
    const put = <T extends { length: number }>(table: Record<string, Record<string, T>>, root: string, id: string, value: T): Record<string, Record<string, T>> => {
      const row = { ...(table[root] ?? {}) };
      if (value.length === 0) delete row[id];
      else row[id] = value;
      const next = { ...table };
      if (Object.keys(row).length === 0) delete next[root];
      else next[root] = row;
      return next;
    };
    await updateSettings(client, stored => {
      let drafts = stored.drafts;
      let queued = stored.queued;
      for (const input of pending.values()) {
        if (input.draft !== undefined) drafts = put(drafts, input.root, input.id, input.draft);
        if (input.items !== undefined) queued = put(queued, input.root, input.id, input.items);
      }
      return { ...stored, ...settings, drafts, queued };
    });
    for (const [key, input] of pending) {
      if (unsavedInputs.current.get(key) === input) unsavedInputs.current.delete(key);
    }
  }, [client, draft, inputOwner, projectRoot, queues, sessionId, settings, settingsReady]);

  useEffect(() => {
    if (!settingsReady || inputOwner !== sessionId || quitting.current) return;
    void persistInputs().catch((error) => {
      setSettingsReady(false);
      setPrefsFailure(code(error));
      setPrefsDetails(error instanceof Error ? error.message : String(error));
      if (saveWarned.current) return;
      saveWarned.current = true;
      setRows((current) => [...current, metaRow('error', '草稿未能保存。请重试，或先复制内容。', 'Could not save the draft. Try again or copy its contents first.')]);
    });
  }, [inputOwner, persistInputs, sessionId, settingsReady]);

  // 将配色、字号和侧栏宽度写入根元素的 CSS 变量。
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.palette = settings.palette;
    root.style.setProperty('--sidebar', `${settings.sidebar}px`);
    root.style.setProperty('--ui-font-size', `${settings.fontUi}px`);
    root.style.setProperty('--user-message-font-size', `${settings.fontUser}px`);
    root.style.setProperty('--assistant-message-font-size', `${settings.fontAssistant}px`);
    root.style.setProperty('--transcript-line-height', String(settings.transcriptLineHeight));
  }, [settings.fontAssistant, settings.fontUi, settings.fontUser, settings.palette, settings.sidebar, settings.transcriptLineHeight]);

  const patch = useCallback((part: Partial<Settings>) => {
    if (part.collapsed !== undefined) setMobileSidebar(!part.collapsed);
    setSettings((current) => ({ ...current, ...part }));
  }, []);

  // 从偏好读取键位覆盖；先恢复默认，再应用有效覆盖，并报告无效项。
  const [keyNotice, setKeyNotice] = useState('');
  useEffect(() => {
    const outcome = loadBindings(settings.keys);
    setKeyNotice(outcome.refused.length === 0 ? ''
      : t(`${outcome.refused.length} 条快捷键无效，已使用默认键：${outcome.refused.join('、')}`, `${outcome.refused.length} invalid shortcuts use their defaults: ${outcome.refused.join(', ')}`));
  }, [settings.keys, t]);

  // 拖动分隔线调整侧栏宽度，范围与设置面板的滑杆一致。
  // 捕获指针后，即使光标移到转录区或侧栏外，拖动事件仍会送到此处。
  const startDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const startX = event.clientX;
    const startWidth = settings.sidebar;
    const target = event.currentTarget;
    try { target.setPointerCapture(event.pointerId); } catch { /* 抓不住时窗口上那三条监听照样把移动与松开送到这一处 */ }
    const move = (moveEvent: PointerEvent) => {
      patch({ sidebar: Math.min(420, Math.max(264, startWidth + moveEvent.clientX - startX)) });
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      try { target.releasePointerCapture(event.pointerId); } catch { /* 已经松开 */ }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
  }, [patch, settings.sidebar]);

  useEffect(() => {
    const stopNotifications = client.onNotification((message) => {
      if (message.notify === 'fault') {
        setRows((current) => [...current, metaRow('error', `连接错误：${message.code} ${message.detail ?? ''}`, `Connection error: ${message.code} ${message.detail ?? ''}`)]);
        return;
      }
      if (message.notify === 'view.ready') {
        const pending = modelViewRequestRef.current;
        if (pending !== null && pending.requestId === message.requestId) {
          const ready = { ...pending, ready: true };
          modelViewRequestRef.current = ready;
          setModelViewRequest(ready);
        }
        return;
      }
      // 按会话保存流式片段，后台会话继续输出时也能在切回后立即显示已收到内容。
      const owner = message.sessionId ?? '';
      const inView = owner === active.current;
      if (message.notify === 'progress') {
        if (owner !== '') {
          setRunningIds(current => {
            const running = message.progress !== null && message.progress !== undefined;
            const present = current.includes(owner);
            if (running && !present) return [...current, owner];
            if (!running && present) return current.filter(id => id !== owner);
            return current;
          });
        }
        if (inView) {
          const progress = message.progress === null || message.progress === undefined
            ? null
            : message.progress as Status['progress'];
          setStatus((current) => current === null ? current : {
            ...current,
            running: progress !== null,
            progress,
            ...(progress?.task === undefined ? {} : { task: progress.task }),
          });
          if (progress?.task !== undefined) setTaskSnapshotAt(Date.now());
        }
        return;
      }
      if (message.notify === 'delta') {
        const event = message.event as { type?: string; text?: string } | undefined;
        const held = liveBySession.append(owner, event?.type ?? '', event?.text ?? '');
        if (held === null) return;
        if (inView) setLive(held);
        return;
      }
      if (message.notify === 'event') {
        const record = message.event as Record_;
        if (record?.kind === 'turn') {
          setRunningIds(current => current.filter(id => id !== owner));
          const previous = terminalBySession.current.get(owner);
          terminalBySession.current.set(owner, record.seq ?? -1);
          if (previous !== record.seq) {
            if (record.status === 'completed') notify('completed', owner);
            else if (record.status === 'failed' || record.status === 'interrupted') notify('failed', owner);
          }
        }
        // 记录事件写入后，以持久事件替换对应会话的流式片段。
        const held = liveBySession.settle(owner, record?.kind ?? '');
        if (inView) setLive(held);
        if (!inView) return;
        // 打开会话的读取尚未完成：先按序缓存，等快照替换页面后再逐条应用。
        const buffered = pendingRecords.current;
        if (buffered !== null) {
          buffered.push(record);
          return;
        }
        appendRecord(record);
      }
    });

    const stopRequests = client.onRequest((message) => {
      if (message.method === 'view.request') {
        const responseId = message.id;
        const params = message.params;
        const sessionOwner = params?.sessionId;
        const runId = params?.runId;
        const viewRequestId = params?.requestId;
        const target = modelViewTarget(params?.target);
        const reply = (status: 'sent' | 'view_unavailable') => {
          if (typeof responseId !== 'string') return;
          try { client.reply(responseId, { status, opened: false, read: false }); } catch { /* the Host connection may already be closed */ }
        };
        if (typeof responseId !== 'string' || typeof viewRequestId !== 'string'
          || !boundedString(sessionOwner, 160) || !boundedString(runId, 160)
          || target === undefined || active.current !== sessionOwner || modelViewRequestRef.current !== null) {
          reply('view_unavailable');
          return;
        }
        void client.call('status.get', { sessionId: sessionOwner }, 5_000).then(value => {
          const current = value as Status;
          if (active.current !== sessionOwner || current.running !== true || current.activeRunId !== runId
            || modelViewRequestRef.current !== null) {
            reply('view_unavailable');
            return;
          }
          const pending = { requestId: viewRequestId, sessionId: sessionOwner, runId, target, ready: false, opening: false };
          modelViewRequestRef.current = pending;
          setModelViewRequest(pending);
          reply('sent');
        }).catch(() => reply('view_unavailable'));
        return;
      }
      receiveInteraction(message, notify);
    });

    // 显示 Host 进程的标准错误输出；它不属于协议帧。
    transport.onLog((line) => setDiagnosticLogs((current) => [...current, line].slice(-50)));
    return () => {
      stopNotifications();
      stopRequests();
    };
  }, [client, notify, receiveInteraction, transport]);

  const refreshStatus = useCallback(async (id: string) => {
    const request: RequestIdentity = { scope: id, generation: openRequest.current };
    const isCurrent = () => requestIsCurrent(request, active.current, openRequest.current);
    try {
      const next = await client.call('status.get', { sessionId: id }) as Status;
      // 用户已切换会话时，不将该请求的响应写入当前会话状态。
      if (!isCurrent()) return;
      setStatus(next);
      setRunningIds(current => {
        const present = current.includes(id);
        if (next.running && !present) return [...current, id];
        if (!next.running && present) return current.filter(candidate => candidate !== id);
        return current;
      });
      setTaskSnapshotAt(Date.now());
    } catch (error) {
      if (isCurrent()) setRows((current) => [...current, metaRow('error', `无法读取状态：${code(error)}`, `Could not load status: ${code(error)}`)]);
    }
  }, [client]);

  // 切换会话时先通过 Host 打开记录；已打开的会话复用现有状态。
  // 指定搜索结果时一并读取到目标事件，并同时更新定位目标，避免列表扩展后视口短暂滚到末尾。
  // Host 重启后将暂停队列按顺序移回草稿，等待用户明确发送；普通切换会话时队列仍保持暂停。
  const openSession = useCallback(async (id: string, hit?: SearchHit, reclaimQueue = false, askedRoot?: string) => {
    const savedAnchor = anchors.current.get(id);
    opening.current = id;
    const request = ++openRequest.current;
    // 同步更新前台会话和打开状态，再读取会话状态，避免渲染提交后将有效响应误判为过期。
    active.current = id;
    setSessionId(id);
    // 会话进入前台后清除其未读完成标记。
    setUnread((current) => current.filter((item) => item !== id));
    setMobileSidebar(false);
    setRows([]);
    // 记录事件可能在快照返回前就已到达；先缓存，等快照落定后按序号再应用。
    pendingRecords.current = [];
    sessionWindow.reset(0);
    setPage(null);
    setOlderLoading(false);
    prependAnchor.current = null;
    setFirstIndex(FIRST_INDEX);
    setInitialIndex({ index: 'LAST', align: 'end' });
    readerScrolling.current = false;
    setPinned(true);
    // 切回会话时立即显示其尚未落盘的流式输出，避免正在运行的轮次暂时显示为空。
    setLive(liveBySession.read(id));
    setWanted(null);
    setInputOwner(null);
    setReadOnlySessionId(null);
    setSessionWriterActive(false);
    setExternalControlSessionId(null);
    setStatus(null);
    dispatchAt.current.clear();
    setReading(true);
    let observing = false;
    let writerLockHeld = false;
    let newest: {
      events: Record_[];
      hasMore: boolean;
      header: { projectRoot?: string } | null;
      label: { name: string; archived: boolean };
      writerActive?: boolean;
    };
    const requestedRoot = askedRoot === undefined || askedRoot === '' ? projectRoot : askedRoot;
    try {
      // 为记录读取设置超时，避免客户端一直停留在加载状态。
      // 指定项目时同时传递项目根目录，由 Host 选择对应环境并验证记录归属。
      try {
        await client.call('session.open', requestedRoot === '' ? { sessionId: id } : { sessionId: id, projectRoot: requestedRoot }, 60_000);
        // 请求完整工具结果以读取溢出文件内容；只读取最近一页，更早记录由分页操作加载。
        newest = await client.call('session.read', { sessionId: id, limit: RENDER_WINDOW, fullResults: true }, 60_000) as typeof newest;
      } catch (error) {
        if (code(error) !== 'session_locked') throw error;
        writerLockHeld = true;
        newest = await client.call('session.observe', {
          projectRoot: requestedRoot, sessionId: id, limit: RENDER_WINDOW, fullResults: true,
        }, 60_000) as typeof newest;
        observing = true;
      }
      if (openRequest.current !== request) return;
      // 打开会话时恢复其草稿和暂停队列。
      const root = newest.header?.projectRoot ?? '';
      notificationSessions.current.set(id, { root, name: newest.label.name });
      setSessionLabel(newest.label);
      setProjectRoot(root);
      // 等 Host 读取偏好完成后再恢复草稿和队列，避免使用过期缓存。
      await prefsSettled.current;
      if (openRequest.current !== request) return;
      const stored = readSettings();
      const unsaved = unsavedInputs.current.get(JSON.stringify([root, id]));
      const storedDraft = unsaved?.draft ?? stored.drafts[root]?.[id] ?? '';
      const restored = unsaved?.items ?? stored.queued[root]?.[id] ?? [];
      if (observing) {
        setDraft('', null);
      } else if (reclaimQueue && restored.length > 0) {
        // 重连后将队列按顺序移回草稿并清空队列，不自动发送任何内容。
        setDraft(mergeQueueIntoDraft(storedDraft, restored), { root, id });
        patchQueue(id, () => ({ items: [], paused: false }));
      } else {
        setDraft(storedDraft, { root, id });
        patchQueue(id, () => ({ items: restored, paused: restored.length > 0 }));
      }
      setReadOnlySessionId(observing ? id : null);
      setSessionWriterActive(observing && newest.writerActive === true);
      setInputOwner(observing ? null : id);
      setSettings((current) => ({ ...current, lastSession: { id, projectRoot: root } }));
      let events = newest.events;
      let hasMore = newest.hasMore;
      while (hit !== undefined && hit.seq < Number(events[0]?.seq ?? 0) && hasMore) {
        const older = await client.call(observing ? 'session.observe' : 'session.read', {
          ...(observing ? { projectRoot: root } : {}),
          sessionId: id, before: Number(events[0]?.seq), limit: RENDER_WINDOW, fullResults: true,
        }, 15_000) as { events: Record_[]; hasMore: boolean };
        // 用户已切换会话时忽略过期响应，不更新当前页面。
        if (openRequest.current !== request) return;
        if (older.events.length === 0) { hasMore = false; break; }
        events = [...older.events, ...events];
        hasMore = older.hasMore;
      }
      if (openRequest.current !== request) return;
      setWriterLockNoticeSessionId(writerLockHeld && reclaimQueue ? id : null);
      // 将后台会话中已关闭问题卡片的题目和答案写入该会话记录。
      const kept = takeEchoes(id);
      setRows([
        ...events.flatMap((record) => projectRecord(record)),
        ...kept.map((line) => metaRow('meta', line.zh, line.en)),
      ]);
      connectionLost.current = false;
      setLink(null);
      setPage({ before: Number(events[0]?.seq ?? 1), hasMore });
      // 快照已覆盖读取期间到达的记录；只把其中更新的记录接到末尾，重复的直接丢弃。
      sessionWindow.reset(Number(events.at(-1)?.seq ?? 0));
      const buffered = pendingRecords.current;
      pendingRecords.current = null;
      if (buffered !== null) {
        let missing = 0;
        for (const record of buffered) {
          const decision = sessionWindow.incoming(record);
          if (decision.apply) { appendRecord(record); continue; }
          if (decision.reason === 'gap') { missing = decision.missingFrom; break; }
        }
        if (missing > 0) {
          // 中间记录没有送达：从最新窗口往回补读，直到覆盖缺口或用完更早的记录。
          try {
            const collected = new Map<number, Record_>();
            const remember = (events: Record_[]) => {
              for (const event of events) {
                const seq = Number(event.seq);
                if (Number.isSafeInteger(seq)) collected.set(seq, event);
              }
            };
            let page = await client.call(observing ? 'session.observe' : 'session.read', {
              ...(observing ? { projectRoot: root } : {}),
              sessionId: id, limit: RENDER_WINDOW, fullResults: true,
            }, 15_000) as { events: Record_[]; hasMore: boolean };
            if (openRequest.current !== request) return false;
            remember(page.events);
            let older = olderRecoveryPage(page, missing);
            for (let reads = 0; older !== null && reads < 8; reads += 1) {
              const previous = await client.call(observing ? 'session.observe' : 'session.read', {
                ...(observing ? { projectRoot: root } : {}),
                sessionId: id, before: older.before, limit: RENDER_WINDOW, fullResults: true,
              }, 15_000) as { events: Record_[]; hasMore: boolean };
              if (openRequest.current !== request) return false;
              remember(previous.events);
              older = olderRecoveryPage(previous, missing);
            }
            const ordered = [...collected.values()].sort((left, right) => Number(left.seq) - Number(right.seq));
            for (const record of sessionWindow.adopt(ordered)) appendRecord(record);
            const head = Number(buffered.at(-1)?.seq);
            if (Number.isSafeInteger(head) && head > sessionWindow.loadedThrough) {
              // 缺口早于可恢复窗口：如实说明，不把不连续的记录当成完整视图。
              const skipped = head - sessionWindow.loadedThrough;
              setRows((current) => [...current, metaRow('meta', `有 ${skipped} 条更早的记录未能读取（已超出可恢复窗口）。`, `${skipped} earlier record(s) could not be read (outside the recoverable window).`)]);
            }
          } catch { /* 传输已断开时由重新连接流程统一处理 */ }
        }
      }
      // 如果保存的阅读位置仍在已加载页面中就恢复该位置；否则停在末尾，不改变展示档或自动加载更多页面。
      const back = savedAnchor !== undefined && savedAnchor > Number(events[0]?.seq) && savedAnchor < Number(events.at(-1)?.seq)
        ? { sessionId: id, seq: savedAnchor, kind: 'anchor' }
        : null;
      setWanted(hit ?? back);
    } catch (error) {
      // 忽略旧请求的失败，避免将过期错误显示在当前会话中。
      pendingRecords.current = null;
      if (openRequest.current === request) setRows((current) => [...current, metaRow('error', `无法打开会话：${code(error)}`, `Could not open conversation: ${code(error)}`)]);
      return false;
    } finally {
      // 只有当前打开请求完成后才解除输入保护，避免旧请求提前解锁新请求。
      if (openRequest.current === request) setReading(false);
    }
    if (openRequest.current !== request) return;
    if (!observing) void refreshStatus(id);
    return true;
  }, [client, projectRoot, refreshStatus, takeEchoes]);

  // Side chat 的选区捕获、确认框与创建流程由 use-side-chat 持有；App 只传入当前会话与打开方式。
  const sideChat = useSideChat({
    client, sessionId, projectRoot, status, openSession, openSideSessionResource, registerSideSessionResource, saveBackgroundDraft, setDraft,
  });

  const sendSideConclusion = useCallback(async (sourceSessionId: string, sourceRunId: string, text: string, root: string) => {
    await client.call('session.open', { sessionId: sourceSessionId, projectRoot: root }, 15_000);
    const source = await client.call('status.get', { sessionId: sourceSessionId }, 15_000) as Status;
    if (source.running !== true || source.activeRunId !== sourceRunId) {
      throw Object.assign(new Error('side_chat_origin_run_stale'), { code: 'side_chat_origin_run_stale' });
    }
    try {
      await client.call('run.steer', { sessionId: sourceSessionId, runId: sourceRunId, input: text }, 15_000);
    } catch (error) {
      const failure = code(error);
      if (['run_not_running', 'run_steering_run_mismatch', 'run_steering_target_changed'].includes(failure)) {
        throw Object.assign(new Error('side_chat_origin_run_stale'), { code: 'side_chat_origin_run_stale' });
      }
      throw error;
    }
  }, [client]);

  const prepareSideFollowup = useCallback(async (sourceSessionId: string, text: string, root: string) => {
    await client.call('session.open', { sessionId: sourceSessionId, projectRoot: root }, 15_000);
    const source = await client.call('status.get', { sessionId: sourceSessionId }, 15_000) as Status;
    if (source.running === true || source.activeRunId !== null) {
      throw Object.assign(new Error('side_chat_origin_run_stale'), { code: 'side_chat_origin_run_stale' });
    }
    const preferences = await client.call('prefs.read', {}, 15_000);
    const storedDrafts = (preferences.settings as Partial<Settings> | undefined)?.drafts ?? readSettings().drafts;
    const storedRoot = Object.keys(storedDrafts).find(candidate => sameProjectRoot(candidate, root));
    const canonicalRoot = storedRoot ?? root;
    const key = JSON.stringify([canonicalRoot, sourceSessionId]);
    const unsavedEntry = [...unsavedInputs.current.entries()].find(([, value]) => value.id === sourceSessionId
      && sameProjectRoot(value.root, root));
    const localDraft = draftRevisions.current.get(unsavedEntry?.[0] ?? key)?.text ?? unsavedEntry?.[1].draft;
    const storedDraft = storedRoot === undefined ? '' : storedDrafts[storedRoot]?.[sourceSessionId] ?? '';
    const sourceDraft = localDraft !== undefined && localDraft !== '' ? localDraft : storedDraft || localDraft || '';
    if (root === '' || await openSession(sourceSessionId, undefined, false, root) !== true) {
      throw Object.assign(new Error('side_chat_origin_session_unavailable'), { code: 'side_chat_origin_session_unavailable' });
    }
    setDraft(sourceDraft === '' ? text : `${sourceDraft}\n\n${text}`, { root: canonicalRoot, id: sourceSessionId });
  }, [client, openSession, setDraft]);

  useEffect(() => {
    if (sessionId === null || readOnlySessionId !== sessionId) return;
    const request = openRequest.current;
    return observeExternalSession({
      client,
      projectRoot,
      sessionId,
      limit: RENDER_WINDOW,
      isCurrent: () => openRequest.current === request && active.current === sessionId,
      onSnapshot: (snapshot) => {
        setSessionWriterActive(snapshot.writerActive);
        if (!snapshot.writerActive) setExternalControlSessionId(null);
        setRows((current) => appendProjectedRecords(current, snapshot.events));
      },
    });
  }, [client, projectRoot, readOnlySessionId, sessionId]);

  useEffect(() => {
    if (notificationDestination === null || settingsOpen) return;
    const target = notificationDestination;
    setNotificationDestination(null);
    leaveDock(() => {
      applyWorkbenchState({ ...workbenchRef.current, rightOpen: false });
      setPaletteOpen(false);
      void openSession(target.sessionId, undefined, false, target.projectRoot);
    });
  }, [applyWorkbenchState, leaveDock, notificationDestination, openSession, settingsOpen]);


  const newSession = useCallback(async (root?: string) => {
    const request = ++openRequest.current;
    setNewSessionSettingsRevision((revision) => revision + 1);
    setSessionMenuOpen(false);
    prependAnchor.current = null;
    setOlderLoading(false);
    setInitialIndex({ index: 'LAST', align: 'end' });
    readerScrolling.current = false;
    setPinned(true);
    setReading(true);
    try {
      // 优先使用明确选择的工作区；否则沿用当前会话的项目，再使用登记的默认工作区。
      // 尚无默认工作区时请 Electron 壳创建并登记一个，同时记录选择来源。
      const named = root === undefined || root === '' ? undefined : root;
      const current = undefined;
      let landing: string | undefined;
      let refused: string | undefined;
      if (named === undefined && current === undefined) {
        landing = await defaultWorkspaceOf(client);
        if (landing === undefined && transport.defaultWorkspace !== undefined) {
          const fromShell = await registerShellWorkspace(transport.defaultWorkspace, client);
          landing = fromShell.directory;
          refused = fromShell.failed;
        }
      }
      if (named === undefined && current === undefined && landing === undefined && transport.defaultWorkspace !== undefined) {
        throw Object.assign(new Error(refused ?? 'workspace_unavailable'), { code: 'workspace_unavailable' });
      }
      const params = createCallOf(named, current, landing);
      await prefsSettled.current;
      if (openRequest.current !== request) return false;
      newParameters.current = params;
      setNewSessionMode(null);
      setNewSessionPolicy(null);
      setNewSessionPermission(DEFAULT_NEW_SESSION_PERMISSION);
      setNewSessionPermissionConfirmations(NO_PERMISSION_CONFIRMATIONS);
      opening.current = null;
      active.current = null;
      setMobileSidebar(false);
      setSessionId(null);
      setSessionLabel({ name: '', archived: false });
      setInputOwner(null);
      setProjectRoot(params.projectRoot ?? '');
      setRows([]);
      setStatus(null);
      setLive({ text: '', reasoning: '' });
      setPage(null);
      setWanted(null);
      const draftOwner = { root: params.projectRoot ?? '', id: '$new' };
      setDraft(unsavedInputs.current.get(JSON.stringify([draftOwner.root, draftOwner.id]))?.draft
        ?? readSettings().drafts[draftOwner.root]?.[draftOwner.id] ?? '', draftOwner);
      setWalk(-1);
      setSettings((current) => ({ ...current, lastSession: null }));
      composerRef.current?.focus();
      return true;
    } catch (error) {
      setRows((current) => [...current, metaRow('error', `无法新建会话：${code(error)}`, `Could not create a conversation: ${code(error)}`)]);
      return false;
    } finally {
      if (openRequest.current === request) setReading(false);
    }
  }, [client, transport]);

  useEffect(() => {
    if (!settingsReady || booted.current) return;
    booted.current = true;
    const last = settings.lastSession;
    if (last !== null) void openSession(last.id, undefined, false, last.projectRoot);
    else void newSession();
  }, [settingsReady, settings.lastSession, newSession, openSession]);

  // 搜索命中交给会话打开流程处理，使读取到目标记录与定位操作同步完成。
  const openHit = useCallback((hit: SearchHit, root?: string) => void openSession(hit.sessionId, hit, false, root), [openSession]);

  // 从当前位置或指定轮次创建分支；省略 `at` 时复制当前完整记录。父会话保持不变。
  const branchFrom = useCallback(async (at?: number) => {
    if (sessionId === null) return;
    try {
      const branched = await client.call('session.branch', { sessionId, ...(at === undefined ? {} : { at }) }, 15_000);
      await openSession(branched.sessionId);
      setSessionsRevision((current) => current + 1);
      setRows((current) => [...current, metaRow('meta', `已从第 ${branched.at} 条创建分支 ${branched.sessionId.slice(0, 8)}。`, `Created branch ${branched.sessionId.slice(0, 8)} through event ${branched.at}.`)]);
    } catch (error) {
      setRows((current) => [...current, metaRow('error', `创建分支失败：${code(error)}`, `Could not create branch: ${code(error)}`)]);
    }
  }, [client, openSession, sessionId]);

  // 重连时将旧请求以稳定错误码结束并清除待答请求，然后让 Electron 壳重启 Host。
  // 新 Host 通过 `session.open` 恢复当前会话，并将暂停队列移回草稿，不自动发送。
  const reconnect = useCallback(async () => {
    if (reconnecting.current) return;
    const request: RequestIdentity = { scope: sessionId, generation: openRequest.current };
    const isCurrent = () => requestIsCurrent(request, active.current, openRequest.current);
    reconnecting.current = true;
    client.discard('host_restarted');
    resetInteractions();
    setRunningIds([]);
    try {
      try {
        await transport.restart?.();
      } catch (error) {
        if (isCurrent()) setRows((current) => [...current, metaRow('error', `无法启动后端：${code(error)}`, `Could not start the host: ${code(error)}`)]);
        return;
      }
      setHostRevision(current => current + 1);
      // Host restart invalidates an in-flight preference write. Reload its version and saved values
      // before restoring the Session so a failed write does not leave the composer read-only.
      setSettingsReady(false);
      setPrefsFailure(null);
      setPrefsDetails('');
      const refreshedPreferences = loadSettings(client).then(
        (adopted) => {
          const workbench = workbenchEditRevision.current > 0 ? workbenchRef.current : adopted.workbench;
          workbenchRef.current = workbench;
          setSettings({ ...adopted, workbench });
          saveWarned.current = false;
          setSettingsReady(true);
        },
        (error) => {
          setPrefsFailure(code(error));
          setPrefsDetails(error instanceof Error ? error.message : String(error));
        },
      );
      prefsSettled.current = refreshedPreferences;
      await refreshedPreferences;
      if (!isCurrent()) return;
      if (sessionId !== null) {
        // Host 被强制结束后，记录锁可能要等租约过期；重试预算比租约略长，仍拿不到就明确提示。
        await reopenSessionWriter({
          open: () => client.call('session.open', projectRoot === '' ? { sessionId } : { sessionId, projectRoot }, 60_000).then(() => undefined),
          code,
          isLocked: (failure) => failure === 'session_locked',
          now: () => Date.now(),
          sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
          budgetMs: 15_000,
          isCurrent,
        });
        if (!isCurrent()) return;
        await openSession(sessionId, undefined, true);
      } else {
        try {
          await client.call('workspaces.list', {}, 60_000);
          if (!isCurrent()) return;
          connectionLost.current = false;
          setLink(null);
          setSessionsRevision((current) => current + 1);
        } catch (error) {
          if (!isCurrent()) return;
          setLink(code(error));
          setRows((current) => [...current, metaRow('error', `无法重新连接后端：${code(error)}`, `Could not reconnect to the host: ${code(error)}`)]);
        }
      }
    } finally {
      // 所有重连结果都要清除重连状态，避免后续无法再次重连或恢复队列。
      reconnecting.current = false;
    }
  }, [client, openSession, projectRoot, resetInteractions, sessionId, setRunningIds, transport]);

  const readBack = useCallback(async () => {
    if (sessionId === null) return;
    await openSession(sessionId);
  }, [sessionId, openSession]);

  // 按输入所属会话处理输入和轮次结束状态；后台结果不改变当前会话的队列。
  const submit = useCallback(async (text: string, own = sessionId) => {
    if (quitting.current || text === '' || own === null || readOnlySessionId === own) return;
    const inView = () => active.current === own;
    // 会话运行期间的输入加入前端队列，轮次结束后按顺序发送，不写入会话记录。
    if (runningIds.includes(own)) {
      if (inView()) { setDraft(''); setWalk(-1); }
      patchQueue(own, (current) => ({ ...current, items: [...current.items, text] }));
      return;
    }
    if (inView()) { setDraft(''); setWalk(-1); }
    // 发送成功后由 Host 更新共享输入历史，界面采用其返回结果。
    // 历史写入失败时保留本地输入历史，且不阻止消息发送。
    void client.call('history.append', { text }, 15_000).then(
      (written) => setHistory((written as { entries: string[] }).entries),
      () => setHistory((current) => [text, ...current.filter((item) => item !== text)]),
    );
    roundStart.current.set(own, Date.now());
    setTick(Date.now());
    setRunningIds((current) => [...current, own]);
    const previousTerminal = terminalBySession.current.get(own);
    try {
      await client.call('run.start', { sessionId: own, input: text });
    } catch (error) {
      const stopped = code(error);
      // 根据取消发生位置返回不同错误码：模型请求中为 `provider_cancelled`，调用组之间为 `loop_cancelled`，等待用户答复时为 `ask_user_cancelled`。
      const cancelled = stopped === 'loop_cancelled' || stopped === 'provider_cancelled' || stopped === 'ask_user_cancelled';
      // Host 尚未接受的输入没有写入记录，因此恢复到草稿并等待用户重发。
      // Host 接受后发生的失败不在此列，因为输入已经保存在会话记录中。
      if (inView() && (stopped === 'host_unanswered' || stopped === 'host_closed' || stopped === 'host_restarted')) setDraft((current) => mergeQueueIntoDraft(current, [text]));
      if (inView() && terminalBySession.current.get(own) === previousTerminal) setRows((current) => [...current, metaRow(cancelled ? 'meta' : 'error', cancelled ? '本轮已取消' : `无法开始本轮：${stopped}`, cancelled ? 'Turn cancelled' : `Could not start the turn: ${stopped}`)]);
      if (cancelled) patchQueue(own, (current) => ({ ...current, paused: true }));
      else if (terminalBySession.current.get(own) === previousTerminal) notify('failed', own);
    } finally {
      setRunningIds((current) => current.filter((id) => id !== own));
      roundStart.current.delete(own);
      // 轮次结束后 Host 会拒绝未答审批；移除界面中的待答卡片并说明原因。
      const left = outstandingApprovals(own);
      if (left > 0 && inView()) {
        setRows((current) => [...current, metaRow('meta', `本轮结束时有 ${left} 个问题未回答，已按未允许处理。`, `${left} unanswered question(s) were closed as refused when the turn ended.`)]);
      }
      dropAsksOf(own);
      // 轮次结束后移除该会话的待答问题卡片，避免旧请求阻挡其他会话或接受过期答复。
      dropQueriesOf(own, '这一轮已经收尾');
      // 轮次结束后移除该会话的流式片段；最终内容由已落盘记录提供。
      liveBySession.clear(own);
      if (inView()) setLive({ text: '', reasoning: '' });
      // 只有该会话自己的轮次结束后才继续发送其队列；其他会话结束不会触发发送。
      allowSend.current.add(own);
      // 后台会话结束时标记为有未读结果，切回时再清除。
      if (!inView()) setUnread((current) => [...new Set([...current, own])]);
      void refreshStatus(own);
    }
  }, [client, dropAsksOf, dropQueriesOf, notify, outstandingApprovals, patchQueue, readOnlySessionId, refreshStatus, runningIds, sessionId, t]);

  // 轮次结束后每次只发送队首一条。队列暂停时不发送，等待用户明确继续。
  // 连接断开或正在重连时不发送，避免将输入交给已退出的 Host。
  // 只有前台会话的队列可以自动继续；后台会话需切回前台或由用户显式继续。
  useEffect(() => {
    // 与 `send` 使用相同的会话归属检查；草稿归属同步前不发送队列。
    if (quitting.current || reading || inputOwner !== sessionId) return;
    if (running || link !== null || reconnecting.current || sessionId === null) return;
    if (!allowSend.current.has(sessionId)) return;
    const own = queues[sessionId];
    if (own === undefined || own.paused || own.items.length === 0) return;
    const [next, ...rest] = own.items;
    allowSend.current.delete(sessionId);
    patchQueue(sessionId, () => ({ items: rest, paused: false }));
    void submit(next, sessionId);
  }, [inputOwner, link, patchQueue, queues, reading, running, sessionId, submit]);

  // 将队列项收回草稿；草稿已有内容时保留原文，不拼接两段输入。
  const recoverQueueItem = useCallback((index: number, all: boolean) => {
    if (sessionId === null || draft !== '') return;
    const own = queues[sessionId] ?? { items: [], paused: false };
    if (own.items.length === 0) return;
    const recovered = all ? own.items.join('\n\n') : own.items[index] ?? '';
    if (recovered === '') return;
    setDraft(recovered);
    setWalk(-1);
    patchQueue(sessionId, all
      ? () => ({ items: [], paused: false })
      : (current) => ({ ...current, items: current.items.filter((_, at) => at !== index) }));
  }, [draft, patchQueue, queues, sessionId]);

  // 打开新会话时，输入区域保持只读，直到会话 ID、草稿和归属信息同步完成。
  // 避免将旧会话草稿写入新会话，也避免恢复草稿时覆盖用户刚输入的内容。
  const send = useCallback(async () => {
    const text = draft.trim();
    if (quitting.current || reading || creating.current || !settingsReady || inputOwner !== sessionId || text === '') return;
    if (sessionId !== null) {
      await submit(text);
      return;
    }
    setStarting(true);
    creating.current = true;
    const request = openRequest.current;
    let draftOwner = { root: newParameters.current.projectRoot ?? projectRoot, id: '$new' };
    try {
      const hasPermissionOverride = newSessionPermission.profile !== DEFAULT_NEW_SESSION_PERMISSION.profile
        || newSessionPermission.network !== DEFAULT_NEW_SESSION_PERMISSION.network;
      const createParameters = {
        ...newParameters.current,
        ...(newSessionMode === null ? {} : { initialMode: newSessionMode }),
        ...(newSessionPolicy === null ? {} : { initialPolicy: newSessionPolicy }),
        ...(hasPermissionOverride ? {
          initialPermissionProfile: newSessionPermission.profile,
          initialPermissionNetwork: newSessionPermission.network,
          confirmInitialFullAccess: newSessionPermissionConfirmations.fullAccess,
          confirmInitialNetwork: newSessionPermissionConfirmations.network,
          confirmInitialPartialWorkspaceWrite: newSessionPermissionConfirmations.partialWorkspaceWrite,
          confirmInitialWorkspaceTrust: newSessionPermissionConfirmations.workspaceTrust,
        } : {}),
      };
      const created = await client.call('session.create', createParameters, 15_000) as { sessionId: string };
      if (openRequest.current !== request) return;
      const selection = settings.newSelections[projectRoot];
      if (selection !== undefined) await client.call('model.select', { sessionId: created.sessionId, ...selection }, 15_000);
      await client.call('session.label', { sessionId: created.sessionId, name: text.split('\n')[0].replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120) || t('新会话', 'New conversation') }, 15_000);
      const opened = await openSession(created.sessionId, undefined, false, newParameters.current.projectRoot);
      if (active.current !== created.sessionId) return;
      if (opened !== true) throw Object.assign(new Error('session_open_failed'), { code: 'session_open_failed' });
      draftOwner = { root: newParameters.current.projectRoot ?? projectRoot, id: created.sessionId };
      const cached = readSettings();
      const drafts = { ...cached.drafts };
      const atRoot = { ...(drafts[projectRoot] ?? {}) };
      delete atRoot.$new;
      drafts[projectRoot] = atRoot;
      const next = { ...cached, workbench: workbenchRef.current, drafts, lastSession: { id: created.sessionId, projectRoot } };
      await saveSettings(client, next);
      unsavedInputs.current.delete(JSON.stringify([projectRoot, '$new']));
      workbenchRef.current = next.workbench;
      setSettings(next);
      setSessionsRevision((current) => current + 1);
      void submit(text, created.sessionId);
    } catch (error) {
      setDraft(text, draftOwner);
      setRows((current) => [...current, metaRow('error', `无法开始会话：${code(error)}`, `Could not start conversation: ${code(error)}`)]);
    } finally {
      creating.current = false;
      setStarting(false);
    }
  }, [client, draft, inputOwner, newSessionMode, newSessionPermission, newSessionPermissionConfirmations, newSessionPolicy, openSession, projectRoot, reading, sessionId, settings.newSelections, settingsReady, setDraft, submit, t]);

  const steer = useCallback(async () => {
    const own = sessionId;
    const text = draft;
    if (quitting.current || reading || own === null || readOnlySessionId === own || inputOwner !== own
      || !runningIds.includes(own) || text.trim() === '') return;
    const draftKey = JSON.stringify([projectRoot, own]);
    if (draftRevisions.current.get(draftKey)?.text !== text) {
      draftRevisions.current = updateSessionDraftRevision(draftRevisions.current, draftKey, text);
      unsavedInputs.current.set(draftKey, {
        ...unsavedInputs.current.get(draftKey), root: projectRoot, id: own, draft: text,
      });
    }
    const submittedRevision = sessionDraftRevisionFor(draftRevisions.current, draftKey);
    const inView = () => active.current === own;
    try {
      const current = await client.call('status.get', { sessionId: own }, 10_000) as Status;
      if (typeof current.activeRunId !== 'string' || current.activeRunId === '') {
        throw Object.assign(new Error('run_not_running'), { code: 'run_not_running' });
      }
      const accepted = await client.call('run.steer', {
        sessionId: own, runId: current.activeRunId, input: text,
      }, 15_000) as { pendingCount: number; cancelledInteractions: number };
      void client.call('history.append', { text }, 15_000).then(
        (written) => setHistory((written as { entries: string[] }).entries),
        () => setHistory((entries) => [text, ...entries.filter((item) => item !== text)]),
      );
      const currentRevisions = draftRevisions.current;
      const clearedRevisions = clearSessionDraftIfCurrent(currentRevisions, draftKey, submittedRevision);
      if (clearedRevisions !== currentRevisions) {
        draftRevisions.current = clearedRevisions;
        const cached = unsavedInputs.current.get(draftKey);
        unsavedInputs.current.set(draftKey, { ...cached, root: projectRoot, id: own, draft: '' });
        setSettings((current) => {
          const drafts = { ...current.drafts };
          const projectDrafts = { ...(drafts[projectRoot] ?? {}) };
          delete projectDrafts[own];
          if (Object.keys(projectDrafts).length === 0) delete drafts[projectRoot];
          else drafts[projectRoot] = projectDrafts;
          return { ...current, drafts };
        });
        if (active.current === own && inputOwnerState.current === own && draftState.current === text) {
          setDraft('');
          setWalk(-1);
        }
      }
      if (inView()) {
        setRows((currentRows) => [...currentRows, metaRow('meta',
          `输入已加入当前运行，待应用 ${accepted.pendingCount} 条${accepted.cancelledInteractions > 0 ? `；已取消 ${accepted.cancelledInteractions} 个等待答复` : ''}`,
          `Input added to the active run; ${accepted.pendingCount} pending${accepted.cancelledInteractions > 0 ? `; cancelled ${accepted.cancelledInteractions} pending interactions` : ''}`)]);
      }
    } catch (error) {
      if (inView()) setRows((currentRows) => [...currentRows,
        metaRow('error', `当前运行未收到输入：${code(error)}`, `The active run did not receive the input: ${code(error)}`)]);
    }
  }, [client, draft, inputOwner, projectRoot, readOnlySessionId, reading, runningIds, sessionId, setDraft]);

  // `own` 指定取消目标会话；默认取消当前前台会话。
  const cancel = useCallback(async (own = sessionId) => {
    if (own === null) return;
    // 只取消目标会话的轮次，不影响其他会话。
    // 取消会暂停该会话队列，后续输入需由用户明确继续。
    if ((queues[own]?.items.length ?? 0) > 0) patchQueue(own, (current) => ({ ...current, paused: true }));
    try {
      await client.call('run.cancel', { sessionId: own });
    } catch (error) {
      // 取消状态属于目标会话；用户切走时暂存提示，切回后显示。
      if (active.current === own) setRows((current) => [...current, metaRow('meta', `取消失败：${code(error)}`, `Could not cancel: ${code(error)}`)]);
    }
  }, [client, patchQueue, queues, sessionId]);

  const reportQuitFailure = useCallback((error: unknown) => {
    setPrefsFailure(code(error));
    setPrefsDetails(error instanceof Error ? error.message : String(error));
  }, []);
  const { rows: quitRows, setRows: setQuitRows, hold: quitHold, setHold: setQuitHold, closing, quitting,
    quit: quitApp, approve: quitAction } = useQuitGate({
    transport, cancel, persistInputs, reportFailure: reportQuitFailure,
    input: { running: runningIds, approvals: asks.map(ask => ask.sessionId), questions: queries.map(query => query.sessionId), queued: queues },
    editReasons: () => [...settingsEdits.current, ...dockEdits.current],
  });

  // 输入停止 160 毫秒后查询候选；响应到达时若查询文本已变化则丢弃。
  // 传输层不支持取消正在执行的请求，因此通过忽略过期响应避免更新界面。
  useEffect(() => {
    const token = mentionToken(draft, caret);
    if (token === null) { setMention(null); mentionAsked.current = NO_TOKEN; return; }
    mentionWanted.current = token;
    if (hiddenMention === token.text) { mentionAsked.current = NO_TOKEN; return; }
    // 用 ref 保存上次查询文本，避免更新 state 触发 effect 重跑并撤销已安排的查询。
    const asked = mentionAsked.current;
    if (asked.start === token.start && asked.text === token.text) return;
    // 查询文本变化后清除旧候选，避免用户选中与当前输入不匹配的结果。
    mentionAsked.current = token;
    setMention({ ...token, paths: [], chosen: 0, stopped: 'pending', root: projectRoot });
    const timer = setTimeout(() => {
      void (async () => {
        const listed = await client.call('paths.list', { projectRoot, query: token.text, limit: 8 }, 8_000)
          .then((answer) => {
            const got = answer as { projectRoot: string; paths: string[]; stopped: string };
            return { paths: got.paths, stopped: got.stopped, root: got.projectRoot, failed: undefined as string | undefined };
          })
          .catch((error) => ({ paths: [] as string[], stopped: 'error', root: projectRoot, failed: code(error) }));
        const now = mentionWanted.current;
        if (now.start !== token.start || now.text !== token.text) return;
        setMention({ ...token, paths: listed.paths, chosen: 0, stopped: listed.stopped, root: listed.root, failed: listed.failed });
      })();
    }, 160);
    return () => clearTimeout(timer);
  }, [caret, client, draft, hiddenMention, projectRoot]);

  // 选择候选后将对应的 `@…` 替换为 `@路径 `，光标移到替换内容之后并保留后续文本。
  const pickMention = useCallback((path: string) => {
    if (mention === null) return;
    const merged = insertMention(draft, caret, mention.start, path);
    setDraft(merged.draft);
    setCaret(merged.caret);
    setHiddenMention('');
    setMention(null);
    composerRef.current?.setSelectionRange(merged.caret, merged.caret);
    composerRef.current?.focus();
  }, [caret, draft, mention]);

  // 通过 `mode.set` 切换模式；无效清单返回稳定错误码，不静默回退到默认模式。
  const setMode = useCallback(async (name: string | null) => {
    if (sessionId === null) {
      setNewSessionMode(name === '' || name === 'default' ? null : name);
      return;
    }
    if (name === '') return;
    try {
      const result = await client.call('mode.set', { sessionId, name: name ?? 'default' }) as { mode: string; pending: string | null };
      setRows((current) => [...current, metaRow('meta', result.pending === null
        ? `模式已切换为 ${result.mode}。`
        : `本轮结束后将切换为 ${result.pending} 模式。`, result.pending === null
        ? `Mode changed to ${result.mode}.`
        : `Mode will change to ${result.pending} after this turn.`)]);
    } catch (error) {
      setRows((current) => [...current, metaRow('error', `切换模式失败：${code(error)}`, `Could not change mode: ${code(error)}`)]);
    }
    void refreshStatus(sessionId);
  }, [client, refreshStatus, sessionId]);

  // 通过 `policy.set` 修改当前会话的策略；传入 `null` 时恢复配置默认值。
  const setPolicy = useCallback(async (mode: PolicySelection | null) => {
    if (sessionId === null) {
      setNewSessionPolicy(mode);
      return;
    }
    try {
      const result = await client.call('policy.set', { sessionId, mode: mode ?? 'default' }, 15_000) as { policy: string; policySource: string };
      if (active.current === sessionId) setRows((current) => [...current, metaRow('meta', mode === null
        ? `已恢复配置默认审批方式：${result.policy}。`
        : `本会话审批方式已改为 ${result.policy}。`, mode === null
        ? `Restored the configured approval mode: ${result.policy}.`
        : `Approval mode for this conversation changed to ${result.policy}.`)]);
    } catch (error) {
      if (active.current === sessionId) setRows((current) => [...current, metaRow('error', `更改审批方式失败：${code(error)}`, `Could not change approval mode: ${code(error)}`)]);
      throw error;
    }
    await refreshStatus(sessionId);
  }, [client, refreshStatus, sessionId]);

  // 通过 `session.compact` 压缩模型上下文；转录仍从完整会话记录构建。
  const compact = useCallback(async () => {
    if (sessionId === null) return;
    try {
      const result = await client.call('session.compact', { sessionId });
      setRows((current) => [...current, metaRow('meta', `已压缩记录 ${result.fromSeq}–${result.toSeq}：${result.tokensBefore} → ${result.tokensAfter} 个词元。`, `Compacted events ${result.fromSeq}–${result.toSeq}: ${result.tokensBefore} → ${result.tokensAfter} tokens.`)]);
    } catch (error) {
      setRows((current) => [...current, metaRow('error', `压缩失败：${code(error)}`, `Could not compact context: ${code(error)}`)]);
    }
    void refreshStatus(sessionId);
  }, [client, refreshStatus, sessionId]);

  const copyLastAnswer = useCallback(() => {
    const answer = [...rows].reverse().find((row) => row.kind === 'answer');
    if (answer === undefined) {
      setRows((current) => [...current, metaRow('meta', '还没有可复制的回答。', 'There is no answer to copy yet.')]);
      return;
    }
    void navigator.clipboard.writeText(answer.text).then(
      () => setRows((current) => [...current, metaRow('meta', `已复制最新回答（${answer.text.length} 个字符）。`, `Copied the latest answer (${answer.text.length} characters).`)]),
      (error: unknown) => setRows((current) => [...current, metaRow('error', `复制失败：${code(error)}`, `Could not copy answer: ${code(error)}`)]),
    );
  }, [rows]);

  // 命令面板只触发界面已有操作，不实现另一套操作逻辑。
  const commands = useMemo<Command[]>(() => {
    const sessionCommands: Command[] = observingExternalSession
      ? [{
        id: 'session.read', title: t('刷新观察', 'Refresh observation'),
        run: () => { if (sessionId !== null) void openSession(sessionId, undefined, false, projectRoot); },
      }]
      : [
        { id: 'session.read', title: t('刷新记录', 'Refresh conversation'), run: () => void readBack() },
        { id: 'session.branch', title: t('分支会话', 'Branch conversation'), run: () => void branchFrom() },
        { id: 'run.cancel', title: t('停止本轮', 'Stop this turn'), run: () => void cancel() },
        { id: 'session.compact', title: t('压缩上下文', 'Compact context'), run: () => void compact() },
      ];
    return [
      { id: 'session.new', title: t('新建会话', 'New conversation'), run: () => void newSession() },
      ...sessionCommands,
      { id: 'settings.open', title: t('打开设置', 'Open settings'), run: () => { setSettingsSection('general'); setSettingsOpen(true); } },
      { id: 'rail.toggle', title: collapsed ? t('展开侧栏', 'Show sidebar') : t('收起侧栏', 'Hide sidebar'), note: formatKeys(CURRENT['sidebar']), run: () => patch({ collapsed: !collapsed }) },
      { id: 'answer.copy', title: t('复制最新回答', 'Copy latest answer'), note: formatKeys(CURRENT['copy-answer']), run: copyLastAnswer },
      ...(status?.templates ?? []).map((item) => ({
        id: `prompt:${item.command}`,
        title: t(`使用 /${item.command}`, `Use /${item.command}`),
        note: item.hint === null || item.hint === undefined ? item.description : `${item.description} ${item.hint}`,
        run: () => {
          setDraft(`/${item.command} `);
          setWalk(-1);
          composerRef.current?.focus();
        },
      })),
    ];
  }, [branchFrom, cancel, collapsed, copyLastAnswer, compact, newSession, openSession, observingExternalSession, patch, projectRoot, readBack, sessionId, status, t]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // 输入法组合期间，Esc 用于取消候选，Enter 用于选择候选；不要将它们用于关闭面板或取消轮次。
      if (isComposing(event)) return;
      // 设置页正在录制快捷键时，不处理窗口级按键动作。
      if (isCapturing()) return;
      // 从同一键位表解析按键动作并生成界面显示文本。
      const action = actionOf(event, '窗口');
      if (action !== null && action !== 'interrupt') {
        event.preventDefault();
        if (action === 'palette') setPaletteOpen((open) => !open);
        else if (action === 'sidebar') patch({ collapsed: !collapsed });
        else copyLastAnswer();
        return;
      }
      // 先关闭面板和抽屉，再处理轮次取消。
      if (specOf(event) !== CURRENT['interrupt']) return;
      // Radix 负责关闭命令面板、会话菜单、设置和其他浮层，并标记 Esc 已处理。
      // React 状态可能在按键事件到达 document 前更新，因此根据事件是否已处理判断是否继续关闭其他层。
      if (event.defaultPrevented) return;
      if (settings.workbench.rightOpen) hideWorkbench();
      else if (running) void cancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [cancel, collapsed, copyLastAnswer, hideWorkbench, patch, running, settings.workbench.rightOpen]);

  const streamContext = useMemo(() => ({ hasMore: page?.hasMore === true, loading: olderLoading, showEarlier }), [olderLoading, page?.hasMore, showEarlier]);
  // 按展示设置过滤转录行；虚拟列表不能保留不渲染的行，否则高度测量会得到零。
  const shown = useMemo(() => rows.filter((row) => shownIn(verbosity, row)), [rows, verbosity]);
  // 将流式内容追加在已落盘记录之后，保持事件顺序。
  // 仅在转录内容变化时替换数组，避免每次渲染都触发虚拟列表重新测量。
  const visible = useMemo(() => (live.reasoning === '' && live.text === '' ? shown : [
    ...shown,
    ...(live.reasoning === '' || !shownIn(verbosity, LIVE_REASONING) ? [] : [{ ...LIVE_REASONING, text: live.reasoning }]),
    ...(live.text === '' || !shownIn(verbosity, LIVE_ANSWER) ? [] : [{ ...LIVE_ANSWER, text: live.text }]),
  ]), [shown, live.reasoning, live.text, verbosity]);

  useLayoutEffect(() => {
    renderedStream.current = { rows: visible, firstIndex, verbosity };
  }, [firstIndex, verbosity, visible]);

  useLayoutEffect(() => {
    const anchor = prependAnchor.current;
    if (anchor === null || anchor.request !== openRequest.current) return;
    const index = visible.findIndex((row) => row.id === anchor.id);
    if (index < 0) {
      prependAnchor.current = null;
      setOlderLoading(false);
      return;
    }
    // 等数据提交并补偿前插高度后再定位；测量完成前暂停自动跟随。
    const frame = requestAnimationFrame(() => {
      if (prependAnchor.current !== anchor || anchor.request !== openRequest.current) return;
      list.current?.scrollIntoView({
        index,
        calculateViewLocation: () => ({ index, align: 'start', offset: -anchor.offset }),
        done: () => {
          if (prependAnchor.current !== anchor || anchor.request !== openRequest.current) return;
          prependAnchor.current = null;
          setPinned(false);
          setOlderLoading(false);
        },
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [visible]);

  // 保存各会话当前最上方可见事件序号，切回时恢复阅读位置。
  // 保持回调身份稳定，避免无关渲染导致视口重复订阅。
  const onRangeChanged = useCallback(({ startIndex }: { startIndex: number }) => {
    if (reading) return;
    const row = visible[startIndex - firstIndex];
    if (row?.seq !== undefined && sessionId !== null) anchors.current.set(sessionId, row.seq);
  }, [visible, firstIndex, reading, sessionId]);

  // 每个定位请求只执行一次；高亮期间的补页和内容更新沿用当前视口。
  useLayoutEffect(() => {
    if (wanted === null) return;
    const at = visible.findIndex((row) => row.seq === wanted.seq);
    if (at >= 0) {
      readerScrolling.current = false;
      setPinned(false);
      setInitialIndex({ index: at, align: 'start' });
      setStamp((current) => current + 1);
      setFlash(wanted.seq);
      setWanted(null);
      return;
    }
    // 目标事件被展示设置过滤时停在转录末尾，不修改展示设置或记录。
    if (wanted.kind === 'anchor') {
      setWanted(null);
      return;
    }
    // 记录中存在但当前列表中没有该事件时，说明展示设置已过滤其类型。
    const held = rows.find((row) => row.seq === wanted.seq);
    if (held !== undefined && !shownIn(verbosity, held)) {
      patch({ verbosity: 'detailed' });
      return;
    }
    // 已读取页面中找不到目标事件时显示提示，不等待无法完成的跳转。
    setWanted(null);
    setRows((current) => [...current, metaRow('meta', wanted.kind === 'label'
      ? `记录 ${wanted.seq} 是会话名称，显示在标题和侧栏中。`
      : `记录 ${wanted.seq} 不属于当前可显示的内容。`, wanted.kind === 'label'
      ? `Event ${wanted.seq} is a conversation label shown in the title and sidebar.`
      : `Event ${wanted.seq} is not a displayable record.`)]);
  }, [patch, rows, verbosity, visible, wanted]);

  // 定位目标只短暂高亮，表示刚刚跳转到此处。
  // `stamp` 确保重复跳到同一事件时也会重新开始高亮计时。
  useEffect(() => {
    if (flash === null) return;
    const timer = setTimeout(() => {
      setFlash(null);
    }, 2500);
    return () => clearTimeout(timer);
  }, [flash, stamp]);

  const panelProps: PanelProps = {
    client,
    status,
    sessionId,
    running,
    othersRunning,
    runningIds,
    unread,
    hostRevision,
    seconds,
    waiting: client.waiting(),
    counts: client.counts(),
    link,
    logs: diagnosticLogs,
    onReconnect: () => void reconnect(),
    openSession: (id: string, root?: string) => void openSession(id, undefined, false, root),
    openHit,
    openProjectFile,
    openProjectGit,
    openArtifact: openArtifactResource,
    openCheck: openCheckResource,
    openDiagnostics: () => openPanel(menuPanels.find(item => item.id === 'panel.diagnostics')!),
    projects: settings.projects,
    onProjects: (roots: string[]) => patch({ projects: roots }),
    projectRoot,
    createIn: (root?: string) => void newSession(root),
    onEdit: reportDock,
    sessionsRevision,
    settings,
    patch,
  };
  const activePanelResource = activeWorkbenchTab?.resource.kind === 'panel' ? activeWorkbenchTab.resource : undefined;
  const activeDirectoryResource = activeWorkbenchTab?.resource.kind === 'directory' ? activeWorkbenchTab.resource : undefined;
  const activeFileResource = activeWorkbenchTab?.resource.kind === 'file' ? activeWorkbenchTab.resource : undefined;
  const activeGitResource = activeWorkbenchTab?.resource.kind === 'git' ? activeWorkbenchTab.resource : undefined;
  const activeArtifactResource = activeWorkbenchTab?.resource.kind === 'artifact' ? activeWorkbenchTab.resource : undefined;
  const activeCheckResource = activeWorkbenchTab?.resource.kind === 'check' ? activeWorkbenchTab.resource : undefined;
  const activeSideSessionResource = activeWorkbenchTab?.resource.kind === 'side-session' ? activeWorkbenchTab.resource : undefined;
  const activeSubrunResource = activeWorkbenchTab?.resource.kind === 'subrun' ? activeWorkbenchTab.resource : undefined;
  const inactivePanelScope = activePanelResource !== undefined && activePanelResource.panelId !== 'panel.help'
    && activePanelResource.sessionId !== sessionId;
  const dockPanelProps: PanelProps = activePanelResource === undefined || activePanelResource.panelId === 'panel.help'
    ? panelProps
    : {
      ...panelProps,
      sessionId: activePanelResource.sessionId ?? null,
      projectRoot: activePanelResource.projectRoot ?? panelProps.projectRoot,
      ...(inactivePanelScope ? {
        status: null,
        running: false,
        othersRunning: 0,
        runningIds: [],
        unread: [],
        seconds: 0,
        waiting: 0,
        counts: { sent: 0, received: 0 },
        link: null,
        logs: [],
        onReconnect: () => {},
      } : {}),
    };

  const currentQueries = queries.filter((query) => query.sessionId === sessionId);
  const currentAsks = asks.filter((ask) => (ask.displaySessionId ?? ask.sessionId) === sessionId);
  const handleDraftKeyDown = useCallback((event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (isComposing(event.nativeEvent)) return;
    if (mention !== null) {
      const candidate = actionOf(event, '候选清单');
      if (candidate === 'hide-candidate') {
        setHiddenMention(mention.text);
        setMention(null);
        return;
      }
      if (mention.stopped === 'pending' && (candidate === 'pick-candidate' || candidate === 'complete-candidate')) {
        event.preventDefault();
        return;
      }
      if (candidate !== null && mention.paths.length > 0) {
        event.preventDefault();
        if (candidate === 'pick-candidate' || candidate === 'complete-candidate') {
          pickMention(mention.paths[Math.min(mention.chosen, mention.paths.length - 1)]);
          return;
        }
        const step = candidate === 'candidate-older' ? -1 : 1;
        setMention({ ...mention, chosen: (mention.chosen + step + mention.paths.length) % mention.paths.length });
        return;
      }
    }
    const typed = actionOf(event, '输入坞');
    if (typed === 'send' || typed === 'send-alt') {
      event.preventDefault();
      void send();
      return;
    }
    if (typed !== 'history-older' && typed !== 'history-newer') return;
    if (draft !== '' && walk < 0) return;
    if (history.length === 0) return;
    event.preventDefault();
    const next = typed === 'history-older' ? Math.min(walk + 1, history.length - 1) : walk - 1;
    setWalk(next);
    setDraft(next < 0 ? '' : history[Math.max(next, 0)] ?? '');
  }, [draft, history, mention, pickMention, send, walk]);
  const toggleQueue = useCallback(() => {
    if (sessionId === null) return;
    if (queue.paused) allowSend.current.add(sessionId);
    patchQueue(sessionId, (current) => ({ ...current, paused: !current.paused }));
  }, [patchQueue, queue.paused, sessionId]);
  const selectWorkspace = useCallback(async (root: string) => {
    const text = draft;
    if (!await newSession(root)) throw new Error('workspace_selection_cancelled');
    setDraft(text, { root, id: '$new' });
    patch({ projects: [...new Set([...settings.projects, root])], hiddenProjects: settings.hiddenProjects.filter(item => item !== root) });
  }, [draft, newSession, patch, setDraft, settings.hiddenProjects, settings.projects]);
  const selectModel = useCallback(async (selection: ModelSelection) => {
    if (sessionId === null) { patch({ newSelections: { ...settings.newSelections, [projectRoot]: selection } }); return; }
    await client.call('model.select', { sessionId, ...selection }, 15_000);
    await refreshStatus(sessionId);
  }, [client, patch, projectRoot, refreshStatus, sessionId, settings.newSelections]);
  const selectThinking = useCallback(async (effort: string | null) => {
    if (sessionId === null) return;
    const request = thinkingRequest(sessionId, effort);
    await client.call(request.method, request.params, 15_000);
    await refreshStatus(sessionId);
  }, [client, refreshStatus, sessionId]);
  return <LocaleProvider language={settings.language}><div className="frame" data-collapsed={collapsed ? 'true' : undefined}
    data-mobile-sidebar={narrow && mobileSidebar ? 'true' : undefined} data-dock={settings.dock}
    data-workbench-open={settings.workbench.rightOpen ? 'true' : undefined}
    style={{ '--workbench-width': `min(${settings.workbench.rightWidth}px, 100vw)` } as CSSProperties}>
    <aside className="sidebar">
      <div className="brand"><img src="/icon.png" alt="" width="23" height="23" /><span>ligule</span><button type="button" className="icon-button" aria-label={t('收起侧栏', 'Hide sidebar')} onClick={() => patch({ collapsed: true })}><Icon name="sidebar" /></button></div>
      <button className="new-run" type="button" onClick={() => void newSession()}><Icon name="plus" size={17} /><span>{t('新建会话', 'New conversation')}</span></button>
      {registry.list('rail.sessions').map((item) => <div key={item.id} className="rail-slot">{item.view(panelProps)}</div>)}
      <div className="sidebar-foot">
        <button className="entry" type="button" aria-haspopup="dialog" aria-expanded={settingsOpen} onClick={() => { setSettingsSection('general'); setSettingsOpen(true); }}><Icon name="gear" size={17} /><span>{t('设置', 'Settings')}</span></button>
        {/* 这一枚菜单交给 radix：打开、收起、方向键走到哪一条、焦点交回都由它管，这里只说有哪些功能项（方案 4.2）。 */}
        <DropdownMenu.Root open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenu.Trigger asChild>
            <button className="entry" type="button"><Icon name="help" size={17} /><span>{t('帮助', 'Help')}</span></button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="menu" side="top" align="start" sideOffset={4} onEscapeKeyDown={keepEscape}>
              {registry.list('rail.menu').filter((item) => ['panel.help', 'panel.diagnostics'].includes(item.id)).map((item) => <DropdownMenu.Item key={item.id} onSelect={() => openPanel(item)}>
                {item.id === 'panel.help' ? t('使用手册', 'User guide') : t('诊断', 'Diagnostics')}
              </DropdownMenu.Item>)}
              <DropdownMenu.Item onSelect={() => { setSettingsSection('keys'); setSettingsOpen(true); }}>{t('快捷键', 'Keyboard shortcuts')}</DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </aside>
    <div className="splitter" role="separator" aria-orientation="vertical" aria-label={t('侧栏宽度', 'Sidebar width')} onPointerDown={startDrag} />

    <main className="center">
      {prefsFailure !== null && <div className="banner" role="alert">
        <span>{t('无法保存更改。请重试，离开前请复制草稿。', 'Could not save changes. Retry, or copy your draft before leaving.')}</span>
        <button type="button" onClick={() => setPrefsRevision((value) => value + 1)}>{t('重试', 'Retry')}</button>
        <details><summary>{t('详情', 'Details')}</summary><code>{prefsFailure}</code>{prefsDetails !== prefsFailure && <p>{prefsDetails}</p>}</details>
      </div>}
      <header className="topbar">
        {collapsed && <button type="button" className="icon-button" aria-label={t('展开侧栏', 'Show sidebar')} onClick={() => patch({ collapsed: false })}><Icon name="sidebar" /></button>}
        <div className="title">
          <strong id="session-title">{sessionId === null ? t('新会话', 'New conversation') : sessionLabel.name || t('未命名会话', 'Untitled conversation')}</strong>
          <span className="muted title-workspace" id="session-note" title={projectRoot}>{projectRoot.split(/[\\/]/).filter(Boolean).at(-1) ?? t('默认工作区', 'Default workspace')}</span>
        </div>
        {running && <span className="running-label" aria-live="polite" title={progressLabel}><span className="status-dot" /><span className="running-detail">{progressLabel}</span></span>}
        {status?.usage && <UsageMeter usage={status.usage} running={running} seconds={seconds} />}
        {sessionId !== null && <BrowserControl key={`${sessionId}:${observingExternalSession ? 'read-only' : 'managed'}`} client={client} sessionId={sessionId} browser={status?.browser}
        readOnly={observingExternalSession} onStatus={(next) => { if (next.sessionId === renderedSessionRequest.scope
          && requestIsCurrent(renderedSessionRequest, active.current, openRequest.current)) { setStatus(next); setTaskSnapshotAt(Date.now()); } }} />}
        <button className="icon-button" type="button" aria-label={t('工作台', 'Workbench')} aria-expanded={settings.workbench.rightOpen}
          title={t('工作台', 'Workbench')} onClick={toggleWorkbench}><Icon name="folderOpen" size={17} /></button>
        <button className="icon-button" type="button" aria-label={t('命令工作区', 'Command workspace')} aria-expanded={settings.workbench.bottomOpen}
          title={t('命令工作区', 'Command workspace')} onClick={toggleCommandArea}><Icon name="terminal" size={17} /></button>
        <button className="icon-button" type="button" title={`${t('命令面板', 'Command palette')} (${formatKeys(CURRENT['palette'])})`} aria-label={t('命令面板', 'Command palette')} onClick={() => setPaletteOpen(true)}><Icon name="search" size={17} /></button>
        {sessionId !== null && <SessionActions key={sessionId} client={client} sessionId={sessionId} name={sessionLabel.name} archived={sessionLabel.archived}
          readOnly={observingExternalSession}
          onLabel={(label) => { setSessionLabel(label); setSessionsRevision((value) => value + 1); }}
          onBranch={() => void branchFrom()} onExport={() => openPanel(menuPanels.find((item) => item.id === 'panel.export')!)}
          onTasks={() => openPanel(menuPanels.find((item) => item.id === 'panel.branch')!)} onRefresh={() => {
            if (observingExternalSession) void openSession(sessionId, undefined, false, projectRoot);
            else void readBack();
          }} onCompact={() => void compact()} />}
      </header>

      {observingExternalSession && <div className="banner" role="status">
        <Icon name="warn" size={15} />
        <span>{sessionWriterActive
          ? externalControlSessionId === sessionId
            ? t('外控 Agent 正在运行。下方可以查看进度、补充消息、处理待决问题或接管会话。', 'An external agent is controlling this session. Use the panel below to follow progress, send guidance, answer requests, or take over.')
            : t('另一个 Host 正在写入此会话。当前为只读观察；锁释放后可重新打开会话。', 'Another Host is writing to this conversation. This view is read-only; reopen it after the lock clears.')
          : t('此会话当前没有活动写入者。刷新会话可重新打开并取得控制权。', 'This session has no active writer. Refresh to reopen it and take control.')}
          {writerLockNoticeSessionId === sessionId && <> {t(
            '会话写入锁仍被占用；锁释放后重新打开会话即可恢复写入。',
            'The session writer lock is still held. Reopen the conversation after it clears to regain write access.',
          )}</>}</span>
        <button type="button" onClick={() => { if (sessionId !== null) void openSession(sessionId, undefined, false, projectRoot); }}>
          {sessionWriterActive ? t('刷新观察', 'Refresh view') : t('重新打开', 'Reopen session')}
        </button>
      </div>}

      {modelViewRequest?.sessionId === sessionId && <div className="model-view-request" role="status">
        <div>
          <strong>{t('模型请求打开一个资源', 'The model requests that you open a resource')}</strong>
          <span>{modelViewTargetLabel(modelViewRequest.target, t)}</span>
          <small>{t('收到请求不会自动切换工作台；打开也不代表已阅读。',
            'Receiving the request does not change the workbench; opening does not confirm that you read it.')}</small>
        </div>
        <button type="button" disabled={!modelViewRequest.ready || modelViewRequest.opening} onClick={openModelViewRequest}>
          {modelViewRequest.opening ? t('正在打开…', 'Opening…') : t('打开资源', 'Open requested resource')}
        </button>
        <button type="button" disabled={!modelViewRequest.ready || modelViewRequest.opening}
          onClick={dismissModelViewRequest}>{t('忽略', 'Dismiss')}</button>
      </div>}

      <TranscriptViewport
        client={client}
        sessionId={sessionId}
        projectRoot={projectRoot}
        rows={visible}
        hasRecords={rows.length > 0}
        reading={reading}
        verbosity={verbosity}
        flash={flash}
        onBranch={observingExternalSession ? undefined : (at) => void branchFrom(at)}
        onModels={openModelSettings}
        onOpenSideSession={(sideId, originId) => {
          openSideSessionResource(sideId, originId, projectRoot);
          void openSession(sideId, undefined, false, projectRoot);
        }}
        pinned={pinned}
        setPinned={setPinned}
        follow={!olderLoading && pinned && wanted === null && flash === null}
        initialIndex={initialIndex}
        list={list}
        firstIndex={firstIndex}
        stamp={stamp}
        streamContext={streamContext}
        readerScrolling={readerScrolling}
        onRangeChanged={onRangeChanged}
        onJumpToLatest={jumpToLatest}
      />

      {currentQueries.length > 0 && <QuestionCard
        key={currentQueries[0].id}
        ask={currentQueries[0]}
        initialDrafts={questionDrafts.current.get(currentQueries[0].id)}
        queued={currentQueries.length - 1}
        active={sessionId}
        onOpen={(id: string) => void openSession(id)}
        onSubmit={answerQuestion}
        // 取消当前卡片所属会话的轮次；前台切换后不能误停其他会话。
        onCancel={() => void cancel(currentQueries[0].sessionId)}
        onDraft={keepQuestionDraft}
      />}

      {currentAsks.length > 0 && <ApprovalCard
        ask={currentAsks[0]}
        queued={currentAsks.length - 1}
        verbosity={verbosity}
        active={sessionId}
        onOpen={(id: string) => void openSession(id)}
        onAnswer={answer}
        onDetails={(ask) => void loadApprovalDetails(ask)}
      />}

      {observingExternalSession && sessionWriterActive && sessionId !== null && <ExternalSessionControlPanel
        key={sessionId}
        client={client}
        sessionId={sessionId}
        projectRoot={projectRoot}
        verbosity={verbosity}
        onRuntimeAvailability={updateExternalControlAvailability}
        onDelta={acceptExternalDelta}
        onSessionEvent={settleExternalEvent}
        onTakeover={() => { void openSession(sessionId, undefined, false, projectRoot); }}
        getQuestionDraft={getExternalQuestionDraft}
        onQuestionDraft={keepExternalQuestionDraft}
      />}

      {link !== null && <div className="banner" role="alert">
        <Icon name="warn" size={15} />
        <span>{t('与后台的连接已中断。重连后可恢复会话，队列保持暂停。', 'Connection lost. Reconnect to restore the conversation; queued messages stay paused.')}</span>
        <button type="button" onClick={() => void reconnect()}>{t('重新连接', 'Reconnect')}</button>
        <details><summary>{t('详情', 'Details')}</summary><code>{link}</code></details>
      </div>}

      {notificationProblem !== null && settings.notifications.enabled && <div className="banner" role="status">
        <Icon name="bell" size={15} />
        <span>{t('系统通知暂不可用。', 'System notifications are unavailable.')}</span>
        <button type="button" onClick={() => { setSettingsSection('notifications'); setSettingsOpen(true); }}>{t('通知设置', 'Notification settings')}</button>
        <button type="button" className="icon-button" aria-label={t('关闭提示', 'Dismiss')} onClick={() => setNotificationProblem(null)}><Icon name="close" size={14} /></button>
      </div>}

      {observingExternalSession && sessionWriterActive && externalControlSessionId === sessionId && sessionId !== null
        ? <ExternalSessionComposer key={`external-session-composer:${sessionId}`} client={client} sessionId={sessionId} projectRoot={projectRoot}
            draft={externalSessionDraftFor(externalSessionDrafts, sessionId)}
            draftRevision={externalSessionDraftRevisionFor(externalSessionDrafts, sessionId)}
            onDraftChange={(value) => setExternalSessionDrafts((current) => updateExternalSessionDrafts(current, sessionId, value))}
            onDraftSent={(revision) => setExternalSessionDrafts((current) => clearExternalSessionDraftIfCurrent(current, sessionId, revision))} />
        : <Composer
        client={client}
        sessionId={sessionId}
        projectRoot={projectRoot}
        status={status}
        settings={settings}
        settingsReady={settingsReady}
        closing={closing}
        reading={reading}
        starting={starting}
        running={running}
        inputOwner={inputOwner}
        draft={draft}
        composerRef={composerRef}
        queue={queue}
        mention={mention}
        sessionMenuOpen={sessionMenuOpen}
        initialMode={newSessionMode}
        initialPolicy={newSessionPolicy}
        initialPermission={newSessionPermission}
        initialPermissionConfirmations={newSessionPermissionConfirmations}
        newSessionSettingsRevision={newSessionSettingsRevision}
        modelCatalogRevision={modelCatalogRevision}
        workspaceRevision={sessionsRevision}
        othersRunning={othersRunning}
        onDraftChange={setDraft}
        onCaretChange={setCaret}
        onWalkChange={setWalk}
        onDraftKeyDown={handleDraftKeyDown}
        onSelectWorkspace={selectWorkspace}
        onToggleQueue={toggleQueue}
        onRecoverQueueItem={(index, all) => recoverQueueItem(index, all)}
        onPickMention={pickMention}
        onSelectModel={selectModel}
        onSetThinking={selectThinking}
        onManageModel={openModelSettings}
        onOpenSecurity={openSecuritySettings}
        onSessionMenuChange={setSessionMenuOpen}
        onSetMode={(name) => void setMode(name)}
        onSetPolicy={setPolicy}
        onInitialPermissionChange={(target, confirmations) => {
          setNewSessionPermission(target);
          setNewSessionPermissionConfirmations(confirmations);
        }}
        onPermissionStatus={(next) => { if (next.sessionId === renderedSessionRequest.scope
          && requestIsCurrent(renderedSessionRequest, active.current, openRequest.current)) { setStatus(next); setTaskSnapshotAt(Date.now()); } }}
        onStop={() => void cancel()}
        onSend={() => void send()}
        onSteer={() => void steer()}
      />}
      <section className="bottom-workbench" aria-label={t('命令工作区', 'Command workspace')}
        hidden={!settings.workbench.bottomOpen}
        style={{ height: `${settings.workbench.bottomHeight}px`, flexBasis: `${settings.workbench.bottomHeight}px`,
          display: settings.workbench.bottomOpen ? 'flex' : 'none' }}>
        <div className="bottom-workbench-resize" role="separator" aria-orientation="horizontal"
          aria-label={t('命令工作区高度', 'Command workspace height')} onPointerDown={startBottomResize} />
        <header className="bottom-workbench-head">
          <strong>{t('命令工作区', 'Command workspace')}</strong>
          <span>{t('当前会话的命令记录', 'Commands for this conversation')}</span>
          <button type="button" className="icon-button" aria-label={t('隐藏命令工作区', 'Hide command workspace')}
            onClick={hideCommandArea}><Icon name="close" size={14} /></button>
        </header>
        <div className="bottom-workbench-body bottom-workbench-command-body">
          <CommandWorkspace client={client} sessionId={sessionId} projectRoot={projectRoot} status={status}
            readOnly={observingExternalSession} open={settings.workbench.bottomOpen} hostRevision={hostRevision}
            references={settings.workbench.commandTabs} activeKey={settings.workbench.activeCommandKey}
            onAdd={addCommandReference} onSelect={selectCommandReference} onClose={closeCommandReference}
            onOpenSession={(id, root) => { void openSession(id, undefined, false, root); }} />
        </div>
      </section>
    </main>

    {sideChat.selection !== null && <button type="button" className="side-chat-selection-action"
      style={{ left: sideChat.selection.left, top: sideChat.selection.top }}
      onMouseDown={event => event.preventDefault()}
      onClick={sideChat.openDialog}>{t('侧面询问', 'Ask about selection')}</button>}

    {settings.workbench.rightOpen && <WorkbenchDock state={settings.workbench}
      activeTitle={activeWorkbenchTab?.title ?? null}
      error={workbenchError}
      onSelect={selectWorkbench}
      onCloseTab={closeWorkbench}
      onHide={hideWorkbench}
      onResizeStart={startDockResize}>
      {panel !== null
        ? panel.view(dockPanelProps)
        : activeWorkbenchTab === null
          ? <section className="workbench-home">
            <h2>{t('工作台', 'Workbench')}</h2>
            <p>{t('浏览当前工作区文件和 Git 改动，或打开子任务、交付和诊断。', 'Browse project files and Git changes, or open subtasks, deliveries, and diagnostics.')}</p>
            <div className="workbench-home-actions">
              <button type="button" disabled={sessionId === null || projectRoot === ''}
                onClick={() => openProjectDirectory(projectRoot, '.')}>{t('项目文件', 'Browse files')}</button>
              <button type="button" disabled={sessionId === null || projectRoot === ''}
                onClick={() => openProjectGit(projectRoot)}>{t('项目改动', 'Project changes')}</button>
              {menuPanels.filter(item => item.id !== 'panel.help').map(item => <button type="button" key={item.id}
                onClick={() => openPanel(item)}>{panelTitle(item)}</button>)}
            </div>
          </section>
          : activeDirectoryResource !== undefined
            ? sessionId === null || projectRoot === '' || !sameProjectRoot(activeDirectoryResource.projectRoot, projectRoot)
              ? <p className="stub" role="status">{t('请切换到这个工作区的会话后再浏览文件。', 'Select a session in this project to browse its files.')}</p>
              : <ProjectFilesPanel key={`${sessionId}:${activeDirectoryResource.projectRoot}:${activeDirectoryResource.path}`}
                client={client} sessionId={sessionId} path={activeDirectoryResource.path}
                onOpenFile={path => openProjectFile(activeDirectoryResource.projectRoot, path)}
                onOpenDirectory={path => openProjectDirectory(activeDirectoryResource.projectRoot, path)} />
            : activeFileResource !== undefined
              ? sessionId === null || projectRoot === '' || !sameProjectRoot(activeFileResource.projectRoot, projectRoot)
                ? <p className="stub" role="status">{t('请切换到这个工作区的会话后再查看文件。', 'Select a session in this project to view the file.')}</p>
                : <ProjectFileView key={`${sessionId}:${activeFileResource.projectRoot}:${activeFileResource.path}`}
                  client={client} sessionId={sessionId} path={activeFileResource.path} expectedVersion={activeFileResource.version}
                  fileDraft={activeWorkbenchTab?.fileDraft} readOnly={observingExternalSession}
                  onDraftChange={draft => activeWorkbenchTab !== null && updateProjectFileDraft(activeWorkbenchTab.key, draft)}
                  onEdit={reportDock} />
              : activeGitResource !== undefined
                ? sessionId === null || projectRoot === '' || !sameProjectRoot(activeGitResource.projectRoot, projectRoot)
                  ? <p className="stub" role="status">{t('请切换到这个工作区的会话后再查看改动。', 'Select a session in this project to view its changes.')}</p>
                  : <ProjectGitPanel key={`${sessionId}:${activeGitResource.projectRoot}:${activeGitResource.path ?? ''}:${activeGitResource.version ?? ''}`}
                    client={client} sessionId={sessionId}
                    initialPath={activeGitResource.path} initialVersion={activeGitResource.version}
                    onOpenFile={(path, version) => openProjectFile(activeGitResource.projectRoot, path, version)}
                    onOpenCheck={openCheckResource} />
                : activeArtifactResource !== undefined
                  ? <ArtifactDetailPanel key={`${activeArtifactResource.sessionId}:${activeArtifactResource.artifactKey}`}
                    client={client} sessionId={activeArtifactResource.sessionId} projectRoot={activeArtifactResource.projectRoot}
                    artifactKey={activeArtifactResource.artifactKey} onOpenFile={path => openProjectFile(activeArtifactResource.projectRoot, path)} />
                  : activeCheckResource !== undefined
                    ? <CheckDetailPanel key={`${activeCheckResource.sessionId}:${activeCheckResource.runId}:${activeCheckResource.eventSeq}`}
                      client={client} sessionId={activeCheckResource.sessionId} projectRoot={activeCheckResource.projectRoot ?? projectRoot}
                      runId={activeCheckResource.runId} eventSeq={activeCheckResource.eventSeq}
                      onOpenEvent={(seq, kind) => void openSession(activeCheckResource.sessionId,
                        { sessionId: activeCheckResource.sessionId, name: '', seq, kind, text: '' }, false, activeCheckResource.projectRoot ?? projectRoot)} />
                      : activeSubrunResource !== undefined
                        ? activeSubrunResource.sessionId !== sessionId
                          ? <p className="stub" role="status">{t('这个子任务属于另一个会话。', 'This subtask belongs to another Session.')}</p>
                          : <BranchPanel key={`${activeSubrunResource.sessionId}:${activeSubrunResource.parentRunId}:${activeSubrunResource.subrunId}`}
                            client={client} sessionId={activeSubrunResource.sessionId} verbosity={verbosity}
                            activeRunId={activeSubrunResource.parentRunId} initialParentRunId={activeSubrunResource.parentRunId}
                            initialSubrunId={activeSubrunResource.subrunId} />
                    : activeSideSessionResource !== undefined
                      ? <SideSessionPanel key={`${activeSideSessionResource.sessionId}:${activeSideSessionResource.originSessionId}`}
                        client={client} sessionId={sessionId} projectRoot={activeSideSessionResource.projectRoot ?? projectRoot}
                        sideSessionId={activeSideSessionResource.sessionId} originSessionId={activeSideSessionResource.originSessionId}
                        onOpenOrigin={id => { void openSession(id, undefined, false, activeSideSessionResource.projectRoot ?? projectRoot); }}
                        onOpenSideSession={id => { void openSession(id, undefined, false, activeSideSessionResource.projectRoot ?? projectRoot); }}
                        onSendToRun={sendSideConclusion} onPrepareFollowup={prepareSideFollowup} />
          : <p className="stub" role="status">{t('这个资源暂时无法显示。', 'This resource is not available to display.')}</p>}
    </WorkbenchDock>}

    {/* 面板收起后把焦点交回输入坞：面板自己那一个过滤框带着 `autoFocus`，它收掉之后没人可交，落在页面上就得从页头重新 Tab 过去。 */}
    {paletteOpen && <Palette commands={commands} onClose={() => { setPaletteOpen(false); composerRef.current?.focus(); }} />}
    {sideChat.dialog !== null && <SideChatDialog context={sideChat.dialog} question={sideChat.question} busy={sideChat.busy}
      error={sideChat.error} onQuestion={sideChat.setQuestion}
      onClose={sideChat.closeDialog}
      onCreate={() => void sideChat.create()} />}
    {settingsOpen && <SettingsDialog
      initialSection={settingsSection}
      client={client}
      sessionId={sessionId}
      projectRoot={projectRoot}
      status={status}
      settings={settings}
      notifications={transport.notifications}
      notificationProblem={notificationProblem}
      notificationPending={notificationDestination !== null}
      patch={patch}
      keyNotice={keyNotice}
      link={link}
      logs={diagnosticLogs}
      onStatus={(next) => { if (next.sessionId === renderedSessionRequest.scope
        && requestIsCurrent(renderedSessionRequest, active.current, openRequest.current)) { setStatus(next); setTaskSnapshotAt(Date.now()); } }}
      counts={panelProps.counts}
      waiting={panelProps.waiting}
      onReconnect={() => void reconnect()}
      onEdit={reportSettingsEdits}
      onClose={() => { setSettingsOpen(false); setModelCatalogRevision((current) => current + 1); if (sessionId !== null) void refreshStatus(sessionId); }}
    />}
    {quitHold !== null && <HoldSheet
      lead={t('退出会丢弃以下未保存的设置：', 'Exiting will discard these unsaved settings:')}
      reasons={quitHold}
      onStay={() => setQuitHold(null)}
      onLeave={() => { setQuitHold(null); quitAction.current(); }}
    />}
    {quitRows.length > 0 && <QuitSheet rows={quitRows} onBack={() => setQuitRows([])} onQuit={() => void quitApp()} />}
    {dockHold !== null && <HoldSheet
      lead={t('放弃未保存的修改？', 'Discard unsaved changes?')}
      reasons={dockHold.reasons}
      onStay={() => setDockHold(null)}
      onLeave={() => { const go = dockHold.go; setDockHold(null); go(); }}
    />}
  </div></LocaleProvider>;
}
