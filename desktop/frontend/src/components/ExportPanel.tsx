import { useCallback, useState } from 'react';
import { save } from '@tauri-apps/plugin-dialog';
import { code, type Client } from '../protocol';
import { Icon } from './Icon';
import { useText } from '../locale';

type Exported = { written: string[]; skipped: { id: string; path?: string; code: string }[]; failed: { path: string; code: string }[] };
type Notice = { text: string; bad: boolean; code?: string };

export function ExportPanel({ client, sessionId }: { client: Client; sessionId: string | null }) {
  const t = useText();
  const [phase, setPhase] = useState<'idle' | 'picking' | 'writing'>('idle');
  const [note, setNote] = useState<Notice | null>(null);
  const [written, setWritten] = useState<string[]>([]);
  const [skipped, setSkipped] = useState<Exported['skipped']>([]);
  const [failed, setFailed] = useState<Exported['failed']>([]);

  const exportNow = useCallback(async () => {
    if (sessionId === null) return;
    setNote(null);
    setWritten([]);
    setSkipped([]);
    setFailed([]);
    setPhase('picking');
    let destination: string | null;
    try {
      destination = await save({ defaultPath: `ligule-${sessionId.slice(0, 8)}.md`, filters: [{ name: 'Markdown', extensions: ['md'] }] });
    } catch (error) {
      setPhase('idle');
      setNote({ text: t('保存对话框无法打开。', 'Could not open the save dialog.'), code: code(error), bad: true });
      return;
    }
    if (destination === null) {
      setPhase('idle');
      setNote({ text: t('已取消导出。', 'Export cancelled.'), bad: false });
      return;
    }
    setPhase('writing');
    try {
      const done = await client.call('session.export', { sessionId, path: destination }, 60_000) as Exported;
      setWritten(done.written);
      setSkipped(done.skipped);
      setFailed(done.failed);
      setNote({ text: t('导出处理已完成。', 'Export request finished.'), bad: false });
    } catch (error) {
      setNote({ text: t('导出失败。', 'Export failed.'), code: code(error), bad: true });
    } finally {
      setPhase('idle');
    }
  }, [client, sessionId, t]);

  return <>
    <button type="button" className="rail-refresh" disabled={sessionId === null || phase !== 'idle'} onClick={() => void exportNow()}>
      <Icon name="download" size={13} /> {phase === 'picking'
        ? t('等待选择位置…', 'Choose a destination…')
        : phase === 'writing' ? t('正在导出…', 'Exporting…') : t('导出会话', 'Export session')}
    </button>
    {note !== null && <div className="session-note" data-tone={note.bad ? 'bad' : undefined}>
      <span>{note.text}</span>
      {note.code !== undefined && <details><summary>{t('错误代码', 'Error code')}</summary><code>{note.code}</code></details>}
    </div>}
    {skipped.length > 0 && <ul className="export-results">
      {skipped.map((item) => <li key={`${item.id}:${item.code}`}>
        <span>{item.code === 'export_target_exists'
          ? t('目标文件已存在，未覆盖。', 'Target file already exists; it was not overwritten.')
          : t('派生会话未能导出。', 'Could not export this branch.')}</span>
        <code>{item.path ?? item.id}</code>
        <details><summary>{t('详情', 'Details')}</summary><code>{item.code}</code></details>
      </li>)}
    </ul>}
    {failed.length > 0 && <ul className="export-results">
      {failed.map((item) => <li key={`${item.path}:${item.code}`}>
        <span>{t('文件未能写入。', 'Could not write file.')}</span>
        <code>{item.path}</code>
        <details><summary>{t('错误代码', 'Error code')}</summary><code>{item.code}</code></details>
      </li>)}
    </ul>}
    {written.length > 0 && <ul>{written.map((path) => <li key={path} className="mono">{path}</li>)}</ul>}
    <p className="sheet-note">{t('Host 导出完整会话记录和溢出内容，并逐条报告写入结果。', 'The Host exports the full session record and spilled content, and reports each file result.')}</p>
  </>;
}
