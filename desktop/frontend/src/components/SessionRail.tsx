// 左侧栏那一份会话列表：读的是 `sessions.list`，按项目根分组（D91）。
// 记录目录只有宿主那一侧开盘，这里不猜有什么会话，读回来的就是全部。
// 查找走 `sessions.search`：那一段文字在记录里的哪一处由宿主说清，界面只管把自己这一份递到那一条上（方案 4.2）。
// 组名与「默认」那一枚标签读的是 `workspaces.list` 那份持久登记：这一栏只是它的一个读者，收起或列不出来都不改那份文件（方案 5.5.1）。
import { useCallback, useEffect, useRef, useState } from 'react';
import { DropdownMenu, Popover } from 'radix-ui';
import { Icon } from './Icon';
import { useLocale, useText } from '../locale';
import { groupByWorkspace, type RailLayout, type WorkspaceRoster, visibleRoots } from '../rail';
import { code, type Client } from '../protocol';
import { keepEscape } from './ui';

const HIT_KINDS: Record<string, readonly [string, string]> = {
  user: ['问', 'User'], assistant: ['答', 'Assistant'], reasoning: ['推理', 'Reasoning'], tool: ['工具', 'Tool'], label: ['名字', 'Name'],
};

const PROJECT_FAILURES: Record<string, readonly [string, string]> = {
  host_project_root_missing: ['目录不存在', 'Directory does not exist'],
  host_project_root_not_directory: ['路径不是目录', 'Path is not a directory'],
  host_project_root_unreadable: ['目录无法读取', 'Directory cannot be read'],
  host_project_root_mismatch: ['目录与项目根不一致', 'Directory does not match the project root'],
  host_project_root_unsupported: ['宿主不支持读取该项目', 'The Host cannot read this project'],
  workspace_registry_invalid: ['工作区登记无法读取', 'Workspace registry cannot be read'],
  workspace_registry_version: ['工作区登记版本不受支持', 'Workspace registry version is unsupported'],
  workspace_registry_locked: ['工作区登记正在更新', 'Workspace registry is being updated'],
};

type RailFailure = { root: string; label: string; code: string };

function pathKey(root: string): string {
  return root.replace(/[/\\]+$/, '').toLowerCase();
}

function pathLeaf(root: string): string {
  return root.split(/[\\/]+/).filter(Boolean).at(-1) ?? root;
}

function normalizedRoot(value: string): string {
  const root = value.trim();
  if (/^[\\/]+$/.test(root)) return root[0];
  if (/^[A-Za-z]:[\\/]+$/.test(root)) return `${root.slice(0, 2)}\\`;
  return root.replace(/[\\/]+$/, '');
}

function failureText(t: (chinese: string, english: string) => string, label: string, errorCode: string): string {
  const message = PROJECT_FAILURES[errorCode];
  return `${label}: ${message === undefined ? t('读取失败', 'Could not read') : t(message[0], message[1])}`;
}

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
  // 归组用的那两格（方案 5.5.3、5.5.4）：空串说的是首行没写这两格，与「默认那一具」是两件事。
  workspace?: string;
  workspaceOrigin?: string;
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

function sessionDate(iso: string, locale: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(at);
}

export function SessionRail({ client, current, onOpen, onOpenHit, revision, running, unread, projects, hidden, onHidden, onProjects, onCreate }: {
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
  hidden: string[];
  onHidden: (roots: string[]) => void;
  onProjects: (roots: string[]) => void;
  // 在那一份项目里新建一份会话（方案 3.2）：不给目录就落在这一具宿主自己的项目。
  onCreate: (root?: string) => void;
}) {
  const t = useText();
  const locale = useLocale();
  const [layout, setLayout] = useState<RailLayout>({ groups: [], loose: [] });
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  const [failures, setFailures] = useState<RailFailure[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [only, setOnly] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searchNote, setSearchNote] = useState('');
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [projectDraft, setProjectDraft] = useState('');
  const [projectFailure, setProjectFailure] = useState('');
  const [addingProject, setAddingProject] = useState(false);
  const [rootsById, setRootsById] = useState(new Map<string, string>());
  const [visible, setVisible] = useState<string[]>(['']);
  const loadGeneration = useRef(0);
  const searchGeneration = useRef(0);
  const isHidden = useCallback((root: string) => root !== '' && hidden.some(item => pathKey(item) === pathKey(root)), [hidden]);

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    searchGeneration.current += 1;
    setLoading(true);
    setFailures([]);
    setHits(null);
    let registryFailure: RailFailure | undefined;
    const read = await client.call('workspaces.list', {}, 15_000)
      .then((answer) => answer as WorkspaceRoster)
      .catch((error) => {
        registryFailure = { root: '', label: t('工作区登记', 'Workspace registry'), code: code(error) };
        return { default: null, workspaces: [] } as WorkspaceRoster;
      });
    if (generation !== loadGeneration.current) return;
    const asked = visibleRoots(read, projects.filter(root => !isHidden(root))).filter(root => !isHidden(root));
    setVisible(asked);
    const pages = await Promise.all(asked.map(async (root) => {
      try {
        return { root, sessions: (await client.call('sessions.list', root === '' ? {} : { projectRoot: root }, 15_000) as { sessions: SessionSummary[] }).sessions, failed: '' };
      } catch (error) {
        return { root, sessions: [] as SessionSummary[], failed: code(error) };
      }
    }));
    if (generation !== loadGeneration.current) return;
    const all: SessionSummary[] = [];
    const found = new Map<string, string>();
    const nextFailures: RailFailure[] = registryFailure === undefined ? [] : [registryFailure];
    for (const page of pages) {
      if (page.failed !== '') {
        nextFailures.push({ root: page.root, label: page.root === '' ? t('此项目', 'Host project') : pathLeaf(page.root), code: page.failed });
      }
      for (const item of page.sessions) {
        if (found.has(item.id)) continue;
        const root = item.projectRoot !== '' ? item.projectRoot : page.root;
        found.set(item.id, root);
        if (isHidden(root)) continue;
        all.push(item);
      }
    }
    setRootsById(found);
    setLayout(groupByWorkspace(all, asked, read));
    setFailures(nextFailures);
    setLoading(false);
  }, [client, projects, hidden, isHidden, t]);

  // 换默认工作区只有这一处落笔：写完重读那份登记，画面上那一枚开关说的就是宿主存下来之后的样子（方案 5.5.1、5.5.3）。
  const markDefault = useCallback(async (root: string, clearing: boolean) => {
    try {
      await client.call('workspace.default.set', { directory: clearing ? '' : root }, 15_000);
    } catch (error) {
      setFailures([{ root, label: t(clearing ? '取消默认工作区' : '设置默认工作区', clearing ? 'Clear default workspace' : 'Set default workspace'), code: code(error) }]);
      return;
    }
    void load();
  }, [client, load, t]);

  const addProject = useCallback(async () => {
    const root = normalizedRoot(projectDraft);
    if (root === '' || addingProject) return;
    setAddingProject(true);
    setProjectFailure('');
    try {
      await client.call('sessions.list', { projectRoot: root }, 15_000);
      if (isHidden(root)) onHidden(hidden.filter(item => pathKey(item) !== pathKey(root)));
      else if (!projects.some(item => pathKey(item) === pathKey(root))
        && !layout.groups.some(group => pathKey(group.root) === pathKey(root))) onProjects([...projects, root]);
      setProjectDraft('');
      setPopoverOpen(false);
    } catch (error) {
      setProjectFailure(failureText(t, pathLeaf(root) || root, code(error)));
    } finally {
      setAddingProject(false);
    }
  }, [addingProject, client, hidden, isHidden, layout.groups, onHidden, onProjects, projectDraft, projects, t]);

  const hideWorkspace = (root: string) => {
    searchGeneration.current += 1;
    setHits(null);
    if (!hidden.some(item => pathKey(item) === pathKey(root))) onHidden([...hidden, root]);
  };

  const restoreWorkspace = (root: string) => {
    searchGeneration.current += 1;
    setHits(null);
    onHidden(hidden.filter(item => pathKey(item) !== pathKey(root)));
  };

  const search = useCallback(async (needle: string) => {
    const generation = ++searchGeneration.current;
    setSearchNote('');
    const scoped = only && current !== null && current !== '';
    if (scoped && isHidden(rootsById.get(current) ?? '')) {
      setHits([]);
      return;
    }
    const asked = scoped ? [''] : visible;
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
        if (generation !== searchGeneration.current) return;
        for (const hit of found.hits) {
          const key = `${hit.sessionId}:${hit.seq}`;
          if (isHidden(rootsById.get(hit.sessionId) ?? '')) continue;
          if (seen.has(key)) continue;
          seen.add(key);
          merged.push(hit);
        }
      } catch (error) {
        if (generation !== searchGeneration.current) return;
        failures.push(failureText(t, root === '' ? t('此项目', 'Host project') : pathLeaf(root), code(error)));
      }
    }
    if (generation !== searchGeneration.current) return;
    setHits(merged);
    setSearchNote(failures.join(' · '));
  }, [client, current, isHidden, only, rootsById, t, visible]);

  useEffect(() => {
    void load();
  }, [load, revision]);

  // 查的是磁盘上那几份记录，敲一个字扫一遍太贵：等手停下问一次。
  // E04 那一条随敲随筛，因为它筛的已经是读回手里的那一份列表；这一条要宿主开盘。
  // 还在读列表时先不问：那一份目录清单要等那一次读回来才成形，早问一步搜的是不全的几项目录（审阅 F3）。
  useEffect(() => {
    const generation = ++searchGeneration.current;
    const needle = query.trim();
    if (needle === '') {
      setHits(null);
      setSearchNote('');
      return;
    }
    if (loading) return;
    const timer = setTimeout(() => {
      if (generation === searchGeneration.current) void search(needle);
    }, 300);
    return () => clearTimeout(timer);
  }, [query, search, loading]);

  const sessionRow = (item: SessionSummary) => {
    const active = item.id === current;
    const isRunning = running.includes(item.id);
    const isUnread = unread.includes(item.id);
    const root = item.projectRoot !== '' ? item.projectRoot : rootsById.get(item.id);
    const title = item.name?.trim() || `${t('未命名会话', 'Untitled session')} ${item.id.slice(0, 8)}`;
    const statuses = [
      isRunning ? t('正在运行', 'Running') : '',
      isUnread ? t('有新回复', 'Unread reply') : '',
    ].filter(Boolean);
    return <button
      key={item.id}
      type="button"
      className={`session-item${active ? ' active' : ''}${item.archived === true ? ' archived' : ''}`}
      title={item.id}
      aria-label={`${title}${statuses.length === 0 ? '' : `, ${statuses.join(', ')}`}`}
      onClick={() => onOpen(item.id, root === undefined || root === '' ? undefined : root)}
    >
      <span className="session-name">{title}</span>
      <span className="session-trailing">
        <time className="session-date" dateTime={item.updatedAt}>{sessionDate(item.updatedAt, locale === 'zh' ? 'zh-CN' : 'en-US')}</time>
        {isRunning && <span className="status-dot" role="img" aria-label={t('正在运行', 'Running')} title={t('正在运行', 'Running')} />}
        {isUnread && <span className="unread-dot" role="img" aria-label={t('有新回复', 'Unread reply')} title={t('有新回复', 'Unread reply')} />}
      </span>
    </button>;
  };

  const archivedCount = [...layout.groups.flatMap(group => group.sessions), ...layout.loose]
    .filter(item => item.archived === true).length;
  const visibleSessions = (items: SessionSummary[]) => showArchived ? items : items.filter(item => item.archived !== true);
  const visibleLoose = visibleSessions(layout.loose);
  const reportFailure = (failure: RailFailure) => failureText(t, failure.label, failure.code);

  return <div className="sessions">
    <div className="rail-find">
      <label className="rail-search">
        <Icon name="search" size={13} />
        <input
          type="search"
          value={query}
          placeholder={only ? t('查找当前会话', 'Search this conversation') : t('查找所有会话', 'Search conversations')}
          aria-label={only ? t('仅在当前会话中查找', 'Search only this conversation') : t('在所有可见项目中查找', 'Search visible workspaces')}
          onChange={(event) => {
            searchGeneration.current += 1;
            setQuery(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.keyCode === 229 || query.trim() === '') return;
            event.preventDefault();
            void search(query.trim());
          }}
        />
        {query !== '' && <button type="button" className="search-clear" aria-label={t('清空查找', 'Clear search')} onClick={() => setQuery('')}><Icon name="close" size={12} /></button>}
      </label>
      <button
        type="button"
        className={`rail-scope${only ? ' on' : ''}`}
        aria-pressed={only}
        disabled={current === null}
        title={t('只查当前会话，包括完整的溢出结果。', 'Search only this conversation, including complete spilled results.')}
        onClick={() => {
          searchGeneration.current += 1;
          setOnly(value => !value);
        }}
      >{t('当前', 'This chat')}</button>
    </div>

    {hits !== null && searchNote !== '' && <div className="rail-warning" role="status">{searchNote}</div>}
    {hits !== null && hits.length === 0 && searchNote === '' && <div className="rail-empty">
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
          {kind === undefined ? hit.kind : t(kind[0], kind[1])} {t(`第 ${hit.seq} 条`, `#${hit.seq}`)}
          <span className="hit-session">{hit.name?.trim() || hit.sessionId.slice(0, 8)}</span>
        </span>
        <span className="hit-text">{hit.text}</span>
        {hit.spilled !== undefined && <span className="hit-note">{t('完整结果在', 'Full result in')} {hit.spilled}</span>}
      </button>;
    })}

    {hits === null && <>
      <div className="rail-heading">
        <strong>{t('工作区', 'Workspaces')}</strong>
        <button type="button" className="icon-button" aria-label={t('刷新会话列表', 'Refresh conversations')} title={t('刷新会话列表', 'Refresh conversations')} onClick={() => void load()}><Icon name="refresh" size={14} /></button>
        <Popover.Root open={popoverOpen} onOpenChange={setPopoverOpen}>
          <Popover.Trigger asChild>
            <button type="button" className="icon-button" aria-label={t('添加工作区', 'Add workspace')} title={t('添加工作区', 'Add workspace')}><Icon name="plus" size={16} /></button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content className="workspace-pop" side="bottom" align="start" sideOffset={6} aria-label={t('添加工作区', 'Add workspace')} onEscapeKeyDown={keepEscape}>
              <label>
                <span>{t('现有目录', 'Existing directory')}</span>
                <input
                  type="text"
                  value={projectDraft}
                  placeholder={t('输入目录路径', 'Enter a directory path')}
                  aria-label={t('工作区目录路径', 'Workspace directory path')}
                  title={projectDraft}
                  disabled={addingProject}
                  onChange={(event) => { setProjectDraft(event.target.value); setProjectFailure(''); }}
                  onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void addProject();
                    }
                  }}
                />
              </label>
              {projectFailure !== '' && <div className="workspace-failure" role="alert">{projectFailure}</div>}
              <div>
                <Popover.Close asChild><button type="button" disabled={addingProject}>{t('取消', 'Cancel')}</button></Popover.Close>
                <button type="button" disabled={addingProject || projectDraft.trim() === ''} onClick={() => void addProject()}>
                  {addingProject ? t('检查中…', 'Checking…') : t('确认', 'Add')}
                </button>
              </div>
              {hidden.length > 0 && <section>
                <h4>{t('已从侧栏隐藏', 'Hidden from sidebar')}</h4>
                {hidden.map(root => <p key={root}>
                  <span title={root}>{pathLeaf(root) || root}</span>
                  <button type="button" onClick={() => restoreWorkspace(root)}>{t('恢复', 'Restore')}</button>
                </p>)}
              </section>}
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      </div>

      {failures.length > 0 && <details className="rail-warning">
        <summary>{t('有工作区无法读取', 'Some workspaces could not be read')} · {failures.length}</summary>
        <div>
          {failures.map((failure, index) => <div className="workspace-failure" key={`${failure.root}:${failure.code}:${index}`}>
            <span title={failure.root}>{reportFailure(failure)}</span>
            <code>{failure.code}</code>
            {failure.root !== '' && <button type="button" onClick={() => hideWorkspace(failure.root)}>{t('从侧栏移除', 'Remove from sidebar')}</button>}
          </div>)}
        </div>
      </details>}

      {loading && <div className="rail-empty">{t('正在读取会话…', 'Loading conversations…')}</div>}
      {!loading && layout.groups.length === 0 && visibleLoose.length === 0 && <div className="rail-empty">{t('还没有会话。开始一轮后会显示在这里。', 'No conversations yet. Start a turn to see it here.')}</div>}

      {layout.groups.map((group) => {
        const sessions = visibleSessions(group.sessions);
        const isFolded = folded[group.identity] === true;
        return <section className="rail-group" key={group.identity}>
          <h3 className="group-label">
            <button
              type="button"
              className="group-fold"
              aria-expanded={!isFolded}
              title={group.root}
              onClick={() => setFolded(now => ({ ...now, [group.identity]: !now[group.identity] }))}
            >
              <Icon name={isFolded ? 'unfold' : 'fold'} size={13} />
              <Icon name="folder" size={14} />
              <span className="group-root">{group.label}{group.isDefault ? ` · ${t('默认', 'Default')}` : ''}</span>
            </button>
            <span className="group-count">{sessions.length}</span>
            <button type="button" className="group-new" title={t(`在 ${group.label} 中新建会话`, `New conversation in ${group.label}`)} aria-label={t(`在 ${group.label} 中新建会话`, `New conversation in ${group.label}`)} onClick={() => onCreate(group.root)}>
              <Icon name="plus" size={15} />
            </button>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button type="button" className="icon-button group-menu" aria-label={t(`${group.label}工作区菜单`, `${group.label} workspace menu`)} title={t('工作区菜单', 'Workspace menu')}><Icon name="more" size={17} /></button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content className="menu" align="end" sideOffset={4} onEscapeKeyDown={keepEscape}>
                  <DropdownMenu.Item onSelect={() => void markDefault(group.root, group.isDefault)}>
                    {group.isDefault ? t('取消默认工作区', 'Clear default workspace') : t('设为默认工作区', 'Set as default workspace')}
                  </DropdownMenu.Item>
                  <DropdownMenu.Separator className="menu-separator" />
                  <DropdownMenu.Item onSelect={() => hideWorkspace(group.root)}>{t('从侧栏移除', 'Remove from sidebar')}</DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </h3>
          {isFolded && <div className="rail-empty">{t(`已收起 ${sessions.length} 个会话`, `${sessions.length} conversations collapsed`)}</div>}
          {!isFolded && sessions.length === 0 && <div className="rail-empty">
            {group.sessions.length === 0 ? t('此工作区还没有会话。', 'No conversations in this workspace yet.') : t('归档会话已隐藏。', 'Archived conversations are hidden.')}
          </div>}
          {!isFolded && sessions.map(sessionRow)}
        </section>;
      })}
      {visibleLoose.length > 0 && <section className="rail-loose">
        <h3 className="group-label"><Icon name="folder" size={14} /><span className="group-root">{t('其他会话', 'Other conversations')}</span><span className="group-count">{visibleLoose.length}</span></h3>
        {visibleLoose.map(sessionRow)}
      </section>}
      {archivedCount > 0 && <button type="button" className="rail-archive" aria-pressed={showArchived} onClick={() => setShowArchived(value => !value)}>
        {showArchived ? t('隐藏归档', 'Hide archived') : t(`显示归档会话 ${archivedCount}`, `Show archived conversations ${archivedCount}`)}
      </button>}
    </>}
  </div>;
}
