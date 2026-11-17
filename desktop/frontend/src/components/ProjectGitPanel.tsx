import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Client } from '../protocol';
import { useText } from '../locale';
import { readProjectGitDiff, readProjectGitStatus, type ProjectGitDiff, type ProjectGitStatus, type ProjectGitStatusEntry } from '../project-git';
import { projectChangesFrom } from '../project-changes';

type HistoryPage = { readonly events: readonly Record<string, unknown>[]; readonly hasMore: boolean };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function eventPage(value: unknown): HistoryPage {
  if (!record(value) || !Array.isArray(value.events) || value.events.length > 200 || typeof value.hasMore !== 'boolean'
    || value.events.some(event => !record(event) || !Number.isSafeInteger(event.seq) || Number(event.seq) < 0)) {
    throw Object.assign(new Error('project_changes_session_response_invalid'), { code: 'project_changes_session_response_invalid' });
  }
  return { events: value.events as Record<string, unknown>[], hasMore: value.hasMore };
}

function errorCode(error: unknown): string {
  const value = error as { code?: unknown; message?: unknown };
  const code = typeof value?.code === 'string' ? value.code : typeof value?.message === 'string' ? value.message : 'project_git_unavailable';
  return /^[a-z][a-z0-9_]{0,79}$/u.test(code) ? code : 'project_git_unavailable';
}

function statusText(state: ProjectGitStatus['state'], t: (chinese: string, english: string) => string): string {
  switch (state) {
    case 'ready': return t('Git 状态已读取', 'Git status loaded');
    case 'not_repository': return t('此项目目录不是 Git 仓库根目录。', 'This project directory is not a Git repository root.');
    case 'unsupported_filter': return t('仓库配置了会执行外部程序的内容过滤器；为避免执行它，Git 状态未读取。',
      'This repository configures an external content filter. Git status was not read because that filter could run a program.');
    case 'timed_out': return t('Git 查询超时。', 'The Git query timed out.');
    case 'output_too_large': return t('Git 输出超过工作台上限。', 'Git output exceeds the workbench limit.');
    case 'invalid_path': return t('仓库包含无法安全显示的文件路径。', 'The repository contains a path that cannot be shown safely.');
    case 'unavailable': return t('Git 状态暂不可用。', 'Git status is unavailable.');
  }
}

export function ProjectGitPanel({ client, sessionId, onOpenFile, onOpenCheck }: {
  client: Client;
  sessionId: string;
  onOpenFile: (path: string, version?: string) => void;
  onOpenCheck?: (runId: string, eventSeq: number) => void;
}) {
  const t = useText();
  const [status, setStatus] = useState<ProjectGitStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [diff, setDiff] = useState<ProjectGitDiff | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryPage>({ events: [], hasMore: false });
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);
  const statusGeneration = useRef(0);
  const diffGeneration = useRef(0);
  const historyGeneration = useRef(0);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    const generation = ++statusGeneration.current;
    let active = true;
    setStatus(null);
    setStatusError(null);
    void readProjectGitStatus(client, sessionId).then(value => {
      if (!active || generation !== statusGeneration.current) return;
      setStatus(value);
      setSelectedPath(current => value.files.some(file => file.path === current)
        ? current : value.files[0]?.path ?? null);
    }).catch(error => {
      if (active && generation === statusGeneration.current) setStatusError(errorCode(error));
    });
    return () => { active = false; statusGeneration.current += 1; };
  }, [client, refresh, sessionId]);

  useEffect(() => {
    const generation = ++historyGeneration.current;
    let active = true;
    setHistory({ events: [], hasMore: false });
    setHistoryError(null);
    void client.call('session.read', { sessionId, limit: 200 }, 15_000).then(value => {
      if (active && generation === historyGeneration.current) setHistory(eventPage(value));
    }).catch(error => {
      if (active && generation === historyGeneration.current) setHistoryError(errorCode(error));
    });
    return () => { active = false; historyGeneration.current += 1; };
  }, [client, refresh, sessionId]);

  useEffect(() => {
    if (selectedPath === null) { setDiff(null); setDiffError(null); return; }
    const generation = ++diffGeneration.current;
    let active = true;
    setDiff(null);
    setDiffError(null);
    void readProjectGitDiff(client, sessionId, selectedPath).then(value => {
      if (active && generation === diffGeneration.current) setDiff(value);
    }).catch(error => {
      if (active && generation === diffGeneration.current) setDiffError(errorCode(error));
    });
    return () => { active = false; diffGeneration.current += 1; };
  }, [client, refresh, selectedPath, sessionId]);

  const rows = useMemo(() => projectChangesFrom(history.events), [history.events]);
  const selected = status?.files.find(file => file.path === selectedPath) ?? null;

  const loadOlderHistory = useCallback(async () => {
    if (history.events.length === 0 || historyBusy) return;
    const before = Number(history.events[0]?.seq);
    if (!Number.isSafeInteger(before) || before <= 0) { setHistory(current => ({ ...current, hasMore: false })); return; }
    const generation = ++historyGeneration.current;
    setHistoryBusy(true);
    try {
      const page = eventPage(await client.call('session.read', { sessionId, before, limit: 200 }, 15_000));
      if (generation === historyGeneration.current) setHistory(current => ({
        events: [...page.events, ...current.events].slice(-2000), hasMore: page.hasMore,
      }));
    } catch (error) {
      if (generation === historyGeneration.current) setHistoryError(errorCode(error));
    } finally {
      if (generation === historyGeneration.current) setHistoryBusy(false);
    }
  }, [client, history.events, historyBusy, sessionId]);

  return <section className="project-git-panel" aria-label={t('项目改动', 'Project changes')}>
    <header className="project-git-head">
      <div><strong>{t('项目改动', 'Project changes')}</strong><small>{t('只读 Git 状态和本会话记录', 'Read-only Git status and this Session’s records')}</small></div>
      <button type="button" onClick={() => setRefresh(current => current + 1)}>{t('刷新', 'Refresh')}</button>
    </header>
    {statusError !== null && <p className="stub" role="alert">{t('无法读取 Git 状态', 'Could not read Git status')} · {statusError}</p>}
    {status !== null && status.state !== 'ready' && <p className="stub" role="status">{statusText(status.state, t)}</p>}
    {status?.state === 'ready' && <>
      <div className="project-git-files" role="list" aria-label={t('改动文件', 'Changed files')}>
        {status.files.length === 0 && <p className="stub" role="status">{t('没有待处理的 Git 改动。', 'There are no pending Git changes.')}</p>}
        {status.files.map((file: ProjectGitStatusEntry) => <div key={file.path} role="listitem">
          <button type="button" aria-pressed={file.path === selectedPath} className="project-git-file" onClick={() => setSelectedPath(file.path)}>
            <span className="project-git-file-name">{file.path}</span>
            <span className="project-git-file-flags">
              {file.staged && <small>{t('已暂存', 'staged')}</small>}
              {file.unstaged && <small>{t('未暂存', 'unstaged')}</small>}
              {file.untracked && <small>{t('未跟踪', 'untracked')}</small>}
              {file.kind === 'renamed' && file.sourcePath !== undefined && <small>{t(`来自 ${file.sourcePath}`, `from ${file.sourcePath}`)}</small>}
            </span>
          </button>
        </div>)}
      </div>
      {status.truncated && <p className="project-file-incomplete" role="status">{t('文件列表已截断。', 'The file list was truncated.')}</p>}
      <section className="project-git-diff" aria-label={t('文件差异', 'File diff')}>
        <header><strong>{selected?.path ?? t('选择文件查看差异', 'Select a file to view its diff')}</strong>
          {selected !== null && <button type="button" onClick={() => onOpenFile(selected.path)}>{t('打开文件', 'Open file')}</button>}
        </header>
        {diffError !== null && <p className="stub" role="alert">{t('无法读取差异', 'Could not read diff')} · {diffError}</p>}
        {selectedPath !== null && diff === null && diffError === null && <p className="stub" role="status">{t('正在读取差异…', 'Reading diff…')}</p>}
        {diff !== null && diff.state !== 'ready' && <p className="stub" role="status">
          {diff.state === 'untracked' ? t('未跟踪文件没有 Git 基线；可打开查看当前内容。', 'Untracked files have no Git baseline; open the file to view current content.')
            : diff.state === 'binary' ? t('这是二进制文件，不显示文本差异。', 'This is a binary file; no text diff is shown.')
              : diff.state === 'output_too_large' ? t('差异超过工作台上限。', 'The diff exceeds the workbench limit.')
                : diff.state === 'no_change' ? t('所选文件当前没有文本差异。', 'The selected file has no text diff.')
                  : t('所选文件的差异不可用。', 'The selected file diff is unavailable.')}
        </p>}
        {diff?.state === 'ready' && <div className="project-git-patches">
          {diff.staged !== null && <section><h3>{t('已暂存', 'Staged')}</h3><pre>{diff.staged}</pre></section>}
          {diff.unstaged !== null && <section><h3>{t('未暂存', 'Unstaged')}</h3><pre>{diff.unstaged}</pre></section>}
        </div>}
      </section>
    </>}
    <section className="project-recorded-changes" aria-label={t('本会话记录的改动', 'Recorded changes in this Session')}>
      <h2>{t('本会话记录的改动', 'Recorded Session changes')}</h2>
      {historyError !== null && <p className="stub" role="alert">{t('无法读取会话记录', 'Could not read Session records')} · {historyError}</p>}
      {rows.changes.length === 0 && rows.checks.length === 0 && historyError === null
        && <p className="stub" role="status">{t('当前记录页没有文件改动或检查事实。', 'No file-change or check facts appear in this Session page.')}</p>}
      {rows.changes.map((change, index) => <article className="project-recorded-change" key={`${change.seq}:${change.path}:${index}`}>
        <span>{change.source === 'desktop' ? t('桌面保存', 'Desktop save') : t(`工具 ${change.tool ?? ''}`, `Tool ${change.tool ?? ''}`)} · {change.operation} · {change.outcome}</span>
        <button type="button" onClick={() => onOpenFile(change.path, change.afterVersion)}>{change.path}</button>
        <small>{change.beforeVersion ?? '—'} → {change.afterVersion ?? '—'}{change.runId === undefined ? '' : ` · Run ${change.runId.slice(0, 8)}`}</small>
      </article>)}
      {rows.checks.map(check => <article className="project-recorded-change" key={`${check.seq}:check`}>
        <span>{check.name} · {check.commandStatus} · {check.reportStatus} · {check.scopeStatus}</span>
        <small>{check.scope.length === 0 ? t('未限定文件范围', 'No file scope') : check.scope.map(path => <button type="button" key={path}
          onClick={() => onOpenFile(path)}>{path}</button>)}</small>
        {onOpenCheck !== undefined && check.runId !== undefined && <button type="button"
          onClick={() => onOpenCheck(check.runId!, check.seq)}>{t('查看检查输出', 'View check output')}</button>}
      </article>)}
      {history.hasMore && <button type="button" disabled={historyBusy} onClick={() => void loadOlderHistory()}>
        {historyBusy ? t('正在读取…', 'Loading…') : t('读取更早的记录', 'Load older records')}
      </button>}
    </section>
  </section>;
}
