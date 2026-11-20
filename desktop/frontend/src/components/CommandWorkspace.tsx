import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { code, type Client } from '../protocol';
import { useText } from '../locale';
import type { Status } from '../status';
import { createViewScope, type ViewToken } from '../view-scope';
import { commandReferenceKey, MAX_WORKBENCH_COMMANDS, type WorkbenchCommandReference } from '../workbench';

type OutputEvent = { readonly id: string; readonly stream: string; readonly text: string };

type CommandView = {
  readonly state: string;
  readonly command?: string;
  readonly cwd?: string;
  readonly exitCode?: number;
  readonly errorCode?: string;
  readonly cleanupPending: boolean;
  readonly terminationPending: boolean;
  readonly waitTimedOut: boolean;
  readonly events: readonly OutputEvent[];
  readonly followEnd: boolean;
  readonly cursor?: string;
  readonly hasMore: boolean;
  readonly logGap: boolean;
  readonly logError?: string;
};

const EMPTY_VIEW: CommandView = {
  state: 'starting', cleanupPending: false, terminationPending: false, waitTimedOut: false,
  events: [], followEnd: true, hasMore: false, logGap: false,
};
const ACTIVE_STATES = new Set(['starting', 'running', 'stopping']);
const MAX_OUTPUT_CHARACTERS = 65_536;
const MAX_OUTPUT_EVENTS = 500;

function outputFrom(value: unknown): OutputEvent[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return [];
    const event = item as Record<string, unknown>;
    if (typeof event.text !== 'string' || typeof event.stream !== 'string') return [];
    const identity = [event.sequence, event.offset, event.stream, index].join(':');
    return [{ id: identity, stream: event.stream, text: event.text }];
  });
}

function addOutput(view: CommandView, received: readonly OutputEvent[], gap: boolean): Pick<CommandView, 'events' | 'logGap'> {
  const known = new Set(view.events.map(event => event.id));
  const events = [...view.events, ...received.filter(event => !known.has(event.id))];
  let characters = events.reduce((sum, event) => sum + [...event.text].length, 0);
  let truncated = false;
  while (events.length > 0 && (characters > MAX_OUTPUT_CHARACTERS || events.length > MAX_OUTPUT_EVENTS)) {
    const removed = events.shift()!;
    characters -= [...removed.text].length;
    truncated = true;
  }
  return { events, logGap: view.logGap || gap || truncated };
}

function stateLabel(state: string, t: (chinese: string, english: string) => string, exitCode?: number): string {
  switch (state) {
    case 'starting': return t('正在启动', 'Starting');
    case 'running': return t('运行中', 'Running');
    case 'stopping': return t('正在停止', 'Stopping');
    case 'exited': return t(`已退出（${exitCode ?? '无退出码'}）`, `Exited (${exitCode ?? 'no exit code'})`);
    case 'cancelled': return t('已取消', 'Cancelled');
    case 'failed': return t('失败', 'Failed');
    default: return t('状态未知', 'Unknown state');
  }
}

export function CommandWorkspace({
  client,
  sessionId,
  projectRoot,
  status,
  readOnly,
  open,
  hostRevision,
  references,
  activeKey,
  onAdd,
  onSelect,
  onClose,
  onOpenSession,
}: {
  readonly client: Client;
  readonly sessionId: string | null;
  readonly projectRoot: string;
  readonly status: Status | null;
  readonly readOnly: boolean;
  readonly open: boolean;
  readonly hostRevision: number;
  readonly references: readonly WorkbenchCommandReference[];
  readonly activeKey: string | null;
  readonly onAdd: (reference: WorkbenchCommandReference, activate: boolean) => void;
  readonly onSelect: (key: string) => void;
  readonly onClose: (key: string) => void;
  readonly onOpenSession: (sessionId: string, projectRoot?: string) => void;
}) {
  const t = useText();
  const [command, setCommand] = useState('');
  const [cwd, setCwd] = useState('.');
  const [starting, setStarting] = useState(false);
  const [startingError, setStartingError] = useState<string | null>(null);
  const [views, setViews] = useState<Record<string, CommandView>>({});
  const viewsRef = useRef(views);
  viewsRef.current = views;
  const referencesRef = useRef(references);
  referencesRef.current = references;
  const refreshing = useRef(new Map<string, ViewToken>());
  const refreshAgain = useRef(new Map<string, ViewToken>());
  const refreshReferenceRef = useRef<(reference: WorkbenchCommandReference) => Promise<void>>(async () => {});
  const openedAt = useRef(new Map<string, number>());
  const actionBusy = useRef(new Map<string, ViewToken>());
  const startingToken = useRef<ViewToken | null>(null);
  const logElement = useRef<HTMLDivElement | null>(null);
  const [copyStatus, setCopyStatus] = useState<'copied' | 'error' | null>(null);
  // 面板、会话、项目或 Host 重启后，仍在途的 `status.get` / `execution.*` 结果不再属于当前视图。
  const viewScope = useRef(createViewScope());
  const previousReferenceKeys = useRef<readonly string[]>([]);
  useEffect(() => {
    viewScope.current.bump();
    // 旧代次的启动提交不能把 busy 状态留给新视图。
    if (startingToken.current !== null && !viewScope.current.isCurrent(startingToken.current)) {
      startingToken.current = null;
      setStarting(false);
    }
  }, [client, hostRevision, open, projectRoot, sessionId]);

  const visibleReferences = useMemo(() => references.filter(reference =>
    reference.sourceSessionId === sessionId || reference.operationSessionId === sessionId), [references, sessionId]);
  const visibleKey = useMemo(() => visibleReferences.map(commandReferenceKey).join('\0'), [visibleReferences]);
  const selectedReference = visibleReferences.find(reference => commandReferenceKey(reference) === activeKey)
    ?? visibleReferences.at(-1);
  const selectedKey = selectedReference === undefined ? null : commandReferenceKey(selectedReference);
  const isOperationSession = status?.operation !== undefined && status.operation !== null;
  const canStart = open && sessionId !== null && projectRoot !== '' && status !== null && status.tools.includes('exec')
    && !readOnly && !isOperationSession && !starting && references.length < MAX_WORKBENCH_COMMANDS;

  const updateView = useCallback((key: string, update: (previous: CommandView) => CommandView) => {
    const previous = viewsRef.current[key] ?? EMPTY_VIEW;
    const next = update(previous);
    const all = { ...viewsRef.current, [key]: next };
    viewsRef.current = all;
    setViews(all);
  }, []);

  const refreshReference = useCallback(async (reference: WorkbenchCommandReference) => {
    const key = commandReferenceKey(reference);
    const token = viewScope.current.capture(key);
    const isLive = () => viewScope.current.isCurrent(token);
    if (refreshing.current.has(key)) {
      refreshAgain.current.set(key, token);
      return;
    }
    if (!referencesRef.current.some(item => commandReferenceKey(item) === key)) return;
    refreshing.current.set(key, token);
    try {
      if (openedAt.current.get(reference.operationSessionId) !== hostRevision) {
        await client.call('session.open', { sessionId: reference.operationSessionId, projectRoot }, 15_000);
        const record = await client.call('session.read', { sessionId: reference.operationSessionId, limit: 100 }, 15_000) as {
          events?: { kind?: unknown; tool?: unknown; args?: unknown }[];
        };
        const execEvent = record.events?.find(event => event.kind === 'tool' && event.tool === 'exec');
        if (!isLive()) return;
        const args = typeof execEvent?.args === 'object' && execEvent.args !== null && !Array.isArray(execEvent.args)
          ? execEvent.args as Record<string, unknown> : undefined;
        updateView(key, previous => ({
          ...previous,
          ...(typeof args?.command === 'string' ? { command: args.command } : {}),
          ...(typeof args?.cwd === 'string' ? { cwd: args.cwd } : {}),
        }));
        openedAt.current.set(reference.operationSessionId, hostRevision);
      }
      const [sessionStatus, execution, logs] = await Promise.all([
        client.call('status.get', { sessionId: reference.operationSessionId }, 10_000) as Promise<Status>,
        client.call('execution.status', {
          sessionId: reference.operationSessionId, runId: reference.operationId, executionId: reference.executionId,
        }, 10_000) as Promise<Record<string, unknown>>,
        client.call('execution.logs', {
          sessionId: reference.operationSessionId,
          runId: reference.operationId,
          executionId: reference.executionId,
          ...(viewsRef.current[key]?.cursor === undefined ? {} : { cursor: viewsRef.current[key]?.cursor }),
          limitBytes: 4096,
        }, 10_000) as Promise<Record<string, unknown>>,
      ]);
      if (sessionStatus.operation?.operationId !== reference.operationId
        || sessionStatus.operation.sourceSessionId !== reference.sourceSessionId) {
        throw Object.assign(new Error('operation_owner_mismatch'), { code: 'operation_owner_mismatch' });
      }
      if (!isLive()) return;
      const received = outputFrom(logs.events);
      updateView(key, previous => ({
        ...previous,
        state: typeof execution.state === 'string' ? execution.state : 'unknown',
        ...(Number.isSafeInteger(execution.exitCode) ? { exitCode: Number(execution.exitCode) } : {}),
        ...(typeof execution.errorCode === 'string' ? { errorCode: execution.errorCode } : {}),
        cleanupPending: execution.cleanupPending === true,
        terminationPending: execution.terminationPending === true,
        waitTimedOut: typeof execution.state === 'string' && ACTIVE_STATES.has(execution.state)
          ? previous.waitTimedOut : false,
        ...addOutput(previous, received, logs.gap === true),
        ...(typeof logs.nextCursor === 'string' ? { cursor: logs.nextCursor } : {}),
        hasMore: logs.hasMore === true,
        logError: typeof logs.unavailableReason === 'string' ? logs.unavailableReason : undefined,
      }));
    } catch (error) {
      if (isLive()) {
        updateView(key, previous => ({ ...previous, state: previous.state === 'starting' ? 'unknown' : previous.state,
          errorCode: code(error) }));
      }
    } finally {
      // 只有登记这次请求的 owner 才能释放标记；旧的 finally 不能删掉新代次的等待者。
      if (refreshing.current.get(key) === token) {
        refreshing.current.delete(key);
        const queued = refreshAgain.current.get(key);
        if (queued !== undefined) {
          refreshAgain.current.delete(key);
          if (viewScope.current.isCurrent(queued)) void refreshReferenceRef.current(reference);
        }
      }
    }
  }, [client, hostRevision, projectRoot, updateView]);
  refreshReferenceRef.current = refreshReference;

  useEffect(() => {
    if (!open || sessionId === null) return;
    for (const reference of visibleReferences) void refreshReference(reference);
  }, [hostRevision, open, refreshReference, sessionId, visibleKey]);

  useEffect(() => {
    if (!open || sessionId === null || visibleReferences.length === 0) return;
    const timer = setInterval(() => {
      for (const reference of visibleReferences) {
        const view = viewsRef.current[commandReferenceKey(reference)];
        if (view === undefined || ACTIVE_STATES.has(view.state)) {
          void refreshReference(reference);
        }
      }
    }, 1_000);
    return () => clearInterval(timer);
  }, [open, refreshReference, sessionId, visibleKey]);

  useEffect(() => {
    const valid = new Set(references.map(commandReferenceKey));
    for (const key of previousReferenceKeys.current) if (!valid.has(key)) viewScope.current.forget(key);
    previousReferenceKeys.current = [...valid];
    const retained = Object.fromEntries(Object.entries(viewsRef.current).filter(([key]) => valid.has(key)));
    viewsRef.current = retained;
    setViews(retained);
  }, [references]);

  useEffect(() => {
    setCommand('');
    setCwd('.');
    setStarting(false);
    setStartingError(null);
    setCopyStatus(null);
  }, [sessionId]);

  const startCommand = useCallback(async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canStart || sessionId === null || command.trim() === '') return;
    const token = viewScope.current.capture();
    const isLive = () => viewScope.current.isCurrent(token);
    startingToken.current = token;
    setStarting(true);
    setStartingError(null);
    const sourceSessionId = sessionId;
    try {
      const result = await client.call('operation.start', {
        sessionId: sourceSessionId,
        command: command.trim(),
        cwd: cwd.trim() || '.',
      }, 0) as { operationSessionId?: unknown; operationId?: unknown; executionId?: unknown; state?: unknown; errorCode?: unknown };
      if (typeof result.operationSessionId !== 'string' || typeof result.operationId !== 'string'
        || typeof result.executionId !== 'string') {
        throw Object.assign(new Error(typeof result.errorCode === 'string' ? result.errorCode : 'operation_execution_handle_unavailable'), {
          code: typeof result.errorCode === 'string' ? result.errorCode : 'operation_execution_handle_unavailable',
        });
      }
      const reference = {
        sourceSessionId, operationSessionId: result.operationSessionId, operationId: result.operationId,
        executionId: result.executionId,
      };
      const key = commandReferenceKey(reference);
      // 命令已经在 Host 上真实启动，引用是既成事实，不随视图代次丢弃。
      // 代次只决定是否立刻激活/写入临时视图状态。
      const live = isLive();
      onAdd(reference, live);
      if (live) {
        updateView(key, previous => ({ ...previous, state: typeof result.state === 'string' ? result.state : 'starting',
          ...(typeof result.errorCode === 'string' ? { errorCode: result.errorCode } : {}) }));
        void refreshReference(reference);
      }
    } catch (error) {
      if (isLive()) setStartingError(code(error));
    } finally {
      if (startingToken.current === token) {
        startingToken.current = null;
        setStarting(false);
      }
    }
  }, [canStart, client, command, cwd, onAdd, refreshReference, sessionId, updateView]);

  const waitForCommand = useCallback(async (reference: WorkbenchCommandReference) => {
    const key = commandReferenceKey(reference);
    const token = viewScope.current.capture(key);
    // 旧代次的在途动作不再阻塞新视图。
    const previous = actionBusy.current.get(key);
    if (previous !== undefined && viewScope.current.isCurrent(previous)) return;
    const isLive = () => viewScope.current.isCurrent(token);
    actionBusy.current.set(key, token);
    updateView(key, previous => ({ ...previous, waitTimedOut: false, errorCode: undefined }));
    try {
      const result = await client.call('execution.wait', {
        sessionId: reference.operationSessionId, runId: reference.operationId,
        executionId: reference.executionId, waitMs: 2_000,
      }, 5_000) as { waitTimedOut?: unknown };
      if (!isLive()) return;
      updateView(key, previous => ({ ...previous, waitTimedOut: result.waitTimedOut === true }));
      await refreshReference(reference);
    } catch (error) {
      if (isLive()) updateView(key, previous => ({ ...previous, errorCode: code(error) }));
    } finally {
      if (actionBusy.current.get(key) === token) actionBusy.current.delete(key);
    }
  }, [client, refreshReference, updateView]);

  const cancelCommand = useCallback(async (reference: WorkbenchCommandReference) => {
    const key = commandReferenceKey(reference);
    const token = viewScope.current.capture(key);
    const previous = actionBusy.current.get(key);
    if (previous !== undefined && viewScope.current.isCurrent(previous)) return;
    const isLive = () => viewScope.current.isCurrent(token);
    actionBusy.current.set(key, token);
    updateView(key, previous => ({ ...previous, errorCode: undefined }));
    try {
      await client.call('execution.cancel', {
        sessionId: reference.operationSessionId, runId: reference.operationId, executionId: reference.executionId,
      }, 10_000);
      if (!isLive()) return;
      await refreshReference(reference);
    } catch (error) {
      if (isLive()) updateView(key, previous => ({ ...previous, errorCode: code(error) }));
    } finally {
      if (actionBusy.current.get(key) === token) actionBusy.current.delete(key);
    }
  }, [client, refreshReference, updateView]);

  const canOpenCurrentSession = sessionId !== null && sessionId !== '';
  const selectedView = selectedKey === null ? undefined : views[selectedKey];
  const showEmpty = visibleReferences.length === 0;

  useLayoutEffect(() => {
    const element = logElement.current;
    if (selectedView?.followEnd === true && element !== null) element.scrollTop = element.scrollHeight;
  }, [selectedKey, selectedView?.events, selectedView?.followEnd]);

  const copyOutput = useCallback(async () => {
    if (selectedView === undefined) return;
    const text = selectedView.events.map(event => `[${event.stream}]\n${event.text}`).join('\n');
    try {
      if (navigator.clipboard === undefined) throw new Error('clipboard_unavailable');
      await navigator.clipboard.writeText(text);
      setCopyStatus('copied');
    } catch {
      setCopyStatus('error');
    }
  }, [selectedView]);

  return <section className="command-workspace" aria-label={t('手动命令控制', 'Command runs')}>
    <form className="command-workspace-form" onSubmit={startCommand}>
      <label>
        <span>{t('命令', 'Command')}</span>
        <input aria-label={t('命令', 'Command')} value={command} onChange={event => setCommand(event.target.value)}
          placeholder={t('输入要运行的命令', 'Enter a command to run')} />
      </label>
      <label className="command-workspace-cwd">
        <span>{t('工作目录', 'Working directory')}</span>
        <input aria-label={t('工作目录', 'Working directory')} value={cwd} onChange={event => setCwd(event.target.value)} />
      </label>
      <button type="submit" disabled={!canStart || command.trim() === ''}>
        {starting ? t('等待命令启动', 'Starting command') : t('运行命令', 'Run command')}
      </button>
      {startingError !== null && <span className="command-workspace-error" role="alert">{t('启动失败', 'Could not start')}: {startingError}</span>}
      {status !== null && !status.tools.includes('exec') && <span className="command-workspace-note">{t('当前模式不提供命令执行。', 'Command execution is not available in this mode.')}</span>}
      {readOnly && <span className="command-workspace-note">{t('此会话为只读观察，不能启动命令。', 'This session is read-only; commands cannot be started.')}</span>}
      {references.length >= MAX_WORKBENCH_COMMANDS && <span className="command-workspace-note">{t('命令标签已满；先关闭一条标签再运行。', 'All command tabs are in use; close one before starting another.')}</span>}
    </form>
    {visibleReferences.length > 0 && <div className="command-workspace-tabs" role="tablist" aria-label={t('命令标签', 'Command tabs')}>
      {visibleReferences.map(reference => {
        const key = commandReferenceKey(reference);
        const view = views[key];
        const fallbackLabel = `${t('命令', 'Command')} · ${reference.operationId.slice(0, 8)}`;
        const label = view?.command ?? fallbackLabel;
        return <div className="command-workspace-tab" key={key} data-active={selectedKey === key ? 'true' : undefined}>
          <button type="button" role="tab" aria-selected={selectedKey === key} aria-label={label} onClick={() => onSelect(key)}>
            <span>{label}</span><small>{stateLabel(view?.state ?? 'starting', t, view?.exitCode)}</small>
          </button>
          <button type="button" className="command-workspace-tab-close" aria-label={`${t('关闭', 'Close')} ${label}`}
            onClick={() => onClose(key)}>×</button>
        </div>;
      })}
    </div>}
    {showEmpty ? <p className="command-workspace-empty">{t('输入一条命令并运行；命令会以独立会话记录输出。', 'Enter a command to run it in its own recorded session.')}</p>
      : selectedReference !== undefined && <section className="command-workspace-output" role="tabpanel" aria-label={t('命令输出', 'Command output')}>
        <header className="command-workspace-output-head">
          <strong>{selectedView?.command ?? `${t('命令', 'Command')} · ${selectedReference.operationId.slice(0, 8)}`}</strong>
          {selectedView?.cwd !== undefined && <span>{t('目录', 'cwd')}: {selectedView.cwd}</span>}
          <span data-state={selectedView?.state ?? 'unknown'}>{stateLabel(selectedView?.state ?? 'unknown', t, selectedView?.exitCode)}</span>
          {selectedView?.waitTimedOut === true && <span role="status">{t('等待到期，命令仍在运行。', 'Wait ended; the command is still running.')}</span>}
          {selectedView?.cleanupPending === true && <span role="alert">{t('进程清理仍在进行。', 'Process cleanup is still pending.')}</span>}
          {selectedView?.terminationPending === true && <span role="alert">{t('进程终止仍未确认。', 'Process termination is not confirmed.')}</span>}
          {selectedView?.errorCode !== undefined && <span className="command-workspace-error" role="alert">{selectedView.errorCode}</span>}
          <button type="button" disabled={selectedView === undefined} onClick={() => selectedReference !== undefined && void refreshReference(selectedReference)}>
            {t('刷新状态', 'Refresh status')}
          </button>
          <button type="button" onClick={() => void onOpenSession(selectedReference.operationSessionId, projectRoot)}>
            {t('打开命令记录', 'Open command record')}
          </button>
          {selectedView !== undefined && ACTIVE_STATES.has(selectedView.state) && <>
            <button type="button" disabled={actionBusy.current.has(selectedKey!)} onClick={() => void waitForCommand(selectedReference)}>
              {t('等待 2 秒', 'Wait 2 seconds')}
            </button>
            <button type="button" disabled={actionBusy.current.has(selectedKey!)} onClick={() => void cancelCommand(selectedReference)}>
              {t('取消命令', 'Cancel command')}
            </button>
          </>}
          {selectedView?.hasMore === true && <button type="button" onClick={() => selectedReference !== undefined && void refreshReference(selectedReference)}>
            {t('读取更多输出', 'Load more output')}
          </button>}
          {selectedView?.followEnd === false && <button type="button" onClick={() => selectedKey !== null
            && updateView(selectedKey, previous => ({ ...previous, followEnd: true }))}>
            {t('跳到末尾', 'Jump to end')}
          </button>}
          <button type="button" disabled={selectedView === undefined || selectedView.events.length === 0} onClick={() => void copyOutput()}>
            {copyStatus === 'copied' ? t('已复制', 'Copied') : t('复制输出', 'Copy output')}
          </button>
          {copyStatus === 'error' && <span className="command-workspace-error" role="status">{t('无法访问剪贴板。', 'Clipboard access is unavailable.')}</span>}
          {canOpenCurrentSession && selectedView?.logError !== undefined && <span role="alert">{selectedView.logError}</span>}
        </header>
        <div className="command-workspace-log" ref={logElement} onScroll={event => {
          if (selectedKey === null) return;
          const element = event.currentTarget;
          const followEnd = element.scrollHeight - element.scrollTop - element.clientHeight <= 8;
          updateView(selectedKey, previous => previous.followEnd === followEnd ? previous : { ...previous, followEnd });
        }} aria-live="off">
          {selectedView?.logGap === true && <p role="status">{t('较早的输出已超出保留范围。', 'Earlier output has left the retained log window.')}</p>}
          {(selectedView?.events ?? []).map(event => <div className="command-workspace-log-event" data-stream={event.stream} key={event.id}>
            <span>{event.stream}</span><pre>{event.text}</pre>
          </div>)}
          {(selectedView?.events.length ?? 0) === 0 && <p>{t('暂时没有命令输出。', 'No command output yet.')}</p>}
        </div>
      </section>}
  </section>;
}
