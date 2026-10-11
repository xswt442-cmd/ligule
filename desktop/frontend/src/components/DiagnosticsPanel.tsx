import { useText } from '../locale';
import type { Status } from '../status';
import { Group, Row } from './ui';

export function DiagnosticsPanel({ status, counts, waiting, link, logs, onReconnect }: {
  status: Status | null;
  counts: { sent: number; received: number };
  waiting: number;
  link: string | null;
  logs: string[];
  onReconnect: () => void;
}) {
  const t = useText();
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
    <Group title={t('宿主日志', 'Host logs')}>
      <details>
        <summary>{t(`最近 ${logs.length} 行`, `Latest ${logs.length} lines`)}</summary>
        {logs.length === 0 ? <p className="stub">{t('暂无日志。', 'No logs yet.')}</p>
          : <ol>{logs.map((line, index) => <li key={`${index}:${line}`}><code>{line}</code></li>)}</ol>}
      </details>
    </Group>
  </>;
}
