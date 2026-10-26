import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from 'react';
import { Virtuoso, type Components, type ContextProp, type FlatIndexLocationWithAlign, type ItemProps, type VirtuosoHandle } from 'react-virtuoso';
import type { Row } from '../rows';
import type { Verbosity } from './types';
import { RowView } from './RowView';
import { useText } from '../locale';
import type { Client } from '../protocol';

// 前插记录页时减少首条记录的全局索引，给连续分页留出空间。
export const FIRST_INDEX = 100_000;

export type StreamContext = { hasMore: boolean; loading: boolean; showEarlier: () => Promise<void> };

// 每条记录使用 Virtuoso 提供的行属性，保留可测量的独立容器。
function StreamItem({ children, style, item: _item, context: _context, ...rest }: ItemProps<Row> & ContextProp<StreamContext>) {
  return <div {...rest} style={style} className="stream-row">{children}</div>;
}

function StreamHeader({ context }: ContextProp<StreamContext>) {
  const t = useText();
  return <div className="stream-band">
    {context?.hasMore === true && <button type="button" className="earlier" disabled={context.loading} onClick={() => void context.showEarlier()}>
      {context.loading ? t('正在加载…', 'Loading…') : t('加载更早记录', 'Load earlier records')}
    </button>}
  </div>;
}

const STREAM_COMPONENTS: Components<Row, StreamContext> = { Item: StreamItem, Header: StreamHeader };
const VIEWPORT_INCREASE = { top: 240, bottom: 600 };

export function streamAnchor(rows: Row[], firstIndex: number): { id: number; offset: number } | null {
  // 用可见记录的稳定序号和像素偏移恢复分页前的阅读位置。
  const scroller = document.querySelector<HTMLElement>('[data-virtuoso-scroller="true"]');
  if (scroller === null) return null;
  const bounds = scroller.getBoundingClientRect();
  for (const item of scroller.querySelectorAll<HTMLElement>('[data-item-index]')) {
    const rect = item.getBoundingClientRect();
    if (rect.bottom <= bounds.top || rect.top >= bounds.bottom) continue;
    const row = rows[Number(item.dataset.itemIndex) - firstIndex];
    if (row !== undefined) return { id: row.id, offset: rect.top - bounds.top };
  }
  return null;
}

export function TranscriptViewport({ rows, hasRecords, reading, verbosity, flash, onBranch, onModels, pinned, setPinned, follow, initialIndex, list, firstIndex, stamp, streamContext, readerScrolling, onRangeChanged, onJumpToLatest, client, sessionId, projectRoot }: {
  rows: Row[];
  hasRecords: boolean;
  reading: boolean;
  verbosity: Verbosity;
  flash: number | null;
  onBranch?: (at: number) => void;
  onModels?: () => void;
  pinned: boolean;
  setPinned: Dispatch<SetStateAction<boolean>>;
  follow: boolean;
  initialIndex: FlatIndexLocationWithAlign;
  list: RefObject<VirtuosoHandle | null>;
  firstIndex: number;
  stamp: number;
  streamContext: StreamContext;
  readerScrolling: MutableRefObject<boolean>;
  onRangeChanged: (range: { startIndex: number }) => void;
  onJumpToLatest: () => void;
  client: Client;
  sessionId: string | null;
  projectRoot: string;
}) {
  const t = useText();
  return <div className="conversation" aria-live="polite">
    {!hasRecords ? <div className="stream-band">{reading
      ? <p className="placeholder">{t('正在打开会话…', 'Opening conversation…')}</p>
      : <div className="welcome"><img src="/icon.png" alt="" width="42" height="42" /><h1>{t('从一个想法开始', 'Start with an idea')}</h1><p>{t('提问、编写代码，或一起完成项目。', 'Ask a question, write code, or work on a project together.')}</p></div>}</div> : <Virtuoso
      key={`stream-${stamp}`}
      ref={list}
      style={{ height: '100%' }}
      data={rows}
      firstItemIndex={firstIndex}
      initialTopMostItemIndex={initialIndex}
      computeItemKey={(_index, row) => row.id}
      itemContent={(_index, row) => <RowView
        row={row}
        verbosity={verbosity}
        flash={row.seq !== undefined && row.seq === flash}
        branch={row.kind === 'round' ? onBranch : undefined}
        onModels={row.kind === 'round' ? onModels : undefined}
        client={client}
        sessionId={sessionId}
        projectRoot={projectRoot}
      />}
      followOutput={follow ? 'auto' : false}
      atBottomThreshold={40}
      onWheelCapture={(event) => { if (event.deltaY !== 0) readerScrolling.current = true; }}
      onPointerDownCapture={() => { readerScrolling.current = true; }}
      onTouchStartCapture={() => { readerScrolling.current = true; }}
      onKeyDownCapture={(event) => {
        if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) readerScrolling.current = true;
      }}
      onScroll={(event) => {
        if (!readerScrolling.current) return;
        const scroller = event.currentTarget;
        const atBottom = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 40;
        setPinned((current) => current === atBottom ? current : atBottom);
      }}
      isScrolling={(scrolling) => { if (!scrolling) readerScrolling.current = false; }}
      rangeChanged={onRangeChanged}
      increaseViewportBy={VIEWPORT_INCREASE}
      context={streamContext}
      components={STREAM_COMPONENTS}
    />}
    {!pinned && <button className="jump-latest" type="button" onClick={onJumpToLatest}>{t('回到最新', 'Jump to latest')}</button>}
  </div>;
}
