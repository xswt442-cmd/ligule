import { useEffect, useRef, useState } from 'react';
import type { Client } from '../protocol';
import { readProjectFile, type ProjectFileSnapshot } from '../project-files';
import { Markdown } from '../markdown';
import { useText } from '../locale';

function safeError(error: unknown): string {
  const value = error as { code?: unknown; message?: unknown };
  const code = typeof value?.code === 'string' ? value.code : typeof value?.message === 'string' ? value.message : 'project_file_unavailable';
  return /^[a-z][a-z0-9_]{0,79}$/u.test(code) ? code : 'project_file_unavailable';
}

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function ProjectFileView({ client, sessionId, path, expectedVersion }: {
  client: Client;
  sessionId: string;
  path: string;
  expectedVersion?: string;
}) {
  const t = useText();
  const [snapshot, setSnapshot] = useState<ProjectFileSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const [imageUrl, setImageUrl] = useState<string | null>(null);

  useEffect(() => {
    const request = ++generation.current;
    const controller = new AbortController();
    let active = true;
    setSnapshot(null);
    setError(null);
    void readProjectFile(client, sessionId, path, controller.signal).then(value => {
      if (active && request === generation.current) setSnapshot(value);
    }).catch(cause => {
      if (active && request === generation.current) setError(safeError(cause));
    });
    return () => {
      active = false;
      controller.abort();
      generation.current += 1;
    };
  }, [client, path, sessionId]);

  useEffect(() => {
    const preview = snapshot?.encoding === 'image' ? snapshot.imagePreview : undefined;
    if (preview === undefined) {
      setImageUrl(null);
      return;
    }
    const bytes = Uint8Array.from(atob(preview.base64), character => character.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: preview.mimeType }));
    setImageUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [snapshot]);

  const stale = snapshot !== null && expectedVersion !== undefined && snapshot.version !== expectedVersion;
  return <section className="project-file-view" aria-label={t('文件预览', 'File preview')}>
    <header className="project-file-view-head">
      <div>
        <strong>{path.split('/').at(-1)}</strong>
        <small>{path}{snapshot === null ? '' : ` · ${sizeLabel(snapshot.size)}`}</small>
      </div>
      {snapshot?.version !== null && snapshot?.version !== undefined && <code title={snapshot.version}>{snapshot.version.slice(0, 12)}…</code>}
    </header>
    {error !== null && <p className="stub" role="alert">{t('无法读取文件', 'Could not read file')} · {error}</p>}
    {snapshot === null && error === null && <p className="stub" role="status">{t('正在读取文件…', 'Reading file…')}</p>}
    {stale && <p className="project-file-stale" role="status">{t('此引用记录的版本已变化；下面显示当前版本。', 'The referenced version has changed. Showing the current version below.')}</p>}
    {snapshot?.encoding === 'too_large' && <p className="stub" role="status">{t('文件超过工作台预览上限。', 'The file exceeds the workbench preview limit.')}</p>}
    {snapshot?.encoding === 'binary' && <p className="stub" role="status">{t('这是二进制文件，工作台不显示其内容。', 'This is a binary file and is not shown in the workbench.')}</p>}
    {snapshot?.encoding === 'invalid_utf8' && <p className="stub" role="status">{t('文件不是有效的 UTF-8 文本。', 'The file is not valid UTF-8 text.')}</p>}
    {snapshot?.encoding === 'image' && imageUrl !== null && <div className="project-file-image">
      <img src={imageUrl} alt={path} />
    </div>}
    {snapshot?.encoding === 'utf8' && snapshot.mimeType === 'text/markdown'
      ? <div className="project-file-markdown" data-file-preview><Markdown text={snapshot.text ?? ''} /></div>
      : snapshot?.encoding === 'utf8' && <pre className="project-file-source" data-file-preview>{snapshot.text ?? ''}</pre>}
  </section>;
}
