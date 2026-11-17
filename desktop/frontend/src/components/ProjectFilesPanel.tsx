import { useEffect, useRef, useState } from 'react';
import type { Client } from '../protocol';
import { listProjectDirectory, searchProjectFiles, type ProjectDirectoryPage, type ProjectFileEntry, type ProjectFileSearchPage } from '../project-files';
import { useText } from '../locale';
import { Icon } from './Icon';

function safeError(error: unknown): string {
  const value = error as { code?: unknown; message?: unknown };
  const code = typeof value?.code === 'string' ? value.code : typeof value?.message === 'string' ? value.message : 'project_files_unavailable';
  return /^[a-z][a-z0-9_]{0,79}$/u.test(code) ? code : 'project_files_unavailable';
}

function pageWithMore(current: ProjectDirectoryPage, next: ProjectDirectoryPage): ProjectDirectoryPage {
  if (current.path !== next.path || current.nextOffset !== next.offset) throw Object.assign(new Error('project_files_response_invalid'), { code: 'project_files_response_invalid' });
  return {
    ...next,
    entries: [...current.entries, ...next.entries],
    incomplete: current.incomplete || next.incomplete,
  };
}

function SearchResults({ client, sessionId, query, path, onOpenFile }: {
  client: Client;
  sessionId: string;
  query: string;
  path: string;
  onOpenFile: (path: string) => void;
}) {
  const t = useText();
  const [result, setResult] = useState<ProjectFileSearchPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [more, setMore] = useState(false);
  const generation = useRef(0);

  useEffect(() => {
    const request = ++generation.current;
    let active = true;
    setResult(null);
    setError(null);
    setLoading(true);
    const timer = setTimeout(() => {
      void searchProjectFiles(client, sessionId, query, path).then(value => {
        if (active && request === generation.current) setResult(value);
      }).catch(cause => {
        if (active && request === generation.current) setError(safeError(cause));
      }).finally(() => {
        if (active && request === generation.current) setLoading(false);
      });
    }, 180);
    return () => {
      active = false;
      clearTimeout(timer);
      if (generation.current === request) generation.current += 1;
    };
  }, [client, path, query, sessionId]);

  async function loadMore() {
    if (result?.nextOffset === null || result === null || more) return;
    const request = generation.current;
    setMore(true);
    try {
      const next = await searchProjectFiles(client, sessionId, query, path, result.nextOffset);
      if (request === generation.current) {
        setResult(current => current === null ? next : {
          ...next,
          matches: [...current.matches, ...next.matches],
          incomplete: current.incomplete || next.incomplete,
        });
      }
    } catch (cause) {
      if (request === generation.current) setError(safeError(cause));
    } finally {
      if (request === generation.current) setMore(false);
    }
  }

  return <div className="project-file-results" aria-live="polite">
    {loading && <p className="stub" role="status">{t('正在搜索…', 'Searching…')}</p>}
    {error !== null && <p className="stub" role="alert">{t('搜索文件失败', 'File search failed')} · {error}</p>}
    {result !== null && <>
      {result.matches.length === 0 && !result.incomplete && <p className="stub">{t('没有匹配文件', 'No matching files')}</p>}
      <ul className="project-file-list" aria-label={t('搜索结果', 'Search results')}>
        {result.matches.map(match => <li key={match.path}>
          <button type="button" className="project-file-item" title={match.path} onClick={() => onOpenFile(match.path)}>
            <span className="project-file-name">{match.path.split('/').at(-1)}</span>
            <small>{match.path}</small>
          </button>
        </li>)}
      </ul>
      {result.incomplete && <p className="project-file-incomplete" role="status">{t('搜索范围达到上限，缩小搜索词后重试。', 'Search stopped at its scan limit. Narrow the query and try again.')}</p>}
      {result.nextOffset !== null && <button type="button" className="project-file-more" disabled={more} onClick={() => void loadMore()}>
        {more ? t('正在读取…', 'Loading…') : t('显示更多结果', 'Show more results')}
      </button>}
    </>}
  </div>;
}

function DirectoryContents({ client, sessionId, path, depth, onOpenFile, onOpenDirectory }: {
  client: Client;
  sessionId: string;
  path: string;
  depth: number;
  onOpenFile: (path: string) => void;
  onOpenDirectory: (path: string) => void;
}) {
  const t = useText();
  const [page, setPage] = useState<ProjectDirectoryPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const generation = useRef(0);

  useEffect(() => {
    const request = ++generation.current;
    let active = true;
    setLoading(true);
    setError(null);
    setPage(null);
    void listProjectDirectory(client, sessionId, path).then(value => {
      if (active && request === generation.current) setPage(value);
    }).catch(cause => {
      if (active && request === generation.current) setError(safeError(cause));
    }).finally(() => {
      if (active && request === generation.current) setLoading(false);
    });
    return () => {
      active = false;
      if (generation.current === request) generation.current += 1;
    };
  }, [client, path, sessionId]);

  async function loadMore() {
    if (page?.nextOffset === null || page === null || more) return;
    const request = generation.current;
    setMore(true);
    try {
      const next = await listProjectDirectory(client, sessionId, path, page.nextOffset);
      if (request === generation.current) setPage(current => current === null ? next : pageWithMore(current, next));
    } catch (cause) {
      if (request === generation.current) setError(safeError(cause));
    } finally {
      if (request === generation.current) setMore(false);
    }
  }

  if (depth > 32) return <p className="project-file-incomplete" role="status">{t('目录嵌套太深，已停止展开。', 'Directory nesting is too deep to expand.')}</p>;
  if (loading) return <p className="stub" role="status">{t('正在读取目录…', 'Loading directory…')}</p>;
  if (error !== null) return <p className="stub" role="alert">{t('无法读取这个目录', 'Could not read this directory')} · {error}</p>;
  if (page === null) return null;

  return <>
    {page.entries.length === 0 && page.offset === 0 && <p className="stub">{t('这个目录为空。', 'This directory is empty.')}</p>}
    <ul className="project-file-list" role={depth === 0 ? 'tree' : 'group'} aria-label={depth === 0 ? t('项目文件', 'Project files') : undefined}>
      {page.entries.map(entry => <DirectoryEntry key={entry.path} entry={entry} client={client} sessionId={sessionId}
        depth={depth} onOpenFile={onOpenFile} onOpenDirectory={onOpenDirectory} />)}
    </ul>
    {page.incomplete && <p className="project-file-incomplete" role="status">{t('目录扫描达到上限，显示部分内容。', 'Directory scan reached its limit. Showing a partial list.')}</p>}
    {page.nextOffset !== null && <button type="button" className="project-file-more" disabled={more} onClick={() => void loadMore()}>
      {more ? t('正在读取…', 'Loading…') : t('显示更多文件', 'Show more files')}
    </button>}
  </>;
}

function DirectoryEntry({ entry, client, sessionId, depth, onOpenFile, onOpenDirectory }: {
  entry: ProjectFileEntry;
  client: Client;
  sessionId: string;
  depth: number;
  onOpenFile: (path: string) => void;
  onOpenDirectory: (path: string) => void;
}) {
  const t = useText();
  const [expanded, setExpanded] = useState(false);
  if (entry.kind === 'directory') {
    return <li className="project-file-tree-node" role="treeitem" aria-expanded={expanded}>
      <div className="project-file-row" style={{ paddingInlineStart: `${depth * 0.85}rem` }}>
        <button type="button" className="project-file-item project-file-folder" aria-expanded={expanded}
          onClick={() => setExpanded(value => !value)}>
          <Icon name={expanded ? 'folderOpen' : 'folder'} size={15} />
          <span className="project-file-name">{entry.name}</span>
        </button>
        <button type="button" className="icon-button project-file-open-folder"
          aria-label={`${t('在新标签中打开目录', 'Open directory in a tab')} ${entry.path}`}
          onClick={() => onOpenDirectory(entry.path)}><Icon name="folderOpen" size={14} /></button>
      </div>
      {expanded && <DirectoryContents client={client} sessionId={sessionId} path={entry.path} depth={depth + 1}
        onOpenFile={onOpenFile} onOpenDirectory={onOpenDirectory} />}
    </li>;
  }
  if (entry.kind === 'file') {
    return <li role="treeitem">
      <button type="button" className="project-file-item project-file-file" style={{ paddingInlineStart: `${depth * 0.85 + 1.1}rem` }}
        title={entry.path} onClick={() => onOpenFile(entry.path)}><span className="project-file-name">{entry.name}</span></button>
    </li>;
  }
  return <li role="treeitem" aria-disabled="true">
    <span className="project-file-item project-file-disabled" style={{ paddingInlineStart: `${depth * 0.85 + 1.1}rem` }}>
      <span className="project-file-name">{entry.name}</span>
      <small>{entry.kind === 'link' ? t('链接未展开', 'Link not followed') : t('不支持的文件类型', 'Unsupported item')}</small>
    </span>
  </li>;
}

export function ProjectFilesPanel({ client, sessionId, path, onOpenFile, onOpenDirectory }: {
  client: Client;
  sessionId: string;
  path: string;
  onOpenFile: (path: string) => void;
  onOpenDirectory: (path: string) => void;
}) {
  const t = useText();
  const [query, setQuery] = useState('');
  const trimmed = query.trim();
  return <section className="project-files-panel" aria-label={t('项目文件', 'Project files')}>
    <div className="project-files-toolbar">
      <label className="project-files-search">
        <span className="sr-only">{t('搜索文件名', 'Search file names')}</span>
        <Icon name="search" size={15} />
        <input type="search" aria-label={t('搜索文件名', 'Search file names')} value={query}
          placeholder={t('搜索文件名', 'Search file names')} onChange={event => setQuery(event.target.value)} />
        {query !== '' && <button type="button" aria-label={t('清除搜索', 'Clear search')} onClick={() => setQuery('')}>
          <Icon name="close" size={14} />
        </button>}
      </label>
      <small className="project-files-path" title={path}>{path === '.' ? t('工作区根目录', 'Workspace root') : path}</small>
    </div>
    <div className="project-files-content">
      {trimmed !== ''
        ? <SearchResults client={client} sessionId={sessionId} query={trimmed} path={path} onOpenFile={onOpenFile} />
        : <DirectoryContents client={client} sessionId={sessionId} path={path} depth={0}
          onOpenFile={onOpenFile} onOpenDirectory={onOpenDirectory} />}
    </div>
  </section>;
}
