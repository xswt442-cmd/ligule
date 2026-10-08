// 左侧栏那一份会话列表：读的是 `sessions.list`，按项目根分组（D91）。
// 记录目录只有宿主那一侧开盘，这里不猜有什么会话，读回来的就是全部。
// 查找走 `sessions.search`：那一段文字在记录里的哪一处由宿主说清，界面只管把自己这一份递到那一条上（方案 4.2）。
import { useCallback, useEffect, useState } from 'react';
import { Icon } from './Icon';
import { code, type Client } from '../protocol';

// 一条命中来自记录里哪一类事件：抬头那一格写的是它（与终端那一栏用同一组词）。
const HIT_KINDS: Record<string, string> = { user: '问', assistant: '答', reasoning: '推理', tool: '工具', label: '名字' };

export type SearchHit = {
  sessionId: string;
  name?: string;
  seq: number;
  kind: string;
  text: string;
  // 摘录出自那一次结果，而整段溢出在另一个文件里：那一段中间的部分没有在这儿搜过。
  spilled?: string;
};

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
  // 人起的名字；没起过是空串。归档只改这一栏怎么画，记录还在，也接得回来（方案 4.2、实现顺序第 75 步）。
  name?: string;
  archived?: boolean;
  // 有几条派发留在记录里没有结果：恢复时它们会被补成未知结果（D72）。
  unanswered: number;
  truncatedBytes: number;
  error?: { code: string; detail: string };
};

// 列表上那一格时间只求认得出先后：月日与时分够了。
function clock(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${at.getMonth() + 1}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

export function SessionRail({ client, current, onOpen, onOpenHit, revision, running, unread, projects, onProjects, onCreate }: {
  client: Client;
  current: string | null;
  onOpen: (id: string, projectRoot?: string) => void;
  onOpenHit: (hit: SearchHit, projectRoot?: string) => void;
  // 宿主那边多出一份记录时（分支之后），这一栏要重读一次才说得出新的那一份存在（方案 4.3）。
  revision: number;
  // 界面手里那两份运行事实：哪几份会话此刻有自己的轮次在跑，哪一份刚跑完一轮而人还没看着（方案 3.1）。
  running: string[];
  unread: string[];
  // 这一扇窗口另外看着哪几项目录（方案 3.2）：记录在哪个目录、工具在哪个目录读写，由宿主按那一份项目环境说；界面只递这一份清单。
  projects: string[];
  onProjects: (roots: string[]) => void;
  // 在那一份项目里新建一份会话（方案 3.2）：不给目录就落在这一具宿主自己的项目。
  onCreate: (root?: string) => void;
}) {
  const [groups, setGroups] = useState<[string, SessionSummary[]][]>([]);
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  // 只看这一份：那一段文字只在这一次打开的会话里找，并且读得深一层——溢出文件里的整段正文也进来（方案 4.2）。
  const [only, setOnly] = useState(false);
  // `hits` 是 null 就是没在查，那一栏画的仍是要找的会话列表。
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searchNote, setSearchNote] = useState('');
  // 另外看着哪几项目录：这一格写的是目录本身，按下「加一个项目」就并进界面偏好里（方案 3.2）。
  const [adding, setAdding] = useState('');
  const addProject = () => {
    const root = adding.trim().replace(/[/\\]+$/, '');
    if (root === '') return;
    if (!projects.includes(root)) onProjects([...projects, root]);
    setAdding('');
  };

  // 那一份记录是从哪一次指名读回来的：接它的时候按同一份项目环境递给宿主（方案 3.2）。
  const [rootsById, setRootsById] = useState(new Map<string, string>());
  const load = useCallback(async () => {
    setLoading(true);
    setNote('');
    // 每项目录各读一次：这一具宿主自己的那一份不用指名，另外看着的那几份按目录指名。
    const asked = ['', ...projects.filter((root) => root !== '')];
    const byRoot = new Map<string, SessionSummary[]>();
    // 另外加进来的那几项目录先各占一段：还没有会话的项目也要有那一格，人才能在它里面新建一份会话（方案 3.2）。
    for (const root of asked) if (root !== '') byRoot.set(root, []);
    const found = new Map<string, string>();
    const failures: string[] = [];
    for (const root of asked) {
      let sessions: SessionSummary[];
      try {
        // 这一条带超时：宿主不回时界面要停在「读不回来」那一句，不能一直停在在读。
        sessions = (await client.call('sessions.list', root === '' ? {} : { projectRoot: root }, 15_000) as { sessions: SessionSummary[] }).sessions;
      } catch (error) {
        // 某一项目录读不回来要说得出是哪一份，别的几份仍照各自真实的结果画（方案 3.3 那一句）。
        failures.push(`${root === '' ? '这一具宿主的项目' : root}：${code(error)}`);
        continue;
      }
      for (const item of sessions) {
        found.set(item.id, root);
        const key = item.projectRoot === '' ? (root === '' ? '读不出项目根' : root) : item.projectRoot;
        const list = byRoot.get(key);
        if (list === undefined) byRoot.set(key, [item]);
        else list.push(item);
      }
    }
    // 归档的那几份沉到本组底下：最近动过的仍在上面，一屏里先看到的是没归档的（方案 4.2）。
    setRootsById(found);
    setGroups([...byRoot.entries()].map(([root, items]) => [root, [...items].sort((left, right) => Number(left.archived === true) - Number(right.archived === true))] as [string, SessionSummary[]]));
    setNote(failures.join('；'));
    setLoading(false);
  }, [client, projects]);

  const search = useCallback(async (needle: string) => {
    setSearchNote('');
    const scoped = only && current !== null && current !== '';
    // 只看这一份时那一份会话已经在宿主里开着，它自己的项目环境跟着会话走；整片查找要按每一项目录各问一次。
    const asked = scoped ? [''] : ['', ...projects.filter((root) => root !== '')];
    const merged: SearchHit[] = [];
    const seen = new Set<string>();
    const failures: string[] = [];
    for (const root of asked) {
      try {
        const found = await client.call('sessions.search', {
          query: needle,
          ...(scoped ? { sessionId: current } : {}),
          ...(scoped || root === '' ? {} : { projectRoot: root }),
        }, 15_000) as { hits: SearchHit[] };
        for (const hit of found.hits) {
          const key = `${hit.sessionId}:${hit.seq}`;
          if (seen.has(key)) continue;
          seen.add(key);
          merged.push(hit);
        }
      } catch (error) {
        failures.push(`${root === '' ? '这一具宿主的项目' : root}：${code(error)}`);
      }
    }
    setHits(merged);
    setSearchNote(failures.join('；'));
  }, [client, current, only, projects]);

  useEffect(() => {
    void load();
  }, [load, revision]);

  // 查的是磁盘上那几份记录，敲一个字扫一遍太贵：等手停下问一次。
  // E04 那一条随敲随筛，因为它筛的已经是读回手里的那一份列表；这一条要宿主开盘。
  useEffect(() => {
    const needle = query.trim();
    if (needle === '') {
      setHits(null);
      return;
    }
    const timer = setTimeout(() => void search(needle), 300);
    return () => clearTimeout(timer);
  }, [query, search]);

  return <div className="sessions">
    <div className="rail-find">
      <label className="rail-search">
        <Icon name="search" size={13} />
        <input
          type="search"
          value={query}
          placeholder={only ? '在这份会话的记录里找' : '在这些会话的记录里找'}
          aria-label={only ? '只在当前这一份会话的记录里找一段文字' : '在项目根跑过的会话记录里找一段文字'}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            // Enter 不等那 300 毫秒：查不动之后这也是那一个重试的把手。
            if (event.key !== 'Enter' || query.trim() === '') return;
            event.preventDefault();
            void search(query.trim());
          }}
        />
        {query !== '' && <button type="button" className="search-clear" aria-label="清空查找" onClick={() => setQuery('')}><Icon name="close" size={12} /></button>}
      </label>
      <button
        type="button"
        className={`rail-scope${only ? ' on' : ''}`}
        aria-pressed={only}
        disabled={current === null}
        title="只在这一次打开的会话里找。这一档还会读进那一次结果溢出在文件里的整段正文。"
        onClick={() => setOnly((on) => !on)}
      >只看这一份</button>
    </div>
    {hits !== null && searchNote !== '' && <div className="session-note">{searchNote}</div>}
    {hits !== null && hits.length === 0 && searchNote === '' && (
      <div className="session-note">{only ? `这一份会话的记录里没找到「${query.trim()}」。` : `这些会话的记录里没找到「${query.trim()}」。`}</div>
    )}
    {hits?.map((hit) => <button
      key={`${hit.sessionId}:${hit.seq}`}
      type="button"
      className="hit-item"
      title={`${hit.sessionId} 的第 ${hit.seq} 条`}
      onClick={() => {
        const root = rootsById.get(hit.sessionId);
        onOpenHit(hit, root === undefined || root === '' ? undefined : root);
      }}
    >
      <span className="hit-where">
        {HIT_KINDS[hit.kind] ?? hit.kind} 第 {hit.seq} 条
        <span className="hit-session">{hit.name === undefined || hit.name === '' ? hit.sessionId.slice(0, 8) : hit.name}</span>
      </span>
      <span className="hit-text">{hit.text}</span>
      {hit.spilled !== undefined && <span className="hit-note">整段在 {hit.spilled}</span>}
    </button>)}
    {hits === null && <>
      <button type="button" className="rail-refresh" onClick={() => void load()}><Icon name="refresh" size={13} /> 刷新会话列表</button>
      {/* 另外看着哪几项目录（方案 3.2）：这一格只是界面这边的清单，记录、锁与工具目录都按那一份项目环境自己算。 */}
      <div className="rail-projects">
        {projects.map((root) => <p className="mini" key={root}>
          <span className="row-note">{root}</span>
          <button type="button" onClick={() => onProjects(projects.filter((each) => each !== root))} title="不再在这一栏里列它的项目：记录与会话都不动">不再看这一份</button>
        </p>)}
        <input
          className="project-input"
          aria-label="另一个项目的目录"
          placeholder="另一个项目的目录，写完按回车或那枚「加一个项目」"
          value={adding}
          onChange={(event) => setAdding(event.target.value)}
          onKeyDown={(event) => {
            // 组合期间的回车是候选词那一路的按键，界面不接（与输入坞同一条规矩）。
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === 'Enter') {
              event.preventDefault();
              addProject();
            }
          }}
        />
        <button type="button" onClick={addProject}>加一个项目</button>
      </div>
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
          {/* 这一份项目是这一扇窗口另外加进来的：新建时要点它自己那一份目录，不能跟着眼前看着的那一份走（方案 3.2）。 */}
          {projects.includes(root) && <button type="button" className="group-new" onClick={() => onCreate(root)}>在这一份项目里新建</button>}
        </h3>
        {items.length === 0 && <div className="session-note">这一项目录里还没有会话：按上面那枚「在这一份项目里新建」开一份。</div>}
        {items.map((item) => <button
          key={item.id}
          type="button"
          className={`session-item${item.id === current ? ' active' : ''}${item.archived === true ? ' archived' : ''}`}
          title={item.id}
          onClick={() => onOpen(item.id, item.projectRoot !== '' ? item.projectRoot : (rootsById.get(item.id) === '' ? undefined : rootsById.get(item.id)))}
        >
          <span className="session-line">
            <span className="session-when">{clock(item.updatedAt)}</span>
            <span className="session-mode">{item.mode?.name ?? '没有模式'}</span>
            <span className="session-count">{item.events} 条</span>
          </span>
          {item.name !== undefined && item.name !== '' && <span className="session-name">{item.name}</span>}
          <span className="session-id">{item.id}</span>
          {(running.includes(item.id) || unread.includes(item.id) || item.unanswered > 0 || item.formatVersion === 0 || item.truncatedBytes > 0 || item.archived === true || item.error !== undefined) && <span className="session-meta">
            {running.includes(item.id) && <span>这一份在跑</span>}
            {unread.includes(item.id) && <span>刚跑完一轮没看着</span>}
            {item.unanswered > 0 && <span>未收尾 {item.unanswered} 次派发</span>}
            {item.formatVersion === 0 && <span>没有首行</span>}
            {item.truncatedBytes > 0 && <span>尾行未完成 {item.truncatedBytes} 字节</span>}
            {item.archived === true && <span>已归档</span>}
            {item.error !== undefined && <code className="row-code">{item.error.code}</code>}
          </span>}
        </button>)}
      </section>)}
    </>}
  </div>;
}
