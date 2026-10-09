import { useCallback, useState } from 'react';
import { save } from '@tauri-apps/plugin-dialog';
import { code, type Client } from '../protocol';
import { Icon } from './Icon';

type Exported = { written: string[]; skipped: { id: string; path?: string; code: string }[]; failed: { path: string; code: string }[] };

// 那一份支线没写出去有两种原因：记录读不回来，与那一个位置已经有一份同名文件、而这一份没人确认过要不要盖（审阅 F6）。
const skipLine = (item: Exported['skipped'][number]): string => item.code === 'export_target_exists'
  ? `${item.path ?? `支线 ${item.id}`} 已经在那儿，这一份没有盖它；要写下去先换一个位置或把那一份移开。`
  : `支线 ${item.id}：${item.code}`;

// 导出的一整件在宿主那一侧（方案 6A）：这一格只由人选定目的地，再把宿主交回来的那几条路径说出来。
// 那一个对话框是本机程序开的，界面不拼路径，也不假设自己写得进哪一个位置；交回路径不等于已经写成。
export function ExportPanel({ client, sessionId }: { client: Client; sessionId: string | null }) {
  const [phase, setPhase] = useState<'idle' | 'picking' | 'writing'>('idle');
  // 说明那一句带着自己的语气：对话框没开出来与没写进去才报警，没有选位置与写好了不报（方案 4.3 那一句）。
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);
  const [written, setWritten] = useState<string[]>([]);
  const [skipped, setSkipped] = useState<Exported['skipped']>([]);
  // 那一份没写成说的是那一份：主文件与每一条支线各报各的结果，不并成一句整体失败（审阅 F6）。
  const [failed, setFailed] = useState<Exported['failed']>([]);

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
      setFailed(done.failed);
      // 写好的份数说一次；没写成的那几份在下面的格子里逐条说出来，不再补一句「整体失败」。
      setNote({ text: `写好了 ${done.written.length} 份。`, bad: false });
    } catch (error) {
      setWritten([]);
      setSkipped([]);
      setFailed([]);
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
    {skipped.length > 0 && <p className="session-note" data-tone="bad">{skipped.map(skipLine).join('；')}。</p>}
    {failed.length > 0 && <p className="session-note" data-tone="bad">{failed.map((item) => `${item.path}：${item.code}`).join('；')}。这几份没写成。</p>}
    {written.length > 0 && <ul>{written.map((path) => <li key={path} className="mono">{path}</li>)}</ul>}
    <p className="sheet-note">
      写出的那几份文件就在下面。这一段会读完整记录、补上溢出在别处的那段正文；每条派生支线在同一目录里另写一份，文件名带着它自己的 id。
      对话框返回路径不等于文件已经写成——这一栏说的是宿主交回来的那几条路径。整件怎么走写在「使用手册」里。
    </p>
  </>;
}
