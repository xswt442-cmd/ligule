// 左侧栏那一份会话列表：读的是 `sessions.list`，按项目根分组（D91）。
// 记录目录只有宿主那一侧开盘，这里不猜有什么会话，读回来的就是全部。
import { useCallback, useEffect, useState } from 'react';
import { Icon } from './Icon';
import type { Client } from '../protocol';

export type SessionSummary = {
  id: string;
  // 没有首行的现存记录读作版本 0（D73）。
  formatVersion: number;
  projectRoot: string;
  createdAt: string | null;
  updatedAt: string;
  events: number;
  lastSeq: number;
  mode: { name: string; layer: string; digest: string } | null;
  // 有几条派发留在记录里没有结果：恢复时它们会被补成未知结果（D72）。
  unanswered: number;
  truncatedBytes: number;
  error?: { code: string; detail: string };
};

const codeOf = (error: unknown): string => (error as { code?: string; message?: string }).code
  ?? (error as { message?: string }).message ?? String(error);

// 列表上那一格时间只求认得出先后：月日与时分够了。
function clock(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${at.getMonth() + 1}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

export function SessionRail({ client, current, onOpen }: { client: Client; current: string | null; onOpen: (id: string) => void }) {
  const [groups, setGroups] = useState<[string, SessionSummary[]][]>([]);
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setNote('');
    try {
      const { sessions } = await client.call('sessions.list', {}) as { sessions: SessionSummary[] };
      const byRoot = new Map<string, SessionSummary[]>();
      for (const item of sessions) {
        const key = item.projectRoot === '' ? '读不出项目根' : item.projectRoot;
        const list = byRoot.get(key);
        if (list === undefined) byRoot.set(key, [item]);
        else list.push(item);
      }
      setGroups([...byRoot.entries()]);
    } catch (error) {
      setNote(`会话列表读不回来：${codeOf(error)}`);
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  return <div className="sessions">
    <button type="button" className="rail-refresh" onClick={() => void load()}><Icon name="refresh" size={13} /> 刷新会话列表</button>
    {loading && <div className="session-item">在读记录目录…</div>}
    {!loading && note !== '' && <div className="session-note">
      {note}
      <button type="button" onClick={() => void load()}>重试</button>
    </div>}
    {!loading && note === '' && groups.length === 0 && <div className="session-item">记录目录里还没有会话。跑一轮之后再来刷新。</div>}
    {groups.map(([root, items]) => <section key={root}>
      <h3 className="group-label" title={root}>
        <Icon name="folder" size={13} />
        <span className="group-root">{root}</span>
        <span className="group-count">{items.length}</span>
      </h3>
      {items.map((item) => <button
        key={item.id}
        type="button"
        className={`session-item${item.id === current ? ' active' : ''}`}
        title={item.id}
        onClick={() => onOpen(item.id)}
      >
        <span className="session-line">
          <span className="session-when">{clock(item.updatedAt)}</span>
          <span className="session-mode">{item.mode?.name ?? '没有模式'}</span>
          <span className="session-count">{item.events} 条</span>
        </span>
        <span className="session-id">{item.id}</span>
        {(item.unanswered > 0 || item.formatVersion === 0 || item.truncatedBytes > 0 || item.error !== undefined) && <span className="session-meta">
          {item.unanswered > 0 && <span>没收尾 {item.unanswered} 次</span>}
          {item.formatVersion === 0 && <span>没有首行</span>}
          {item.truncatedBytes > 0 && <span>尾部缺 {item.truncatedBytes} 字节</span>}
          {item.error !== undefined && <code className="row-code">{item.error.code}</code>}
        </span>}
      </button>)}
    </section>)}
  </div>;
}
