import { useCallback, useEffect, useRef, useState } from 'react';
import type { Client } from '../protocol';
import { readProjectFile, saveProjectFile, type ProjectFileSnapshot } from '../project-files';
import { Markdown } from '../markdown';
import { useText } from '../locale';
import { ProjectFileEditor } from './ProjectFileEditor';
import type { WorkbenchFileDraft } from '../workbench';

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

function newlineInfo(text: string): { separator: string; mixed: boolean } {
  const normalized = text.replaceAll('\r\n', '');
  const kinds = [
    ...(text.includes('\r\n') ? ['\r\n'] : []),
    ...(normalized.includes('\n') ? ['\n'] : []),
    ...(normalized.includes('\r') ? ['\r'] : []),
  ];
  return { separator: kinds[0] ?? '\n', mixed: kinds.length > 1 };
}

export function ProjectFileView({ client, sessionId, path, expectedVersion, fileDraft, readOnly = false,
  onDraftChange, onEdit }: {
  client: Client;
  sessionId: string;
  path: string;
  expectedVersion?: string;
  fileDraft?: WorkbenchFileDraft;
  readOnly?: boolean;
  onDraftChange: (draft: WorkbenchFileDraft | undefined) => boolean;
  onEdit: (reason: string) => void;
}) {
  const t = useText();
  const [snapshot, setSnapshot] = useState<ProjectFileSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<string | null>(null);
  const [editing, setEditing] = useState(fileDraft !== undefined);
  const [localText, setLocalText] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const generation = useRef(0);
  const editRevision = useRef(0);
  const currentText = useRef('');
  const baseVersion = useRef<string | null>(fileDraft?.version ?? null);
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

  const sourceText = snapshot?.encoding === 'utf8' ? snapshot.text ?? '' : '';
  const text = localText ?? fileDraft?.text ?? sourceText;
  const version = snapshot?.version ?? null;
  const draftVersion = localText === null ? fileDraft?.version ?? baseVersion.current ?? version : baseVersion.current ?? version;
  const draftConflict = (fileDraft !== undefined || localText !== null) && version !== null && draftVersion !== version;
  const dirty = snapshot?.encoding === 'utf8' && (text !== sourceText || draftConflict);
  const newlines = snapshot?.encoding === 'utf8' ? newlineInfo(sourceText) : { separator: '\n', mixed: false };
  currentText.current = text;
  baseVersion.current = draftVersion;

  useEffect(() => {
    const reason = saving
      ? t('正在保存工作区文件', 'Saving a workspace file')
      : dirty ? t('尚未保存的工作区文件修改', 'Unsaved workspace file changes') : '';
    onEdit(reason);
    return () => onEdit('');
  }, [dirty, onEdit, saving, t]);

  const changeText = useCallback((next: string) => {
    editRevision.current += 1;
    currentText.current = next;
    setLocalText(next);
    if (snapshot?.encoding !== 'utf8' || version === null) return;
    const persisted = next === sourceText ? onDraftChange(undefined)
      : onDraftChange({ version: baseVersion.current ?? version, text: next });
    setSaveState(persisted ? null : 'workbench_file_draft_limit');
  }, [onDraftChange, snapshot?.encoding, sourceText, version]);

  const discardDraft = useCallback(() => {
    const persisted = onDraftChange(undefined);
    setLocalText(sourceText);
    currentText.current = sourceText;
    baseVersion.current = version;
    editRevision.current += 1;
    setSaveState(persisted ? null : 'workbench_file_draft_clear_failed');
  }, [onDraftChange, sourceText, version]);

  const save = useCallback(async () => {
    if (snapshot?.encoding !== 'utf8' || version === null || draftConflict || readOnly || saving) return;
    const submitted = currentText.current;
    const expected = baseVersion.current ?? version;
    const submittedRevision = editRevision.current;
    setSaving(true);
    setSaveState(null);
    try {
      const result = await saveProjectFile(client, sessionId, path, expected, submitted);
      if (!result.saved || result.version === null) {
        setSaveState(result.errorCode ?? 'project_file_save_failed');
        return;
      }
      const latest = currentText.current;
      const newerEdits = submittedRevision !== editRevision.current || latest !== submitted;
      const bytes = new TextEncoder().encode(submitted).byteLength;
      setSnapshot(current => current?.encoding === 'utf8' ? {
        ...current, text: submitted, size: bytes, version: result.version,
        offsetBytes: 0, nextOffsetBytes: null,
      } : current);
      setLocalText(latest);
      baseVersion.current = result.version;
      const draftPersisted = newerEdits ? onDraftChange({ version: result.version, text: latest }) : onDraftChange(undefined);
      setSaveState(!result.recorded ? 'workspace_file_change_record_failed'
        : newerEdits ? draftPersisted ? 'saved_newer_edits' : 'saved_newer_draft_not_persisted'
          : draftPersisted ? 'saved' : 'saved_draft_clear_failed');
    } catch (cause) {
      const failure = safeError(cause);
      setSaveState(failure);
      if (failure === 'project_file_conflict' || failure === 'project_file_target_changed') {
        try {
          const latest = await readProjectFile(client, sessionId, path);
          setSnapshot(latest);
          setError(null);
        } catch (refreshError) {
          setSnapshot(null);
          setError(safeError(refreshError));
        }
      }
    } finally {
      setSaving(false);
    }
  }, [client, draftConflict, onDraftChange, path, readOnly, saving, sessionId, snapshot?.encoding, version]);

  const stale = snapshot !== null && expectedVersion !== undefined && snapshot.version !== expectedVersion;
  return <section className="project-file-view" aria-label={t('文件预览', 'File preview')}
    data-side-chat-kind="file" data-side-chat-path={path} data-side-chat-version={snapshot?.version ?? undefined}>
    <header className="project-file-view-head">
      <div>
        <strong>{path.split('/').at(-1)}</strong>
        <small>{path}{snapshot === null ? '' : ` · ${sizeLabel(snapshot.size)}`}</small>
      </div>
      <div className="project-file-view-actions">
        {snapshot?.version !== null && snapshot?.version !== undefined && <code title={snapshot.version}>{snapshot.version.slice(0, 12)}…</code>}
        {snapshot?.encoding === 'utf8' && !editing && !newlines.mixed && <button type="button" disabled={readOnly}
          onClick={() => { setLocalText(fileDraft?.text ?? snapshot.text ?? ''); setEditing(true); }}>
          {t('编辑文件', 'Edit file')}
        </button>}
        {editing && snapshot?.encoding === 'utf8' && <>
          {draftConflict && <button type="button" onClick={discardDraft}>{t('放弃旧草稿并重新载入', 'Discard stale draft')}</button>}
          <button type="button" disabled={saving || readOnly || !dirty || draftConflict}
            onClick={() => void save()}>{saving ? t('正在保存…', 'Saving…') : t('保存文件', 'Save file')}</button>
          {!dirty && <button type="button" onClick={() => { setEditing(false); setLocalText(null); }}>
            {t('结束编辑', 'Stop editing')}
          </button>}
        </>}
      </div>
    </header>
    {error !== null && <p className="stub" role="alert">{t('无法读取文件', 'Could not read file')} · {error}</p>}
    {snapshot === null && error === null && <p className="stub" role="status">{t('正在读取文件…', 'Reading file…')}</p>}
    {stale && <p className="project-file-stale" role="status">{t('此引用记录的版本已变化；下面显示当前版本。', 'The referenced version has changed. Showing the current version below.')}</p>}
    {snapshot?.encoding === 'too_large' && <p className="stub" role="status">{t('文件超过工作台预览上限。', 'The file exceeds the workbench preview limit.')}</p>}
    {snapshot?.encoding === 'binary' && <p className="stub" role="status">{t('这是二进制文件，工作台不显示其内容。', 'This is a binary file and is not shown in the workbench.')}</p>}
    {snapshot?.encoding === 'invalid_utf8' && <p className="stub" role="status">{t('文件不是有效的 UTF-8 文本。', 'This file is not valid UTF-8 text.')}</p>}
    {snapshot?.encoding === 'utf8' && newlines.mixed && <p className="project-file-stale" role="status">
      {t('文件混用了不同换行符；为避免静默改写，只能查看，不能编辑。', 'This file mixes line endings. It is view only to avoid silently rewriting them.')}
    </p>}
    {draftConflict && <p className="project-file-stale" role="alert">
      {t('文件版本已变化，草稿仍保留但不能直接覆盖。复制需要的内容，或放弃旧草稿后重新载入。',
        'The file changed after this draft was created. The draft is preserved, but cannot overwrite the newer file. Copy what you need or discard the stale draft.')}
    </p>}
    {snapshot?.encoding === 'utf8' && editing && !newlines.mixed && <ProjectFileEditor
      key={`${path}:${version}:${draftVersion}`}
      path={path}
      initialText={text}
      lineSeparator={newlines.separator}
      readOnly={readOnly || draftConflict}
      onChange={changeText}
    />}
    {saveState === 'saved' && <p className="project-file-save-status" role="status">{t('已保存到磁盘', 'Saved to disk')}</p>}
    {saveState === 'saved_newer_edits' && <p className="project-file-save-status" role="status">
      {t('已保存；保存期间的新修改仍未保存', 'Saved; newer edits remain unsaved')}
    </p>}
    {saveState === 'workspace_file_change_record_failed' && <p className="project-file-stale" role="alert">
      {t('文件已写入，但会话中的变更记录未能保存。', 'The file was written, but its Session change fact could not be recorded.')}
    </p>}
    {saveState === 'workbench_file_draft_limit' && <p className="project-file-stale" role="alert">
      {t('工作台草稿容量已满；当前修改仍留在此窗口，但尚未写入偏好。',
        'Workbench draft capacity is full. The current edits remain in this window but are not persisted yet.')}
    </p>}
    {saveState === 'workbench_file_draft_clear_failed' && <p className="project-file-stale" role="alert">
      {t('草稿没有从偏好中清除，请先确认偏好写入状态。', 'The draft could not be cleared from preferences. Check the preference save status.')}
    </p>}
    {saveState === 'saved_newer_draft_not_persisted' && <p className="project-file-stale" role="alert">
      {t('已保存本次内容，但后续修改尚未持久化；请再次保存后再离开。',
        'This revision was saved, but later edits were not persisted. Save again before leaving.')}
    </p>}
    {saveState === 'saved_draft_clear_failed' && <p className="project-file-stale" role="alert">
      {t('文件已保存，但旧草稿未能从偏好中清除。', 'The file was saved, but the old draft could not be cleared from preferences.')}
    </p>}
    {saveState !== null && !['saved', 'saved_newer_edits', 'workspace_file_change_record_failed',
      'workbench_file_draft_limit', 'workbench_file_draft_clear_failed', 'saved_newer_draft_not_persisted',
      'saved_draft_clear_failed'].includes(saveState)
      && <p className="project-file-stale" role="alert">{t('保存失败，草稿已保留。', 'Save failed; the draft was preserved.')} · {saveState}</p>}
    {fileDraft !== undefined && (snapshot?.encoding !== 'utf8' || newlines.mixed) && <section className="project-file-draft-recovery">
      <p className="project-file-stale" role="status">
        {t('当前文件无法编辑，未保存草稿仍保存在会话偏好中。', 'The current file cannot be edited. The unsaved draft remains in workbench preferences.')}
      </p>
      <pre className="project-file-source" data-file-draft-recovery>{fileDraft.text}</pre>
      <button type="button" onClick={discardDraft}>{t('放弃草稿', 'Discard draft')}</button>
    </section>}
    {snapshot?.encoding === 'image' && imageUrl !== null && <div className="project-file-image">
      <img src={imageUrl} alt={path} />
    </div>}
    {snapshot?.encoding === 'utf8' && !editing && snapshot.mimeType === 'text/markdown'
      ? <div className="project-file-markdown" data-file-preview><Markdown text={snapshot.text ?? ''} /></div>
      : snapshot?.encoding === 'utf8' && !editing && <pre className="project-file-source" data-file-preview>{snapshot.text ?? ''}</pre>}
  </section>;
}
