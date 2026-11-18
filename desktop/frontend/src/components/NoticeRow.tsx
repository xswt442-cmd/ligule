import type { RowProps } from './types';
import { useText } from '../locale';

export function NoticeRow({ row, onOpenSideSession }: RowProps) {
  const t = useText();
  return <article className={`row ${row.kind}`} data-kind={row.kind}>
    <div className="row-body">{row.text}</div>
    {row.sideSession !== undefined && onOpenSideSession !== undefined && <button type="button"
      onClick={() => onOpenSideSession(row.sideSession!.sessionId, row.sideSession!.originSessionId)}>
      {t('打开侧聊', 'Open side chat')}
    </button>}
  </article>;
}
