import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Client } from '../protocol';
import { code } from '../protocol';
import { readRunResult, type RunResultView } from '../run-result';
import type { FileDelivery, Record_ } from '../rows';
import { useText } from '../locale';
import { FileArtifactCard } from './FileArtifactCard';

type RunReceipt = {
  readonly runId: string;
  readonly userSeq: number;
  readonly sessionId: string;
  readonly acceptedAt: string;
  readonly state: 'accepted' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  readonly liveness?: 'alive' | 'unknown';
  readonly resultRef?: { readonly version: 1; readonly name: string; readonly bytes: number; readonly sha256: string };
};

type ArtifactRecord = { readonly artifactKey: string; readonly artifact: FileDelivery };
type CheckLog = { readonly events: readonly { readonly stream: string; readonly text: string }[]; readonly cursor?: string;
  readonly hasMore: boolean; readonly gap: boolean; readonly error?: string };

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFileArtifact(value: unknown): value is FileDelivery {
  return object(value) && value.kind === 'file' && typeof value.sessionId === 'string' && typeof value.path === 'string'
    && typeof value.mimeType === 'string' && Number.isSafeInteger(value.bytes)
    && typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(value.sha256);
}

function receiptPage(value: unknown, sessionId: string): { receipts: RunReceipt[]; hasMore: boolean; nextBefore: number | null } {
  if (!object(value) || value.sessionId !== sessionId || !Array.isArray(value.receipts)
    || typeof value.hasMore !== 'boolean'
    || !(value.nextBefore === null || Number.isSafeInteger(value.nextBefore))) {
    throw Object.assign(new Error('delivery_receipts_invalid'), { code: 'delivery_receipts_invalid' });
  }
  const receipts = value.receipts.flatMap((item): RunReceipt[] => {
    if (!object(item) || item.sessionId !== sessionId || typeof item.runId !== 'string'
      || !Number.isSafeInteger(item.userSeq) || typeof item.acceptedAt !== 'string'
      || !['accepted', 'running', 'completed', 'failed', 'cancelled', 'interrupted'].includes(String(item.state))) return [];
    return [{ runId: item.runId, userSeq: Number(item.userSeq), sessionId, acceptedAt: item.acceptedAt,
      state: item.state as RunReceipt['state'],
      ...(item.liveness === 'alive' || item.liveness === 'unknown' ? { liveness: item.liveness } : {}),
      ...(object(item.resultRef) && item.resultRef.version === 1 ? { resultRef: item.resultRef as RunReceipt['resultRef'] } : {}),
    }];
  });
  return { receipts, hasMore: value.hasMore, nextBefore: typeof value.nextBefore === 'number' ? value.nextBefore : null };
}

function artifactPage(value: unknown, sessionId: string): { items: ArtifactRecord[]; nextOffset: number | null; total: number } {
  if (!object(value) || value.sessionId !== sessionId || !Array.isArray(value.items)
    || !Number.isSafeInteger(value.total) || !(value.nextOffset === null || Number.isSafeInteger(value.nextOffset))) {
    throw Object.assign(new Error('delivery_artifact_list_invalid'), { code: 'delivery_artifact_list_invalid' });
  }
  const items = value.items.flatMap((item): ArtifactRecord[] => {
    if (!object(item) || typeof item.artifactKey !== 'string' || !/^[a-f0-9]{64}$/u.test(item.artifactKey)
      || !object(item.artifact)) return [];
    const artifact = item.artifact;
    if (artifact.kind !== 'file' || artifact.sessionId !== sessionId || typeof artifact.path !== 'string'
      || typeof artifact.mimeType !== 'string' || typeof artifact.sha256 !== 'string'
      || !Number.isSafeInteger(artifact.bytes)) return [];
    return [{ artifactKey: item.artifactKey, artifact: artifact as unknown as FileDelivery }];
  });
  return { items, nextOffset: typeof value.nextOffset === 'number' ? value.nextOffset : null, total: Number(value.total) };
}

function eventMap(events: readonly Record_[]): Map<number, Record_> {
  return new Map(events.flatMap(event => Number.isSafeInteger(event.seq) ? [[Number(event.seq), event]] : []));
}

function taskText(events: ReadonlyMap<number, string>, receipt: RunReceipt): string {
  return events.get(receipt.userSeq) ?? `Run ${receipt.runId.slice(0, 8)}`;
}

function artifactSourceSeq(events: ReadonlyMap<number, Record_>, artifact: FileDelivery): number | undefined {
  for (const [seq, event] of events) {
    if (event.kind !== 'tool' || !['present', 'subagent'].includes(String(event.tool))
      || !object(event.result) || !object(event.result.content)) continue;
    const content = event.result.content;
    const child = event.tool === 'subagent' && object(content.result) ? content.result : undefined;
    const items = event.tool === 'present' ? content.artifacts : child?.artifacts;
    if (Array.isArray(items) && items.some(item => object(item) && item.sessionId === artifact.sessionId
      && item.path === artifact.path && item.sha256 === artifact.sha256)) return seq;
  }
  return undefined;
}

function stateLabel(state: RunReceipt['state'], t: (chinese: string, english: string) => string): string {
  switch (state) {
    case 'accepted': return t('已接受', 'Accepted');
    case 'running': return t('运行中', 'Running');
    case 'completed': return t('已完成', 'Completed');
    case 'failed': return t('失败', 'Failed');
    case 'cancelled': return t('已取消', 'Cancelled');
    case 'interrupted': return t('意外中断', 'Interrupted');
  }
}

function validationLabel(status: unknown, t: (chinese: string, english: string) => string): string {
  if (status === 'valid') return t('结构化输出合格', 'Structured output valid');
  if (status === 'invalid') return t('结构化输出不合格', 'Structured output invalid');
  return t('未请求结构化输出', 'Structured output not requested');
}

export function DeliveryPanel({ client, sessionId, projectRoot, status, onOpenFile, onOpenEvent,
  onOpenArtifact, onOpenCheck, onOpenProjectChanges, onOpenDiagnostics }: {
  readonly client: Client;
  readonly sessionId: string | null;
  readonly projectRoot: string;
  readonly status: import('../status').Status | null;
  readonly onOpenFile: (path: string) => void;
  readonly onOpenEvent: (seq: number, kind: string) => void;
  readonly onOpenArtifact: (artifactKey: string) => void;
  readonly onOpenCheck: (runId: string, eventSeq: number) => void;
  readonly onOpenProjectChanges: () => void;
  readonly onOpenDiagnostics: () => void;
}) {
  const t = useText();
  const sessionGeneration = useRef(0);
  const resultGeneration = useRef(0);
  const [refresh, setRefresh] = useState(0);
  const [receipts, setReceipts] = useState<RunReceipt[]>([]);
  const [receiptsError, setReceiptsError] = useState<string | null>(null);
  const [receiptsBusy, setReceiptsBusy] = useState(false);
  const [receiptsHasMore, setReceiptsHasMore] = useState(false);
  const [receiptsBefore, setReceiptsBefore] = useState<number | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<RunResultView | null>(null);
  const [runResultError, setRunResultError] = useState<string | null>(null);
  const [runResultBusy, setRunResultBusy] = useState(false);
  const [artifacts, setArtifacts] = useState<ArtifactRecord[]>([]);
  const [artifactOffset, setArtifactOffset] = useState<number | null>(null);
  const [artifactTotal, setArtifactTotal] = useState(0);
  const [artifactsError, setArtifactsError] = useState<string | null>(null);
  const [artifactsBusy, setArtifactsBusy] = useState(false);
  const [sourceEvents, setSourceEvents] = useState<Map<number, Record_>>(new Map());
  const [checkLogs, setCheckLogs] = useState<Record<string, CheckLog>>({});

  useEffect(() => {
    const generation = ++sessionGeneration.current;
    setReceipts([]);
    setReceiptsError(null);
    setReceiptsHasMore(false);
    setReceiptsBefore(null);
    setSelectedRunId(null);
    setRunResult(null);
    setRunResultError(null);
    setArtifacts([]);
    setArtifactOffset(null);
    setArtifactTotal(0);
    setArtifactsError(null);
    setSourceEvents(new Map());
    setCheckLogs({});
    if (sessionId === null || projectRoot === '') return () => { sessionGeneration.current += 1; };
    setReceiptsBusy(true);
    setArtifactsBusy(true);
    void Promise.all([
      client.call('run.receipts', { projectRoot, sessionId, limit: 20 }, 15_000).then(value => receiptPage(value, sessionId)),
      client.call('artifact.list', { projectRoot, sessionId, limit: 50, offset: 0 }, 15_000).then(value => artifactPage(value, sessionId)),
      client.call('session.read', { sessionId, limit: 200 }, 15_000) as Promise<{ events?: Record_[] }>,
    ]).then(([receiptResult, artifactResult, sessionResult]) => {
      if (sessionGeneration.current !== generation) return;
      setReceipts(receiptResult.receipts);
      setReceiptsHasMore(receiptResult.hasMore);
      setReceiptsBefore(receiptResult.nextBefore);
      setSelectedRunId(receiptResult.receipts[0]?.runId ?? null);
      setArtifacts(artifactResult.items);
      setArtifactOffset(artifactResult.nextOffset);
      setArtifactTotal(artifactResult.total);
      setSourceEvents(eventMap(Array.isArray(sessionResult.events) ? sessionResult.events : []));
    }).catch(error => {
      if (sessionGeneration.current === generation) {
        setReceiptsError(code(error));
        setArtifactsError(code(error));
      }
    }).finally(() => {
      if (sessionGeneration.current === generation) {
        setReceiptsBusy(false);
        setArtifactsBusy(false);
      }
    });
    return () => { sessionGeneration.current += 1; };
  }, [client, projectRoot, refresh, sessionId]);

  const selectedReceipt = receipts.find(receipt => receipt.runId === selectedRunId);
  useEffect(() => {
    const generation = ++resultGeneration.current;
    setRunResult(null);
    setRunResultError(null);
    if (selectedReceipt === undefined || sessionId === null || projectRoot === ''
      || selectedReceipt.state === 'accepted' || selectedReceipt.state === 'running') {
      setRunResultBusy(false);
      return () => { resultGeneration.current += 1; };
    }
    setRunResultBusy(true);
    void readRunResult(client, projectRoot, sessionId, selectedReceipt.runId).then(result => {
      if (resultGeneration.current === generation) setRunResult(result);
    }).catch(error => {
      if (resultGeneration.current === generation) setRunResultError(code(error));
    }).finally(() => {
      if (resultGeneration.current === generation) setRunResultBusy(false);
    });
    return () => { resultGeneration.current += 1; };
  }, [client, projectRoot, selectedReceipt, sessionId]);

  const loadOlderReceipts = useCallback(async () => {
    if (sessionId === null || projectRoot === '' || receiptsBusy || receiptsBefore === null) return;
    const generation = sessionGeneration.current;
    setReceiptsBusy(true);
    setReceiptsError(null);
    try {
      const page = receiptPage(await client.call('run.receipts', {
        projectRoot, sessionId, limit: 20, before: receiptsBefore,
      }, 15_000), sessionId);
      if (sessionGeneration.current !== generation) return;
      setReceipts(current => [...current, ...page.receipts]);
      setReceiptsHasMore(page.hasMore);
      setReceiptsBefore(page.nextBefore);
    } catch (error) {
      if (sessionGeneration.current === generation) setReceiptsError(code(error));
    } finally {
      if (sessionGeneration.current === generation) setReceiptsBusy(false);
    }
  }, [client, projectRoot, receiptsBefore, receiptsBusy, sessionId]);

  const loadMoreArtifacts = useCallback(async () => {
    if (sessionId === null || projectRoot === '' || artifactsBusy || artifactOffset === null) return;
    const generation = sessionGeneration.current;
    setArtifactsBusy(true);
    setArtifactsError(null);
    try {
      const page = artifactPage(await client.call('artifact.list', {
        projectRoot, sessionId, limit: 50, offset: artifactOffset,
      }, 15_000), sessionId);
      if (sessionGeneration.current !== generation) return;
      setArtifacts(current => [...current, ...page.items]);
      setArtifactOffset(page.nextOffset);
      setArtifactTotal(page.total);
    } catch (error) {
      if (sessionGeneration.current === generation) setArtifactsError(code(error));
    } finally {
      if (sessionGeneration.current === generation) setArtifactsBusy(false);
    }
  }, [artifactOffset, artifactsBusy, client, projectRoot, sessionId]);

  const loadCheckLogs = useCallback(async (runId: string, check: Record<string, unknown>) => {
    if (sessionId === null || typeof check.executionId !== 'string') return;
    const key = JSON.stringify([runId, check.executionId]);
    try {
      const page = await client.call('execution.logs', {
        sessionId, runId, executionId: check.executionId,
        ...(checkLogs[key]?.cursor === undefined ? {} : { cursor: checkLogs[key]?.cursor }), limitBytes: 4096,
      }, 15_000) as Record<string, unknown>;
      const events = Array.isArray(page.events) ? page.events.flatMap(value => {
        if (!object(value) || typeof value.text !== 'string' || typeof value.stream !== 'string') return [];
        return [{ stream: value.stream, text: value.text }];
      }) : [];
      setCheckLogs(current => ({ ...current, [key]: {
        events: [...(current[key]?.events ?? []), ...events].slice(-128),
        ...(typeof page.nextCursor === 'string' ? { cursor: page.nextCursor } : {}),
        hasMore: page.hasMore === true,
        gap: current[key]?.gap === true || page.gap === true,
      } }));
    } catch (error) {
      setCheckLogs(current => ({ ...current, [key]: { ...(current[key] ?? { events: [], hasMore: false, gap: false }),
        error: code(error) } }));
    }
  }, [checkLogs, client, sessionId]);

  const sourceText = useMemo(() => new Map([...sourceEvents].flatMap(([seq, event]) =>
    typeof event.text === 'string' ? [[seq, event.text]] : [])), [sourceEvents]);

  if (sessionId === null || projectRoot === '') return <section aria-label={t('交付与检查', 'Deliveries and checks')}>
    <p className="stub" role="status">{t('打开一个会话后查看交付记录。', 'Open a conversation to view deliveries.')}</p>
  </section>;

  return <section className="delivery-panel" aria-label={t('交付与检查', 'Deliveries and checks')}>
    <header className="delivery-head">
      <div><h3>{t('交付与检查', 'Deliveries and checks')}</h3>
        <p>{t('显示 Host 记录的运行、文件和检查事实。', 'Shows runs, files, and checks recorded by the Host.')}</p></div>
      <button type="button" onClick={() => setRefresh(value => value + 1)}>{t('刷新', 'Refresh')}</button>
      <button type="button" onClick={onOpenDiagnostics}>{t('上下文诊断', 'Context diagnostics')}</button>
      <button type="button" onClick={onOpenProjectChanges}>{t('项目差异', 'Project diff')}</button>
    </header>
    <div className="delivery-layout">
      <section className="delivery-runs" aria-label={t('运行记录', 'Runs')}>
        <h4>{t('运行记录', 'Runs')}</h4>
        {receiptsError !== null && <p className="stub" role="alert">{t('无法读取运行记录', 'Could not read run receipts')} · {receiptsError}</p>}
        {receiptsBusy && receipts.length === 0 && <p className="stub" role="status">{t('正在读取运行记录…', 'Loading run receipts…')}</p>}
        {receipts.length === 0 && !receiptsBusy && receiptsError === null && <p className="stub" role="status">{t('当前会话还没有运行记录。', 'This conversation has no recorded runs.')}</p>}
        <ul>{receipts.map(receipt => <li key={receipt.runId}>
          <button type="button" aria-pressed={receipt.runId === selectedRunId} onClick={() => setSelectedRunId(receipt.runId)}>
            <span>{taskText(sourceText, receipt)}</span>
            <small>{stateLabel(receipt.state, t)}{receipt.liveness === 'alive' ? ` · ${t('Host 正在运行', 'Host active')}` : ''}</small>
            <code>{receipt.runId.slice(0, 8)}</code>
          </button>
          <button type="button" aria-label={`${t('打开任务记录', 'Open task event')} ${receipt.userSeq}`}
            onClick={() => onOpenEvent(receipt.userSeq, 'user')}>{t('来源', 'Source')}</button>
        </li>)}</ul>
        {receiptsHasMore && <button type="button" disabled={receiptsBusy} onClick={() => void loadOlderReceipts()}>
          {t('读取更早的运行', 'Load older runs')}
        </button>}
      </section>
      <section className="delivery-run-detail" aria-label={t('运行详情', 'Run details')}>
        {selectedReceipt === undefined && <p className="stub">{t('选择一条运行记录查看详情。', 'Select a run to view its details.')}</p>}
        {selectedReceipt !== undefined && <>
          <header className="delivery-run-header">
            <div><strong>{taskText(sourceText, selectedReceipt)}</strong><small>{selectedReceipt.runId} · {stateLabel(selectedReceipt.state, t)}</small></div>
            <button type="button" onClick={() => onOpenEvent(selectedReceipt.userSeq, 'user')}>{t('打开源记录', 'Open source event')}</button>
          </header>
          {selectedReceipt.state === 'accepted' || selectedReceipt.state === 'running'
            ? <p role="status">{selectedReceipt.liveness === 'alive' ? t('Host 正在运行此 Run。', 'The Host is running this Run.') : t('已接受，结果尚未收口。', 'Accepted; the result is not terminal yet.')}</p>
            : runResultBusy ? <p role="status">{t('正在读取 RunResult…', 'Reading RunResult…')}</p>
              : runResultError !== null ? <p role="alert">{t('RunResult 无法读取', 'RunResult is unavailable')} · {runResultError}</p>
                : runResult !== null && <>
                  <dl className="delivery-facts">
                    <dt>{t('停止原因', 'Stop reason')}</dt><dd>{runResult.stopReason}</dd>
                    <dt>{t('结构化输出', 'Structured output')}</dt><dd>{validationLabel(runResult.validation.status, t)}</dd>
                    <dt>{t('迭代 / 模型调用', 'Iterations / model calls')}</dt><dd>
                      {runResult.usage.iterations ?? t('未知', 'unknown')} / {runResult.usage.modelCalls ?? t('未知', 'unknown')}
                    </dd>
                    <dt>{t('端点 Token', 'Provider tokens')}</dt><dd>{status?.usage?.reported === null || status?.usage?.reported === undefined
                      ? t('未知', 'unknown') : `${status.usage.reported.input ?? t('未知', 'unknown')} / ${status.usage.reported.output ?? t('未知', 'unknown')}`}</dd>
                  </dl>
                  {runResult.validation.errors !== undefined && runResult.validation.errors.length > 0
                    && <ul className="delivery-errors">{runResult.validation.errors.map((error, index) => <li key={`${index}:${error}`}>{error}</li>)}</ul>}
                  {runResult.diagnostic?.code !== undefined && <p role="alert">{t('运行失败', 'Run failure')} · {runResult.diagnostic.code}</p>}
                  {runResult.output.text !== null && <details className="delivery-output">
                    <summary>{t('运行输出', 'Run output')}{runResult.output.partial === true ? ` · ${t('部分输出', 'partial')}` : ''}</summary>
                    <pre>{runResult.output.text.slice(0, 32_768)}{runResult.output.text.length > 32_768 ? '\n…' : ''}</pre>
                  </details>}
                  {runResult.artifactsTruncated === true && <p role="status">{t('产物列表已截断。', 'Artifact list was truncated.')}</p>}
                  {runResult.artifacts.filter(isFileArtifact).length > 0 && <section>
                    <h4>{t('本次 Run 产物', 'Run artifacts')}</h4>
                    {runResult.artifacts.filter(isFileArtifact).map(artifact => <article className="delivery-fact-row" key={`${artifact.path}:${artifact.sha256}`}>
                      <button type="button" onClick={() => onOpenFile(artifact.path)}>{artifact.path}</button>
                      <span>{artifact.mimeType} · {artifact.bytes} B · SHA-256 {artifact.sha256.slice(0, 12)}</span>
                    </article>)}
                  </section>}
                  {runResult.fileChanges !== undefined && <section>
                    <h4>{t('文件修改', 'File changes')}{runResult.fileChangesTruncated === true ? ` · ${t('已截断', 'truncated')}` : ''}</h4>
                    {runResult.fileChanges.length === 0 ? <p className="stub">{t('没有记录文件修改。', 'No file changes were recorded.')}</p>
                      : runResult.fileChanges.map((change, index) => <article className="delivery-fact-row" key={`${String(change.eventSeq)}:${String(change.path)}:${index}`}>
                        <span>{String(change.operation)} · {String(change.outcome)} · {String(change.baselineStatus)} → {String(change.observedStatus)}</span>
                        <button type="button" onClick={() => typeof change.path === 'string' && onOpenFile(change.path)}>{String(change.path)}</button>
                        {Number.isSafeInteger(change.eventSeq) && <button type="button" onClick={() => onOpenEvent(Number(change.eventSeq), 'tool')}>
                          {t('来源事件', 'Source event')} {String(change.eventSeq)}
                        </button>}
                      </article>)}
                  </section>}
                  {runResult.checks !== undefined && <section>
                    <h4>{t('检查', 'Checks')}{runResult.checksTruncated === true ? ` · ${t('已截断', 'truncated')}` : ''}</h4>
                    {runResult.checks.length === 0 ? <p className="stub">{t('此 Run 没有检查记录。', 'This Run has no check records.')}</p>
                      : runResult.checks.map((check, index) => {
                        const checkLogKey = typeof check.executionId === 'string' ? JSON.stringify([selectedReceipt.runId, check.executionId]) : '';
                        const checkLog = checkLogKey === '' ? undefined : checkLogs[checkLogKey];
                        return <article className="delivery-check" key={`${String(check.callId)}:${index}`}>
                          <div><strong>{String(check.name)}</strong><span>{String(check.status)} · {String(check.commandStatus)} · {String(check.reportStatus)} · {String(check.scopeStatus)}</span></div>
                          {object(check.report) && <small>{t('通过', 'passed')} {String(check.report.passed)} · {t('失败', 'failed')} {String(check.report.failed)} · {t('跳过', 'skipped')} {String(check.report.skipped)} · {t('待办', 'todo')} {String(check.report.todo)}</small>}
                          <div>
                            {Number.isSafeInteger(check.eventSeq) && <button type="button" onClick={() => onOpenEvent(Number(check.eventSeq), 'check')}>
                              {t('打开检查事件', 'Open check event')} {String(check.eventSeq)}
                            </button>}
                            {Number.isSafeInteger(check.eventSeq) && <button type="button" onClick={() => onOpenCheck(selectedReceipt.runId, Number(check.eventSeq))}>
                              {t('在工作台查看检查', 'Open check in Workbench')}
                            </button>}
                            {typeof check.executionId === 'string' && <button type="button" onClick={() => void loadCheckLogs(selectedReceipt.runId, check)}>
                              {t('读取检查输出', 'Read check output')}
                            </button>}
                            {typeof check.errorCode === 'string' && <span role="alert">{check.errorCode}</span>}
                          </div>
                          {checkLog?.error !== undefined && <p role="alert">{checkLog.error}</p>}
                          {checkLog !== undefined && <>
                            {checkLog.gap && <p role="status">{t('较早的检查输出不可用。', 'Earlier check output is unavailable.')}</p>}
                            {checkLog.events.map((event, eventIndex) => <pre className="delivery-check-log" key={`${event.stream}:${eventIndex}`}>
                              [{event.stream}] {event.text}
                            </pre>)}
                            {checkLog.hasMore && <button type="button" onClick={() => void loadCheckLogs(selectedReceipt.runId, check)}>
                              {t('读取更多检查输出', 'Load more check output')}
                            </button>}
                          </>}
                        </article>;
                      })}
                  </section>}
                </>}
        </>}
      </section>
    </div>
    <section className="delivery-artifacts" aria-label={t('已确认产物', 'Confirmed artifacts')}>
      <header><h4>{t('已确认产物', 'Confirmed artifacts')} · {artifactTotal}</h4>{artifactOffset !== null && <button type="button" disabled={artifactsBusy} onClick={() => void loadMoreArtifacts()}>
        {t('读取更多', 'Load more')}
      </button>}</header>
      {artifactsError !== null && <p role="alert">{t('无法读取产物', 'Could not list artifacts')} · {artifactsError}</p>}
      {artifacts.length === 0 && !artifactsBusy && artifactsError === null && <p className="stub">{t('当前会话没有已确认产物。', 'This Session has no confirmed artifacts.')}</p>}
      {artifacts.map(item => <article className="delivery-artifact" key={item.artifactKey}>
        <div><button type="button" onClick={() => onOpenFile(item.artifact.path)}>{item.artifact.path}</button>
          <small>{item.artifact.mimeType} · {item.artifact.bytes} B · SHA-256 {item.artifact.sha256.slice(0, 12)}</small></div>
        <button type="button" onClick={() => onOpenArtifact(item.artifactKey)}>{t('验证与预览', 'Verify and preview')}</button>
        <button type="button" onClick={() => onOpenProjectChanges()}>{t('项目差异', 'Project changes')}</button>
        {(() => {
          const sourceSeq = artifactSourceSeq(sourceEvents, item.artifact);
          return sourceSeq === undefined ? null : <button type="button" onClick={() => onOpenEvent(sourceSeq, 'tool')}>
            {t('来源事件', 'Source event')} {sourceSeq}
          </button>;
        })()}
      </article>)}
      {artifactOffset !== null && <button type="button" disabled={artifactsBusy} onClick={() => void loadMoreArtifacts()}>
        {artifactsBusy ? t('正在读取…', 'Loading…') : t('读取更多产物', 'Load more artifacts')}
      </button>}
    </section>
    <p className="delivery-diagnostics-note">{t('上下文估算和请求构成见诊断面板；请求构成收集默认关闭。', 'Context estimates and request composition are in Diagnostics; request collection is off by default.')}</p>
  </section>;
}

export function ArtifactDetailPanel({ client, sessionId, projectRoot, artifactKey, onOpenFile }: {
  readonly client: Client;
  readonly sessionId: string;
  readonly projectRoot: string;
  readonly artifactKey: string;
  readonly onOpenFile: (path: string) => void;
}) {
  const t = useText();
  const generation = useRef(0);
  const [artifact, setArtifact] = useState<FileDelivery | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const ownGeneration = ++generation.current;
    setArtifact(null);
    setFailure(null);
    setBusy(true);
    void (async () => {
      let offset = 0;
      for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
        const page = artifactPage(await client.call('artifact.list', { projectRoot, sessionId, limit: 50, offset }, 15_000), sessionId);
        const match = page.items.find(item => item.artifactKey === artifactKey);
        if (match !== undefined) {
          if (generation.current === ownGeneration) setArtifact(match.artifact);
          return;
        }
        if (page.nextOffset === null) break;
        offset = page.nextOffset;
      }
      throw Object.assign(new Error('artifact_not_in_session'), { code: 'artifact_not_in_session' });
    })().catch(error => {
      if (generation.current === ownGeneration) setFailure(code(error));
    }).finally(() => {
      if (generation.current === ownGeneration) setBusy(false);
    });
    return () => { generation.current += 1; };
  }, [artifactKey, client, projectRoot, sessionId]);

  return <section className="delivery-artifact-detail" aria-label={t('交付物详情', 'Artifact details')}>
    <h3>{t('交付物', 'Artifact')}</h3>
    {busy && <p role="status">{t('正在核对产物来源…', 'Checking artifact provenance…')}</p>}
    {failure !== null && <p role="alert">{t('产物不可用', 'Artifact unavailable')} · {failure}</p>}
    {artifact !== null && <>
      <button type="button" onClick={() => onOpenFile(artifact.path)}>{t('打开文件', 'Open file')} · {artifact.path}</button>
      <small>{artifact.mimeType} · {artifact.bytes} B · SHA-256 {artifact.sha256}</small>
      <FileArtifactCard file={artifact} client={client} sessionId={sessionId} projectRoot={projectRoot} />
    </>}
  </section>;
}

export function CheckDetailPanel({ client, sessionId, projectRoot, runId, eventSeq, onOpenEvent }: {
  readonly client: Client;
  readonly sessionId: string;
  readonly projectRoot: string;
  readonly runId: string;
  readonly eventSeq: number;
  readonly onOpenEvent: (seq: number, kind: string) => void;
}) {
  const t = useText();
  const generation = useRef(0);
  const [check, setCheck] = useState<Record<string, unknown> | null>(null);
  const [output, setOutput] = useState<CheckLog | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const readOutput = useCallback(async (executionId: string, cursor?: string) => {
    try {
      const page = await client.call('execution.logs', {
        sessionId, runId, executionId, ...(cursor === undefined ? {} : { cursor }), limitBytes: 4096,
      }, 15_000) as Record<string, unknown>;
      const events = Array.isArray(page.events) ? page.events.flatMap(value => {
        if (!object(value) || typeof value.text !== 'string' || typeof value.stream !== 'string') return [];
        return [{ stream: value.stream, text: value.text }];
      }) : [];
      setOutput(current => ({
        events: [...(current?.events ?? []), ...events].slice(-128),
        ...(typeof page.nextCursor === 'string' ? { cursor: page.nextCursor } : {}),
        hasMore: page.hasMore === true,
        gap: current?.gap === true || page.gap === true,
      }));
    } catch (error) {
      setOutput(current => ({ ...(current ?? { events: [], hasMore: false, gap: false }), error: code(error) }));
    }
  }, [client, runId, sessionId]);

  useEffect(() => {
    const ownGeneration = ++generation.current;
    setCheck(null);
    setOutput(null);
    setFailure(null);
    void (async () => {
      await client.call('session.open', { sessionId, projectRoot }, 15_000);
      const record = await client.call('session.read', { sessionId, at: eventSeq }, 15_000) as { events?: Record_[] };
      const event = record.events?.find(item => item.kind === 'check' && item.runId === runId);
      if (event === undefined) throw Object.assign(new Error('check_event_unavailable'), { code: 'check_event_unavailable' });
      if (generation.current !== ownGeneration) return;
      setCheck(event);
      const executionId = (event as Record<string, unknown>).executionId;
      if (typeof executionId === 'string') await readOutput(executionId);
    })().catch(error => {
      if (generation.current === ownGeneration) setFailure(code(error));
    });
    return () => { generation.current += 1; };
  }, [client, eventSeq, projectRoot, readOutput, runId, sessionId]);

  return <section className="delivery-check-detail" aria-label={t('检查详情', 'Check details')}>
    <h3>{t('检查输出', 'Check output')}</h3>
    {failure !== null && <p role="alert">{t('无法读取检查记录', 'Could not read check record')} · {failure}</p>}
    {check !== null && <>
      <dl className="delivery-facts">
        <dt>{t('检查项', 'Check')}</dt><dd>{object(check.declaration) && typeof check.declaration.name === 'string' ? check.declaration.name : 'unknown'}</dd>
        <dt>{t('命令退出', 'Command')}</dt><dd>{String(check.commandStatus ?? 'unknown')}</dd>
        <dt>{t('测试报告', 'Report')}</dt><dd>{String(check.reportStatus ?? 'unknown')}</dd>
        <dt>{t('文件范围', 'Scope')}</dt><dd>{String(check.scopeStatus ?? 'unknown')}</dd>
        <dt>{t('时段', 'Window')}</dt><dd>{typeof check.startedAt === 'string' || typeof check.endedAt === 'string'
          ? `${typeof check.startedAt === 'string' ? check.startedAt : t('开始时刻未知', 'start unknown')} → ${typeof check.endedAt === 'string' ? check.endedAt : t('结束时刻未知', 'end unknown')}`
          : t('未知', 'unknown')}</dd>
        <dt>{t('日志引用', 'Log reference')}</dt><dd>{object(check.logsRef) && typeof check.logsRef.bytes === 'number'
          ? t(`${check.logsRef.bytes} 字节`, `${check.logsRef.bytes} bytes`) : t('未携带', 'not carried')}</dd>
      </dl>
      <button type="button" onClick={() => onOpenEvent(eventSeq, 'check')}>{t('跳到检查事件', 'Open check event')} {eventSeq}</button>
      {output?.error !== undefined && <p role="alert">{output.error}</p>}
      {output?.gap === true && <p role="status">{t('较早的检查输出已不可用。', 'Earlier check output is unavailable.')}</p>}
      {output?.events.map((event, index) => <pre className="delivery-check-log" key={`${event.stream}:${index}`}>[{event.stream}] {event.text}</pre>)}
      {output?.hasMore === true && typeof (check as Record<string, unknown>).executionId === 'string' && <button type="button" onClick={() => void readOutput((check as Record<string, unknown>).executionId as string, output.cursor)}>
        {t('读取更多检查输出', 'Load more check output')}
      </button>}
      {output?.events.length === 0 && <p className="stub">{t('没有检查输出。', 'No check output is available.')}</p>}
    </>}
  </section>;
}
