import type { PointerEvent, ReactNode } from 'react';
import { Icon } from './Icon';
import { useText } from '../locale';
import type { WorkbenchState } from '../workbench';

export function WorkbenchDock({
  state,
  activeTitle,
  error,
  onSelect,
  onCloseTab,
  onHide,
  onResizeStart,
  children,
}: {
  state: WorkbenchState;
  activeTitle: string | null;
  error?: string | null;
  onSelect: (key: string) => void;
  onCloseTab: (key: string) => void;
  onHide: () => void;
  onResizeStart: (event: PointerEvent<HTMLDivElement>) => void;
  children: ReactNode;
}) {
  const t = useText();
  const focusTab = (index: number, key: string) => {
    onSelect(key);
    const tabs = document.querySelectorAll<HTMLButtonElement>('.workbench-tablist [role="tab"]');
    tabs[index]?.focus();
  };
  return <aside className="dock workbench-dock" style={{ flexBasis: `min(${state.rightWidth}px, 100vw)`, inlineSize: `min(${state.rightWidth}px, 100vw)` }}>
    <div className="dock-resize" role="separator" aria-orientation="vertical"
      aria-label={t('工作台宽度', 'Workbench width')} onPointerDown={onResizeStart} />
    <div className="dock-head workbench-head">
      <div className="workbench-tablist" role="tablist" aria-label={t('工作台标签', 'Workbench tabs')}>
        {state.tabs.map(tab => <button key={tab.key} className="workbench-tab-item" type="button" role="tab"
          aria-selected={tab.key === state.activeKey} aria-controls="workbench-active-view" title={tab.title}
          tabIndex={tab.key === state.activeKey || (state.activeKey === null && tab.key === state.tabs[0]?.key) ? 0 : -1}
          data-active={tab.key === state.activeKey ? 'true' : undefined} onClick={() => onSelect(tab.key)}
          onKeyDown={event => {
            const currentIndex = state.tabs.findIndex(candidate => candidate.key === tab.key);
            const nextIndex = event.key === 'ArrowRight' ? (currentIndex + 1) % state.tabs.length
              : event.key === 'ArrowLeft' ? (currentIndex - 1 + state.tabs.length) % state.tabs.length
                : event.key === 'Home' ? 0 : event.key === 'End' ? state.tabs.length - 1 : -1;
            if (nextIndex < 0) return;
            event.preventDefault();
            const next = state.tabs[nextIndex];
            if (next !== undefined) focusTab(nextIndex, next.key);
          }}>
          <span>{tab.title}</span>
        </button>)}
      </div>
      {activeTitle !== null && state.activeKey !== null && <button type="button" className="icon-button workbench-tab-close"
        aria-label={`${t('关闭', 'Close')} ${activeTitle}`} onClick={() => onCloseTab(state.activeKey!)}>
        <Icon name="close" size={13} />
      </button>}
      <button type="button" className="icon-button" aria-label={t('隐藏工作台', 'Hide workbench')} onClick={onHide}>
        <Icon name="close" size={15} />
      </button>
    </div>
    <div id="workbench-active-view" className="dock-body" role="tabpanel" aria-label={activeTitle ?? t('工作台', 'Workbench')}>
      {error !== undefined && error !== null && <p className="stub" role="alert">{t('无法打开这个工作区标签。', 'Could not open this workbench tab.')}
        {/^[a-z][a-z0-9_]{0,79}$/u.test(error) ? ` · ${error}` : ''}</p>}
      {children}
    </div>
  </aside>;
}
