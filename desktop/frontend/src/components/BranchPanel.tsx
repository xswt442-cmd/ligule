import { useCallback, useEffect, useRef, useState } from 'react';
import { code, type Client } from '../protocol';
import { useText } from '../locale';
import { projectRecord, shownIn, type Record_, type Row } from '../rows';
import { subrunBranchOf, type SubrunBranch } from '../subrun-branches';
import type { Verbosity } from './types';
import { RowView } from './RowView';
import { SubrunPresetPanel } from './SubrunPresetPanel';

type Branch = SubrunBranch & { readonly state?: string; readonly errorCode?: string };

function nextStatusGeneration(generations: Map<string, number>, branchId: string): number {
  const generation = (generations.get(branchId) ?? 0) + 1;
  generations.set(branchId, generation);
  return generation;
}

function isCurrentStatusGeneration(generations: Map<string, number>, branchId: string, generation: number): boolean {
  return generations.get(branchId) === generation;
}

function statusAfterReadFailure(branches: Branch[], branchId: string, errorCode: string): Branch[] {
  return branches.map((branch) => branch.id === branchId && branch.state === undefined
    ? { ...branch, state: 'unknown', errorCode } : branch);
}

function withStatus(branch: Branch, state: string, errorCode: unknown): Branch {
  return { ...branch, state, errorCode: typeof errorCode === 'string' ? errorCode : undefined };
}

function noteText(note: { kind: 'parent' | 'branch' | 'control'; code: string }, t: (chinese: string, english: string) => string): string {
  if (note.kind === 'control') {
    if (note.code === 'subrun_message_accepted') return t('补充输入已接受。', 'The child accepted the message.');
    if (note.code === 'subrun_cancel_requested') return t('已发出取消请求，等待子任务结束。', 'Cancellation requested; waiting for the child to settle.');
    if (note.code === 'subrun_cancel_not_running') return t('子任务当前没有运行。', 'The child is not running.');
    if (note.code === 'subrun_wait_timed_out') return t('等待到期；子任务仍在运行。', 'Wait timed out; the child is still running.');
    return t(`子任务操作失败：${note.code}`, `Subtask action failed: ${note.code}`);
  }
  return note.kind === 'parent'
    ? t(`无法读取会话记录：${note.code}`, `Could not load conversation history: ${note.code}`)
    : t(`无法读取子任务：${note.code}`, `Could not load subtask: ${note.code}`);
}

export function BranchPanel({ client, sessionId, activeRunId = null, runStatusKnown = true, verbosity,
  initialParentRunId, initialSubrunId }: {
  client: Client; sessionId: string | null; activeRunId?: string | null; runStatusKnown?: boolean; verbosity: Verbosity;
  initialParentRunId?: string; initialSubrunId?: string;
}) {
  const t = useText();
  const requestGeneration = useRef(0);
  const sessionGeneration = useRef(0);
  const branchReadGeneration = useRef(0);
  const statusGenerations = useRef(new Map<string, number>());
  const messageRevision = useRef(0);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [shown, setShown] = useState<{ id: string; rows: Row[] } | null>(null);
  const [message, setMessage] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [note, setNote] = useState<{ kind: 'parent' | 'branch' | 'control'; code: string } | null>(null);

  useEffect(() => {
    const generation = ++sessionGeneration.current;
    requestGeneration.current += 1;
    branchReadGeneration.current += 1;
    statusGenerations.current.clear();
    setBranches([]);
    setSelectedId(null);
    setShown(null);
    messageRevision.current += 1;
    setMessage('');
    setBusyId(null);
    setNote(null);
    if (sessionId === null) return () => undefined;
    void (async () => {
      try {
        const { events } = await client.call('session.read', { sessionId, fullResults: true }) as { events: Record_[] };
        if (sessionGeneration.current !== generation) return;
        const found = events.map(subrunBranchOf).filter((item): item is SubrunBranch => item !== null);
        setBranches(found);
        const states = await Promise.all(found.filter((item) => item.reference !== undefined).map(async (branch) => {
          const statusGeneration = nextStatusGeneration(statusGenerations.current, branch.id);
          try {
            const status = await client.call('subrun.status', {
              sessionId,
              parentRunId: branch.reference!.parentRunId,
              subrunId: branch.reference!.subrunId,
            }) as { state?: unknown; errorCode?: unknown };
            return { id: branch.id, statusGeneration, state: typeof status.state === 'string' ? status.state : 'unknown',
              ...(typeof status.errorCode === 'string' ? { errorCode: status.errorCode } : {}) };
          } catch (error) {
            return { id: branch.id, statusGeneration, state: 'unknown', errorCode: code(error) };
          }
        }));
        if (sessionGeneration.current !== generation) return;
        setBranches((current) => current.map((branch) => {
          const status = states.find((item) => item.id === branch.id);
          return status === undefined || !isCurrentStatusGeneration(statusGenerations.current, branch.id, status.statusGeneration)
            ? branch : { ...branch, state: status.state, errorCode: status.errorCode };
        }));
      } catch (error) {
        if (sessionGeneration.current === generation) setNote({ kind: 'parent', code: code(error) });
      }
    })();
    return () => {
      requestGeneration.current += 1;
      sessionGeneration.current += 1;
      branchReadGeneration.current += 1;
    };
  }, [client, sessionId]);

  const open = useCallback(async (branch: Branch) => {
    const generation = ++branchReadGeneration.current;
    setSelectedId(branch.id);
    setNote(null);
    try {
      const { events } = await client.call('session.read', { sessionId: branch.id, fullResults: true }) as { events: Record_[] };
      if (branchReadGeneration.current !== generation) return;
      setShown({ id: branch.id, rows: events.flatMap((record) => projectRecord(record)) });
    } catch (error) {
      if (branchReadGeneration.current === generation) setNote({ kind: 'branch', code: code(error) });
    }
  }, [client]);

  useEffect(() => {
    if (initialParentRunId === undefined || initialSubrunId === undefined || selectedId !== null) return;
    const branch = branches.find(item => item.reference?.parentRunId === initialParentRunId
      && item.reference.subrunId === initialSubrunId);
    if (branch !== undefined) void open(branch);
  }, [branches, initialParentRunId, initialSubrunId, open, selectedId]);

  const selected = branches.find((branch) => branch.id === selectedId) ?? null;

  const onPresetStarted = useCallback((branch: SubrunBranch) => {
    const sessionGenerationAtStart = sessionGeneration.current;
    setBranches((current) => current.some((item) => item.id === branch.id)
      ? current.map(item => item.id === branch.id ? { ...item, ...branch, state: 'starting', errorCode: undefined } : item)
      : [...current, { ...branch, state: 'starting' }]);
    setSelectedId(branch.id);
    setShown(null);
    setNote(null);
    if (sessionId === null || branch.reference === undefined) return;
    const statusGeneration = nextStatusGeneration(statusGenerations.current, branch.id);
    void client.call('subrun.status', {
      sessionId, parentRunId: branch.reference.parentRunId, subrunId: branch.reference.subrunId,
    }).then((status) => {
      const result = status as { state?: unknown; errorCode?: unknown };
      if (sessionGeneration.current !== sessionGenerationAtStart
        || !isCurrentStatusGeneration(statusGenerations.current, branch.id, statusGeneration)) return;
      setBranches((current) => current.map((item) => item.id === branch.id
        ? withStatus(item, typeof result.state === 'string' ? result.state : 'unknown', result.errorCode) : item));
    }).catch((error) => {
      if (sessionGeneration.current !== sessionGenerationAtStart
        || !isCurrentStatusGeneration(statusGenerations.current, branch.id, statusGeneration)) return;
      const errorCode = code(error);
      setBranches((current) => current.map(item => item.id === branch.id
        ? withStatus(item, 'unknown', errorCode) : item));
    });
  }, [client, sessionId]);

  const refresh = useCallback(async (branch: Branch) => {
    if (sessionId === null || branch.reference === undefined) return;
    const generation = ++requestGeneration.current;
    const statusGeneration = nextStatusGeneration(statusGenerations.current, branch.id);
    setBusyId(branch.id);
    setNote(null);
    try {
      const status = await client.call('subrun.status', {
        sessionId,
        parentRunId: branch.reference.parentRunId,
        subrunId: branch.reference.subrunId,
      }) as { state?: unknown; errorCode?: unknown };
      if (requestGeneration.current !== generation
        || !isCurrentStatusGeneration(statusGenerations.current, branch.id, statusGeneration)) return;
      setBranches((current) => current.map((item) => item.id === branch.id
        ? withStatus(item, typeof status.state === 'string' ? status.state : 'unknown', status.errorCode) : item));
    } catch (error) {
      if (requestGeneration.current === generation
        && isCurrentStatusGeneration(statusGenerations.current, branch.id, statusGeneration)) {
        const errorCode = code(error);
        setNote({ kind: 'control', code: errorCode });
        setBranches((current) => statusAfterReadFailure(current, branch.id, errorCode));
      }
    } finally {
      if (requestGeneration.current === generation) setBusyId(null);
    }
  }, [client, sessionId]);

  const wait = useCallback(async (branch: Branch) => {
    if (sessionId === null || branch.reference === undefined) return;
    const generation = ++requestGeneration.current;
    const statusGeneration = nextStatusGeneration(statusGenerations.current, branch.id);
    setBusyId(branch.id);
    setNote(null);
    try {
      const result = await client.call('subrun.wait', {
        sessionId,
        parentRunId: branch.reference.parentRunId,
        subrunIds: [branch.reference.subrunId],
        timeoutMs: 30_000,
      }, 35_000);
      if (requestGeneration.current !== generation
        || !isCurrentStatusGeneration(statusGenerations.current, branch.id, statusGeneration)) return;
      const status = result.subruns?.[0];
      setBranches((current) => current.map((item) => item.id === branch.id
        ? withStatus(item, typeof status?.state === 'string' ? status.state : 'unknown', status?.errorCode) : item));
      if (result.timedOut === true) setNote({ kind: 'control', code: 'subrun_wait_timed_out' });
    } catch (error) {
      if (requestGeneration.current === generation
        && isCurrentStatusGeneration(statusGenerations.current, branch.id, statusGeneration)) {
        const errorCode = code(error);
        setNote({ kind: 'control', code: errorCode });
        setBranches((current) => statusAfterReadFailure(current, branch.id, errorCode));
      }
    } finally {
      if (requestGeneration.current === generation) setBusyId(null);
    }
  }, [client, sessionId]);

  const sendMessage = useCallback(async (branch: Branch) => {
    if (sessionId === null || branch.reference === undefined || message.trim() === '') return;
    const submittedMessage = message;
    const submittedRevision = messageRevision.current;
    const generation = ++requestGeneration.current;
    const statusGeneration = nextStatusGeneration(statusGenerations.current, branch.id);
    setBusyId(branch.id);
    setNote(null);
    try {
      await client.call('subrun.message', {
        sessionId,
        parentRunId: branch.reference.parentRunId,
        subrunId: branch.reference.subrunId,
        runId: branch.reference.runId,
        input: submittedMessage,
      }, 15_000);
      if (requestGeneration.current !== generation
        || !isCurrentStatusGeneration(statusGenerations.current, branch.id, statusGeneration)) return;
      if (messageRevision.current === submittedRevision) {
        messageRevision.current += 1;
        setMessage('');
      }
      setNote({ kind: 'control', code: 'subrun_message_accepted' });
      const status = await client.call('subrun.status', {
        sessionId,
        parentRunId: branch.reference.parentRunId,
        subrunId: branch.reference.subrunId,
      }) as { state?: unknown; errorCode?: unknown };
      if (requestGeneration.current !== generation
        || !isCurrentStatusGeneration(statusGenerations.current, branch.id, statusGeneration)) return;
      setBranches((current) => current.map((item) => item.id === branch.id
        ? withStatus(item, typeof status.state === 'string' ? status.state : 'unknown', status.errorCode) : item));
    } catch (error) {
      if (requestGeneration.current === generation
        && isCurrentStatusGeneration(statusGenerations.current, branch.id, statusGeneration)) {
        const errorCode = code(error);
        setNote({ kind: 'control', code: errorCode });
        setBranches((current) => statusAfterReadFailure(current, branch.id, errorCode));
      }
    } finally {
      if (requestGeneration.current === generation) setBusyId(null);
    }
  }, [client, message, sessionId]);

  const cancel = useCallback(async (branch: Branch) => {
    if (sessionId === null || branch.reference === undefined) return;
    const generation = ++requestGeneration.current;
    const statusGeneration = nextStatusGeneration(statusGenerations.current, branch.id);
    setBusyId(branch.id);
    setNote(null);
    try {
      const result = await client.call('subrun.cancel', {
        sessionId,
        parentRunId: branch.reference.parentRunId,
        subrunId: branch.reference.subrunId,
        runId: branch.reference.runId,
      }) as { cancelRequested?: unknown; state?: unknown };
      if (requestGeneration.current !== generation
        || !isCurrentStatusGeneration(statusGenerations.current, branch.id, statusGeneration)) return;
      if (typeof result.state === 'string') {
        setBranches((current) => current.map((item) => item.id === branch.id
          ? withStatus(item, result.state as string, undefined) : item));
      }
      setNote({ kind: 'control', code: result.cancelRequested === true ? 'subrun_cancel_requested' : 'subrun_cancel_not_running' });
    } catch (error) {
      if (requestGeneration.current === generation
        && isCurrentStatusGeneration(statusGenerations.current, branch.id, statusGeneration)) {
        const errorCode = code(error);
        setNote({ kind: 'control', code: errorCode });
        setBranches((current) => statusAfterReadFailure(current, branch.id, errorCode));
      }
    } finally {
      if (requestGeneration.current === generation) setBusyId(null);
    }
  }, [client, sessionId]);

  return <>
    {branches.length === 0
      ? <p className="stub">{note?.kind === 'parent' ? noteText(note, t) : t('当前会话没有子任务。', 'This conversation has no subtasks.')}</p>
      : <>
        <h3>{t(`${branches.length} 个子任务`, `${branches.length} subtasks`)}</h3>
        <ul>{branches.map((branch) => <li key={branch.id}>
          <button type="button" onClick={() => void open(branch)}>{t(`记录 ${branch.seq}`, `Event ${branch.seq}`)}</button>
          <span className="muted"> {branch.task === '' ? t('（无任务说明）', '(no task description)') : branch.task.slice(0, 60)}</span>
          {branch.source !== undefined && <span className="muted"> · {branch.source === 'human'
            ? t('界面启动', 'started from UI') : t('控制器启动', 'started by controller')}</span>}
          {branch.reference !== undefined && <span className="muted"> · {branch.state ?? t('读取状态中', 'loading status')}
            {branch.errorCode === undefined ? '' : ` (${branch.errorCode})`}</span>}
        </li>)}</ul>
      </>}
    <SubrunPresetPanel client={client} sessionId={sessionId} activeRunId={activeRunId}
      runStatusKnown={runStatusKnown} onStarted={onPresetStarted} />
    {selected?.reference !== undefined && <section aria-label={t('异步子任务控制', 'Async subtask controls')}>
      <h3>{t(`子任务状态：${selected.state ?? 'unknown'}`, `Subtask state: ${selected.state ?? 'unknown'}`)}</h3>
      <div>
        <button type="button" disabled={busyId !== null} onClick={() => void refresh(selected)}>{t('刷新状态', 'Refresh status')}</button>
        <button type="button" disabled={busyId !== null} onClick={() => void wait(selected)}>{t('等待最多 30 秒', 'Wait up to 30 seconds')}</button>
        <button type="button" disabled={busyId !== null || selected.state !== 'running'} onClick={() => void cancel(selected)}>{t('取消子任务', 'Cancel subtask')}</button>
      </div>
      <form onSubmit={(event) => { event.preventDefault(); void sendMessage(selected); }}>
        <label>
          {t('补充输入', 'Message child')}
          <input aria-label={t('补充输入', 'Message child')} value={message} onChange={(event) => {
            messageRevision.current += 1;
            setMessage(event.currentTarget.value);
          }} />
        </label>
        <button type="submit" disabled={busyId !== null || selected.state !== 'running' || message.trim() === ''}>
          {t('发送', 'Send')}
        </button>
      </form>
    </section>}
    {shown !== null && <>
      <h3>{t(`子任务 ${shown.id}`, `Subtask ${shown.id}`)}</h3>
      <div className="conversation">
        {shown.rows.filter((row) => shownIn(verbosity, row)).map((row) => <RowView key={row.id} row={row} verbosity={verbosity} />)}
      </div>
    </>}
    {note !== null && <p className="stub">{noteText(note, t)}</p>}
  </>;
}
