import type { RefObject } from 'react';
import { Icon } from '../Icon';
import { useText } from '../../locale';
import type { SearchHit } from './types';

const HIT_KINDS: Record<string, readonly [string, string]> = {
  user: ['你问', 'You'], assistant: ['回复', 'Reply'], reasoning: ['思考', 'Reasoning'], tool: ['工具输出', 'Tool output'], label: ['会话名', 'Session name'],
};

export function SessionSearch({ expanded, query, only, current, inputRef, hits, note, rootsById, onQueryChange, onScopeToggle, onClose, onSearch, onOpenHit }: {
  expanded: boolean;
  query: string;
  only: boolean;
  current: string | null;
  inputRef: RefObject<HTMLInputElement | null>;
  hits: SearchHit[] | null;
  note: string;
  rootsById: Map<string, string>;
  onQueryChange: (query: string) => void;
  onScopeToggle: () => void;
  onClose: () => void;
  onSearch: (query: string) => void;
  onOpenHit: (hit: SearchHit, projectRoot?: string) => void;
}) {
  const t = useText();
  return <>
    {expanded && <div className="rail-controls rail-search-row">
      <label className="rail-search">
        <Icon name="search" size={13} />
        <input
          ref={inputRef}
          type="search"
          value={query}
          placeholder={only ? t('查找当前会话', 'Search this conversation') : t('搜索会话名称', 'Search conversation names')}
          aria-label={only ? t('仅在当前会话中查找', 'Search only this conversation') : t('在所有可见项目中查找', 'Search visible workspaces')}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
            if (event.key !== 'Enter' || query.trim() === '') return;
            event.preventDefault();
            onSearch(query.trim());
          }}
        />
      </label>
      <button type="button" className={`rail-scope${only ? ' on' : ''}`} aria-pressed={only} disabled={current === null}
        title={t('只查当前会话，包括完整的溢出结果。', 'Search only this conversation, including complete spilled results.')}
        onClick={onScopeToggle}>{t('当前', 'This chat')}</button>
      <button type="button" className="search-clear" aria-label={t('关闭搜索', 'Close search')} title={t('关闭搜索', 'Close search')} onClick={onClose}><Icon name="close" size={12} /></button>
    </div>}
    {hits !== null && note !== '' && <div className="rail-warning" role="status">{note}</div>}
    {hits !== null && hits.length === 0 && note === '' && <div className="rail-empty">
      {only ? t(`当前会话中没有找到“${query.trim()}”。`, `No matches in this conversation for “${query.trim()}”.`)
        : t(`可见项目中没有找到“${query.trim()}”。`, `No matches in visible workspaces for “${query.trim()}”.`)}
    </div>}
    {hits?.map((hit) => {
      const root = rootsById.get(hit.sessionId);
      const kind = HIT_KINDS[hit.kind];
      return <button
        key={`${hit.sessionId}:${hit.seq}`}
        type="button"
        className="hit-item"
        title={`${hit.sessionId} · ${t('第', '#')}${hit.seq}`}
        onClick={() => onOpenHit(hit, root === undefined || root === '' ? undefined : root)}
      >
        <span className="hit-where">
          <span className="hit-session">{hit.name?.trim() || hit.sessionId.slice(0, 8)}</span>
          <span className="hit-kind">{kind === undefined ? hit.kind : t(kind[0], kind[1])}</span>
          <span className="hit-seq">{t(`第 ${hit.seq} 条`, `#${hit.seq}`)}</span>
        </span>
        <span className="hit-text">{hit.text}</span>
        {hit.spilled !== undefined && <span className="hit-note">{t('完整结果在', 'Full result in')} {hit.spilled}</span>}
      </button>;
    })}
  </>;
}
