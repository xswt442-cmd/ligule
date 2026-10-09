import { useCallback, useState } from 'react';
import { save } from '@tauri-apps/plugin-dialog';
import { code, type Client } from '../protocol';
import { Icon } from './Icon';

type Exported = { written: string[]; skipped: { id: string; code: string }[] };

// 导出的一整件在宿主那一侧（方案 6A）：这一格只由人选定目的地，再把宿主交回来的那几条路径说出来。
// 那一个对话框是本机程序开的，界面不拼路径，也不假设自己写得进哪一个位置；交回路径不等于已经写成。
export function ExportPanel({ client, sessionId }: { client: Client; sessionId: string | null }) {
  const [phase, setPhase] = useState<'idle' | 'picking' | 'writing'>('idle');
  // 说明那一句带着自己的语气：对话框没开出来与没写进去才报警，没有选位置与写好了不报（方案 4.3 那一句）。
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);
  const [written, setWritten] = useState<string[]>([]);
  const [skipped, setSkipped] = useState<Exported['skipped']>([]);

  const exportNow = useCallback(async () => {
    if (sessionId === null) return;
    setNote(null);
    setPhase('picking');
    let destination: string | null;
    try {
      destination = await save({ defaultPath: `ligule-${sessionId.slice(0, 8)}.md`, filters: [{ name: 'Markdown', extensions: ['md'] }] });
    } catch (error) {
      setPhase('idle');
      setNote({ text: `那一个对话框没开出来：${code(error)}`, bad: true });
      return;
    }
    if (destination === null) {
      setPhase('idle');
      setNote({ text: '没有选位置，什么都没写。', bad: false });
      return;
    }
    setPhase('writing');
    try {
      const done = await client.call('session.export', { sessionId, path: destination }, 60_000) as Exported;
      setWritten(done.written);
      setSkipped(done.skipped);
      setNote({ text: `写好了 ${done.written.length} 份。`, bad: false });
    } catch (error) {
      setWritten([]);
      setSkipped([]);
      setNote({ text: `没写进去：${code(error)}`, bad: true });
    } finally {
      setPhase('idle');
    }
  }, [client, sessionId]);

  return <>
    <button type="button" className="rail-refresh" disabled={sessionId === null || phase !== 'idle'} onClick={() => void exportNow()}>
      <Icon name="download" size={13} /> {phase === 'picking' ? '等那一个对话框' : phase === 'writing' ? '正在写' : '选一个位置并写出'}
    </button>
    {note !== null && <p className="session-note" data-tone={note.bad ? 'bad' : undefined}>{note.text}</p>}
    {skipped.length > 0 && <p className="session-note" data-tone="bad">{skipped.map((item) => `支线 ${item.id}：${item.code}`).join('；')}。那几份没写出去。</p>}
    {written.length > 0 && <ul>{written.map((path) => <li key={path} className="mono">{path}</li>)}</ul>}
    <p className="sheet-note">
      那份 markdown 由宿主排好并写下去：整份记录、溢出在别处的那一段完整正文，以及每一条派生支线各另写一份，文件名里带着那条支线自己的 id。
      位置与文件名由你在本机那一个对话框里选定，覆盖已有的那一份也由它问。
      那一个对话框只在真壳窗口里有：从浏览器打开这一页时它开不出来，界面把失败那一句原样说出来，不代你挑一个位置。
    </p>
  </>;
}
