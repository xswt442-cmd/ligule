import { useLocale, useText } from '../../locale';
import type { SessionSummary } from './types';

function sessionDate(iso: string, locale: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(at);
}

export function SessionItem({ item, current, running, unread, root, onOpen }: {
  item: SessionSummary;
  current: string | null;
  running: boolean;
  unread: boolean;
  root?: string;
  onOpen: (id: string, projectRoot?: string) => void;
}) {
  const t = useText();
  const locale = useLocale();
  const active = item.id === current;
  const title = item.name?.trim() || `${t('未命名会话', 'Untitled session')} ${item.id.slice(0, 8)}`;
  const statuses = [running ? t('正在运行', 'Running') : '', unread ? t('有新回复', 'Unread reply') : ''].filter(Boolean);
  return <button
    type="button"
    className={`session-item${active ? ' active' : ''}${item.archived === true ? ' archived' : ''}`}
    title={`${title} · ${item.id}`}
    aria-label={`${title}${statuses.length === 0 ? '' : `, ${statuses.join(', ')}`}`}
    onClick={() => onOpen(item.id, root === undefined || root === '' ? undefined : root)}
  >
    <span className="session-name">{title}</span>
    <span className="session-trailing">
      <time className="session-date" dateTime={item.updatedAt}>{sessionDate(item.updatedAt, locale === 'zh' ? 'zh-CN' : 'en-US')}</time>
      {running && <span className="status-dot" role="img" aria-label={t('正在运行', 'Running')} title={t('正在运行', 'Running')} />}
      {unread && <span className="unread-dot" role="img" aria-label={t('有新回复', 'Unread reply')} title={t('有新回复', 'Unread reply')} />}
    </span>
  </button>;
}
