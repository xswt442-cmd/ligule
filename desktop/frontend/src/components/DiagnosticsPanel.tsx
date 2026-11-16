import { useEffect, useRef, useState } from 'react';
import { code, type Client } from '../protocol';
import { useText } from '../locale';
import type { Status } from '../status';
import { Group, Row } from './ui';

type RequestDiagnostics = { enabled: boolean; entries: Record<string, unknown>[] };

function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function number(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

export function DiagnosticsPanel({ client, sessionId, status, counts, waiting, link, logs, onReconnect }: {
  client: Client;
  sessionId: string | null;
  status: Status | null;
  counts: { sent: number; received: number };
  waiting: number;
  link: string | null;
  logs: string[];
  onReconnect: () => void;
}) {
  const t = useText();
  const requestGeneration = useRef(0);
  const [requestDiagnostics, setRequestDiagnostics] = useState<RequestDiagnostics | null>(null);
  const [diagnosticsError, setDiagnosticsError] = useState('');
  const [diagnosticsBusy, setDiagnosticsBusy] = useState(false);

  useEffect(() => {
    const generation = ++requestGeneration.current;
    setRequestDiagnostics(null);
    setDiagnosticsError('');
    if (sessionId === null) {
      setDiagnosticsBusy(false);
      return () => { requestGeneration.current += 1; };
    }
    setDiagnosticsBusy(true);
    void client.call('usage.diagnostics', { sessionId, action: 'read' }, 15_000)
      .then((result) => {
        if (requestGeneration.current === generation) setRequestDiagnostics(result as RequestDiagnostics);
      })
      .catch((error) => {
        if (requestGeneration.current === generation) setDiagnosticsError(code(error));
      })
      .finally(() => {
        if (requestGeneration.current === generation) setDiagnosticsBusy(false);
      });
    return () => { requestGeneration.current += 1; };
  }, [client, sessionId]);

  const requestDiagnosticAction = async (action: 'enable' | 'disable' | 'read') => {
    if (sessionId === null || diagnosticsBusy) return;
    const generation = ++requestGeneration.current;
    const own = sessionId;
    setDiagnosticsBusy(true);
    setDiagnosticsError('');
    try {
      const result = await client.call('usage.diagnostics', { sessionId, action }, 15_000) as RequestDiagnostics;
      if (requestGeneration.current !== generation) return;
      setRequestDiagnostics(result);
    } catch (error) {
      if (requestGeneration.current === generation) setDiagnosticsError(code(error));
    } finally {
      if (requestGeneration.current === generation && sessionId === own) setDiagnosticsBusy(false);
    }
  };

  return <>
    <Group title={t('连接', 'Connection')}>
      <Row label={t('状态', 'Status')}><span>{link === null ? t('已连接', 'Connected') : t('已断开', 'Disconnected')}</span><button type="button" onClick={onReconnect}>{t('重新连接', 'Reconnect')}</button></Row>
      <Row label={t('通信', 'Transport')}><span>stdio</span></Row>
      <Row label={t('请求', 'Requests')}><span>{counts.sent} / {counts.received} · {waiting} {t('待响应', 'pending')}</span></Row>
      {link !== null && <code>{link}</code>}
    </Group>
    {status !== null && <Group title={t('当前会话', 'Current conversation')}>
      <Row label={t('编号', 'ID')}><code>{status.sessionId}</code></Row>
      <Row label={t('事件', 'Events')}><span>{status.eventCount}</span></Row>
      <Row label={t('工具模式', 'Tool mode')}><span>{status.mode ?? '—'}</span></Row>
      <Row label={t('拒绝调用', 'Denied calls')}><span>{status.denials.total} · {status.denials.consecutive} {t('次连续拒绝', 'consecutive')}</span></Row>
      <details><summary>{t(`可用工具（${status.tools.length}）`, `Available tools (${status.tools.length})`)}</summary><ul>{status.tools.map((tool) => <li key={tool}><code>{tool}</code></li>)}</ul></details>
    </Group>}
    <Group title={t('请求构成诊断', 'Request composition diagnostics')}>
      <p className="stub">{t('按需启用；只暂存在 Host 内存，不含提示正文或工具参数。', 'Opt in when needed; held in Host memory and excludes prompt text and tool arguments.')}</p>
      <div>
        <button type="button" disabled={sessionId === null || diagnosticsBusy || requestDiagnostics?.enabled === true}
          onClick={() => void requestDiagnosticAction('enable')}>{t('开启', 'Enable')}</button>
        <button type="button" disabled={sessionId === null || diagnosticsBusy || requestDiagnostics?.enabled !== true}
          onClick={() => void requestDiagnosticAction('disable')}>{t('关闭并清空', 'Disable and clear')}</button>
        <button type="button" disabled={sessionId === null || diagnosticsBusy}
          onClick={() => void requestDiagnosticAction('read')}>{t('读取最近记录', 'Read recent requests')}</button>
      </div>
      {diagnosticsError !== '' && <p className="stub">{t(`诊断读取失败：${diagnosticsError}`, `Could not read diagnostics: ${diagnosticsError}`)}</p>}
      {requestDiagnostics !== null && <>
        <p>{requestDiagnostics.enabled ? t(`已开启 · ${requestDiagnostics.entries.length} 条最近请求（最多 32 条）`, `Enabled · ${requestDiagnostics.entries.length} recent requests (maximum 32)`) : t('已关闭', 'Disabled')}</p>
        {requestDiagnostics.entries.map((entry, index) => {
          const components = object(entry.components);
          const truncation = object(entry.truncation);
          const compaction = object(entry.compaction);
          const resolvedImages = object(entry.resolvedImages);
          const cache = object(entry.cache);
          const id = typeof entry.requestId === 'string' ? entry.requestId.slice(0, 8) : 'request';
          const model = [entry.provider, entry.model].filter((part): part is string => typeof part === 'string').join('/');
          const usage = (value: unknown) => typeof value === 'number' ? String(value) : t('未知', 'unknown');
          const ranges = Array.isArray(compaction.blocks) ? compaction.blocks.flatMap((block) => {
            const item = object(block);
            return typeof item.fromSeq === 'number' && typeof item.toSeq === 'number' ? [`${item.fromSeq}–${item.toSeq}`] : [];
          }) : [];
          return <details key={`${id}:${String(entry.attempt)}:${index}`}>
            <summary>{id} · {model || 'unknown'} · {String(entry.status ?? 'unknown')}</summary>
            <ul>
              <li>{t(`估算 ${number(entry.estimatedInputTokens)} tokens；端点输入 ${usage(entry.inputTokens)}、输出 ${usage(entry.outputTokens)}；缓存命中 ${usage(cache.hitInputTokens)}、未命中 ${usage(cache.missInputTokens)}`,
                `Estimate ${number(entry.estimatedInputTokens)} tokens; Provider input ${usage(entry.inputTokens)}, output ${usage(entry.outputTokens)}; cache hit ${usage(cache.hitInputTokens)}, miss ${usage(cache.missInputTokens)}`)}</li>
              <li>{t(`系统 ${number(components.systemBytes)} 字节；前缀 ${number(components.systemPrefixBytes)}；指南 ${number(components.projectGuideBytes)}；动态 ${number(components.dynamicContextBytes)}；工具 Schema ${number(components.toolSchemaBytes)}；历史 ${number(components.historyBytes)}；图片 ${number(components.imageReferenceCount)} 个（引用 ${number(components.imageReferenceBytes)} 字节；已解析 ${number(resolvedImages.count)} 个、${number(resolvedImages.bytes)} 字节）`,
                `System ${number(components.systemBytes)} bytes; prefix ${number(components.systemPrefixBytes)}; guides ${number(components.projectGuideBytes)}; dynamic ${number(components.dynamicContextBytes)}; tool schemas ${number(components.toolSchemaBytes)}; history ${number(components.historyBytes)}; images ${number(components.imageReferenceCount)} (${number(components.imageReferenceBytes)} reference bytes; ${number(resolvedImages.count)} resolved, ${number(resolvedImages.bytes)} bytes)`)}</li>
              <li>{t(`提示片段截断 ${number(truncation.promptFragments)} 处；准备时消息 ${number(truncation.messagesBeforePreparation)} → ${number(truncation.messagesAfterPreparation)}；检查点 ${String(compaction.checkpointValidation ?? 'unknown')}${typeof compaction.checkpointValidationReason === 'string' ? `（${compaction.checkpointValidationReason}）` : ''}；压缩块 ${ranges.length === 0 ? '无' : ranges.join('、')}；摘要请求 ${number(compaction.summaryRequests)} 次（${String(compaction.summaryUsageScope ?? 'unknown')}），输入 ${usage(compaction.summaryInputTokens)}、输出 ${usage(compaction.summaryOutputTokens)}、缓存 ${usage(compaction.summaryCachedInputTokens)}`,
                `${number(truncation.promptFragments)} prompt fragments truncated; preparation changed messages ${number(truncation.messagesBeforePreparation)} → ${number(truncation.messagesAfterPreparation)}; checkpoint ${String(compaction.checkpointValidation ?? 'unknown')}${typeof compaction.checkpointValidationReason === 'string' ? ` (${compaction.checkpointValidationReason})` : ''}; compaction blocks ${ranges.length === 0 ? 'none' : ranges.join(', ')}; ${number(compaction.summaryRequests)} summary requests (${String(compaction.summaryUsageScope ?? 'unknown')}), input ${usage(compaction.summaryInputTokens)}, output ${usage(compaction.summaryOutputTokens)}, cached ${usage(compaction.summaryCachedInputTokens)}`)}</li>
            </ul>
          </details>;
        })}
      </>}
    </Group>
    <Group title={t('宿主日志', 'Host logs')}>
      <details>
        <summary>{t(`最近 ${logs.length} 行`, `Latest ${logs.length} lines`)}</summary>
        {logs.length === 0 ? <p className="stub">{t('暂无日志。', 'No logs yet.')}</p>
          : <ol>{logs.map((line, index) => <li key={`${index}:${line}`}><code>{line}</code></li>)}</ol>}
      </details>
    </Group>
  </>;
}
