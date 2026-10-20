// 左侧栏通过 `sessions.list` 读取全部会话，并按项目根分组。
// Host 独占会话目录的读取；前端不猜测磁盘中还存在哪些记录。
// 搜索由 `sessions.search` 解析命中位置，前端负责打开会话并定位。
// 工作区名称和默认标记来自 Host 登记表；隐藏只影响侧栏，删除只移除登记项。
import { useCallback, useEffect, useRef, useState } from 'react';
import { Popover } from 'radix-ui';
import { Icon } from './Icon';
import { useText } from '../locale';
import { groupByWorkspace, loadWorkspacePages, type RailLayout, type WorkspaceRoster, visibleRoots } from '../rail';
import { code, type Client } from '../protocol';
import { keepEscape, Modal } from './ui';
import { SessionItem } from './rail/SessionItem';
import { WorkspaceGroup } from './rail/WorkspaceGroup';
import { SessionSearch } from './rail/SessionSearch';
import type { SearchHit, SessionSummary } from './rail/types';
export type { SearchHit, SessionSummary } from './rail/types';

const PROJECT_FAILURES: Record<string, readonly [string, string]> = {
  host_project_root_missing: ['目录不存在', 'Directory does not exist'],
  host_project_root_not_directory: ['路径不是目录', 'Path is not a directory'],
  host_project_root_unreadable: ['目录无法读取', 'Directory cannot be read'],
  host_project_root_mismatch: ['目录与项目根不一致', 'Directory does not match the project root'],
  host_project_root_unsupported: ['宿主不支持读取该项目', 'The Host cannot read this project'],
  workspace_registry_invalid: ['工作区登记无法读取', 'Workspace registry cannot be read'],
  workspace_registry_version: ['工作区登记版本不受支持', 'Workspace registry version is unsupported'],
  workspace_registry_locked: ['工作区登记正在更新', 'Workspace registry is being updated'],
  workspace_default_cannot_remove: ['请先取消默认工作区，再删除登记。', 'Clear the default workspace before removing its registration.'],
  workspace_not_registered: ['工作区已经不在登记表中。', 'This workspace is no longer registered.'],
  workspace_in_use: ['工作区中有正在运行的会话，结束后再试。', 'A session is running in this workspace. Try again when it finishes.'],
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

export function SessionRail({ client, current, onOpen, onOpenHit, revision, running, unread, projects, hidden, onHidden, onProjects, onCreate }: {
  client: Client;
  current: string | null;
  onOpen: (id: string, projectRoot?: string) => void;
  onOpenHit: (hit: SearchHit, projectRoot?: string) => void;
  // 会话创建或分支后重新读取列表，以显示新记录。
  revision: number;
  // 显示各会话的运行状态和未读完成状态。
  running: string[];
  unread: string[];
  // 提供当前窗口额外关注的项目目录；会话归属和工具边界由 Host 的项目环境决定。
  projects: string[];
  hidden: string[];
  onHidden: (roots: string[]) => void;
  onProjects: (roots: string[]) => void;
  // 在指定项目中创建会话；未指定时使用 Host 默认项目。
  onCreate: (root?: string) => void;
}) {
  const t = useText();
  const [layout, setLayout] = useState<RailLayout>({ groups: [], loose: [] });
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  const [otherFolded, setOtherFolded] = useState(false);
  const [failures, setFailures] = useState<RailFailure[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [searchExpanded, setSearchExpanded] = useState(false);
  const [only, setOnly] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searchNote, setSearchNote] = useState('');
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [projectDraft, setProjectDraft] = useState('');
  const [projectFailure, setProjectFailure] = useState('');
  const [addingProject, setAddingProject] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<{ root: string; isDefault: boolean } | null>(null);
  const [removeFailure, setRemoveFailure] = useState<{ message: string; code: string } | null>(null);
  const [removing, setRemoving] = useState(false);
  const [rootsById, setRootsById] = useState(new Map<string, string>());
  const [visible, setVisible] = useState<string[]>(['']);
  const loadGeneration = useRef(0);
  const searchGeneration = useRef(0);
  const searchInput = useRef<HTMLInputElement>(null);
  const isHidden = useCallback((root: string) => root !== '' && hidden.some(item => pathKey(item) === pathKey(root)), [hidden]);

  useEffect(() => {
    if (searchExpanded) searchInput.current?.focus({ preventScroll: true });
  }, [searchExpanded]);

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    searchGeneration.current += 1;
    setLoading(true);
    setFailures([]);
    setHits(null);
    let registryFailure: RailFailure | undefined;
    const read = await client.call('workspaces.list', {}, 60_000)
      .then((answer) => answer as WorkspaceRoster)
      .catch((error) => {
        registryFailure = { root: '', label: t('工作区登记', 'Workspace registry'), code: code(error) };
        return { default: null, workspaces: [] } as WorkspaceRoster;
      });
    if (generation !== loadGeneration.current) return;
    const asked = visibleRoots(read, projects.filter(root => !isHidden(root))).filter(root => !isHidden(root));
    setVisible(asked);
    const pages = await loadWorkspacePages(asked, client);
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

  // 默认工作区只通过此入口更新；保存后重新读取登记表，以显示 Host 实际保存的值。
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

  const removeWorkspace = async () => {
    if (removeTarget === null || removing || removeTarget.isDefault) return;
    setRemoving(true);
    setRemoveFailure(null);
    try {
      await client.call('workspace.remove', { directory: removeTarget.root }, 15_000);
      searchGeneration.current += 1;
      setHits(null);
      onHidden(hidden.filter(item => pathKey(item) !== pathKey(removeTarget.root)));
      onProjects(projects.filter(item => pathKey(item) !== pathKey(removeTarget.root)));
      setRemoveTarget(null);
      void load();
    } catch (error) {
      const errorCode = code(error);
      setRemoveFailure({ message: failureText(t, removeTarget.root, errorCode), code: errorCode });
    } finally {
      setRemoving(false);
    }
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

  // 搜索需要扫描会话记录，因此在用户停止输入后再发送请求。
  // 若会话列表仍在加载，先等待列表结果，避免遗漏项目目录中的记录。
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

  const sessionRow = (item: SessionSummary) => <SessionItem
    key={item.id}
    item={item}
    current={current}
    running={running.includes(item.id)}
    unread={unread.includes(item.id)}
    root={item.projectRoot !== '' ? item.projectRoot : rootsById.get(item.id)}
    onOpen={onOpen}
  />;

  const archivedCount = [...layout.groups.flatMap(group => group.sessions), ...layout.loose]
    .filter(item => item.archived === true).length;
  const visibleSessions = (items: SessionSummary[]) => showArchived ? items : items.filter(item => item.archived !== true);
  const visibleLoose = visibleSessions(layout.loose);
  const reportFailure = (failure: RailFailure) => failureText(t, failure.label, failure.code);
  const closeSearch = () => {
    searchGeneration.current += 1;
    setQuery('');
    setHits(null);
    setSearchExpanded(false);
  };

  return <div className="sessions">
    {!searchExpanded && <div className="rail-heading rail-controls">
      <strong>{t('工作区', 'Workspaces')}</strong>
      <button type="button" className="icon-button" aria-label={t('刷新会话列表', 'Refresh conversations')} title={t('刷新会话列表', 'Refresh conversations')} onClick={() => void load()}><Icon name="refresh" size={14} /></button>
      <button type="button" className="icon-button" aria-label={t('搜索会话', 'Search conversations')} title={t('搜索会话', 'Search conversations')} aria-expanded={false} onClick={() => { setPopoverOpen(false); setSearchExpanded(true); }}><Icon name="search" size={15} /></button>
      <Popover.Root open={popoverOpen} onOpenChange={setPopoverOpen}>
        <Popover.Trigger asChild><button type="button" className="icon-button" aria-label={t('添加工作区', 'Add workspace')} title={t('添加工作区', 'Add workspace')}><Icon name="plus" size={16} /></button></Popover.Trigger>
        <Popover.Portal>
          <Popover.Content className="workspace-pop" side="bottom" align="start" sideOffset={6} aria-label={t('添加工作区', 'Add workspace')} onEscapeKeyDown={keepEscape}>
            <label>
              <span>{t('现有目录', 'Existing directory')}</span>
              <input type="text" value={projectDraft} placeholder={t('输入目录路径', 'Enter a directory path')} aria-label={t('工作区目录路径', 'Workspace directory path')} title={projectDraft} disabled={addingProject}
                onChange={(event) => { setProjectDraft(event.target.value); setProjectFailure(''); }}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                  if (event.key === 'Enter') { event.preventDefault(); void addProject(); }
                }}
              />
            </label>
            {projectFailure !== '' && <div className="workspace-failure" role="alert">{projectFailure}</div>}
            <div>
              <Popover.Close asChild><button type="button" disabled={addingProject}>{t('取消', 'Cancel')}</button></Popover.Close>
              <button type="button" disabled={addingProject || projectDraft.trim() === ''} onClick={() => void addProject()}>{addingProject ? t('检查中…', 'Checking…') : t('确认', 'Add')}</button>
            </div>
            {hidden.length > 0 && <section>
              <h4>{t('已从侧栏隐藏', 'Hidden from sidebar')}</h4>
              {hidden.map(root => <p key={root}><span title={root}>{pathLeaf(root) || root}</span><button type="button" onClick={() => restoreWorkspace(root)}>{t('恢复', 'Restore')}</button></p>)}
            </section>}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>}
    <SessionSearch
      expanded={searchExpanded}
      query={query}
      only={only}
      current={current}
      inputRef={searchInput}
      hits={hits}
      note={searchNote}
      rootsById={rootsById}
      onQueryChange={(value) => { searchGeneration.current += 1; setQuery(value); }}
      onScopeToggle={() => { searchGeneration.current += 1; setOnly((value) => !value); }}
      onClose={closeSearch}
      onSearch={(value) => void search(value)}
      onOpenHit={onOpenHit}
    />

    {hits === null && <>
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
        return <WorkspaceGroup
          key={group.identity}
          group={group}
          sessions={sessions}
          folded={isFolded}
          onToggle={(identity) => setFolded((now) => ({ ...now, [identity]: !now[identity] }))}
          onCreate={onCreate}
          onSetDefault={(root, clearing) => void markDefault(root, clearing)}
          onHide={hideWorkspace}
          onRemove={(root, isDefault) => { setRemoveFailure(null); setRemoveTarget({ root, isDefault }); }}
        >{sessions.map(sessionRow)}</WorkspaceGroup>;
      })}
      {visibleLoose.length > 0 && <section className="rail-loose">
        <h3 className="group-label"><button type="button" className="group-fold" aria-expanded={!otherFolded} onClick={() => setOtherFolded(value => !value)}><Icon name={otherFolded ? 'unfold' : 'fold'} size={13} /><Icon name="folder" size={14} /><span className="group-root">{t('其他会话', 'Other conversations')}</span></button><span className="group-count">{visibleLoose.length}</span></h3>
        {!otherFolded && visibleLoose.map(sessionRow)}
      </section>}
      {archivedCount > 0 && <button type="button" className="rail-archive" aria-pressed={showArchived} onClick={() => setShowArchived(value => !value)}>
        {showArchived ? t('隐藏归档', 'Hide archived') : t(`显示归档会话 ${archivedCount}`, `Show archived conversations ${archivedCount}`)}
      </button>}
    </>}
    {removeTarget !== null && <Modal title={t('删除工作区登记', 'Remove workspace registration')} className="confirm" onClose={() => { if (!removing) setRemoveTarget(null); }}>
      <h2 className="confirm-lead">{t('从 Ligule 工作区列表中删除这一项？', 'Remove this entry from Ligule’s workspace list?')}</h2>
      <p className="confirm-note">{removeTarget.root}</p>
      <p className="confirm-note">{t('只删除登记项。项目目录、文件和会话历史会保留。', 'Only the registration is removed. The project directory, files, and session history stay in place.')}</p>
      {removeTarget.isDefault && <p className="session-note" data-tone="bad">{t('这是默认工作区。请先到设置中取消默认选择，再重试。', 'This is the default workspace. Clear its default selection in Settings, then try again.')}</p>}
      {removeFailure !== null && <div className="session-note" data-tone="bad" role="alert"><p>{removeFailure.message}</p><code>{removeFailure.code}</code></div>}
      <div className="confirm-actions">
        <button type="button" disabled={removing} onClick={() => setRemoveTarget(null)}>{t('取消', 'Cancel')}</button>
        <button type="button" className="primary-button" disabled={removing || removeTarget.isDefault} onClick={() => void removeWorkspace()}>{removing ? t('正在删除…', 'Removing…') : t('删除登记', 'Remove registration')}</button>
      </div>
    </Modal>}
  </div>;
}
