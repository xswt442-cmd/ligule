import { useCallback, useEffect, useState } from 'react';
import { code, type Client } from '../protocol';
import { useText } from '../locale';
import { projectRecord, shownIn, type Record_, type Row } from '../rows';
import type { Verbosity } from './types';
import { RowView } from './RowView';

type Branch = { seq: number; id: string; task: string };

function branchOf(record: Record_): Branch | null {
  if (record.kind !== 'tool' || record.tool !== 'subagent') return null;
  const content = record.result?.content as { sessionId?: unknown } | undefined;
  if (typeof content?.sessionId !== 'string' || content.sessionId === '') return null;
  return { seq: record.seq ?? 0, id: content.sessionId, task: String(record.args?.task ?? '') };
}

export function BranchPanel({ client, sessionId, verbosity }: { client: Client; sessionId: string | null; verbosity: Verbosity }) {
  const t = useText();
  const [branches, setBranches] = useState<Branch[]>([]);
  const [shown, setShown] = useState<{ id: string; rows: Row[] } | null>(null);
  const [note, setNote] = useState<{ kind: 'parent' | 'branch'; code: string } | null>(null);

  useEffect(() => {
    setBranches([]);
    setShown(null);
    setNote(null);
    if (sessionId === null) return;
    void (async () => {
      try {
        const { events } = await client.call('session.read', { sessionId, fullResults: true }) as { events: Record_[] };
        setBranches(events.map(branchOf).filter((item): item is Branch => item !== null));
      } catch (error) {
        setNote({ kind: 'parent', code: code(error) });
      }
    })();
  }, [client, sessionId]);

  const open = useCallback(async (id: string) => {
    setNote(null);
    try {
      const { events } = await client.call('session.read', { sessionId: id, fullResults: true }) as { events: Record_[] };
      setShown({ id, rows: events.flatMap((record) => projectRecord(record)) });
    } catch (error) {
      setNote({ kind: 'branch', code: code(error) });
    }
  }, [client]);

  if (branches.length === 0) {
    return <p className="stub">{note === null ? t('当前会话没有子任务。', 'This conversation has no subtasks.') : t(
      `${note.kind === 'parent' ? '无法读取会话记录' : '无法读取子任务'}：${note.code}`,
      `Could not load ${note.kind === 'parent' ? 'conversation history' : 'subtask'}: ${note.code}`,
    )}</p>;
  }
  return <>
    <h3>{t(`${branches.length} 个子任务`, `${branches.length} subtasks`)}</h3>
    <ul>{branches.map((branch) => <li key={branch.id}>
      <button type="button" onClick={() => void open(branch.id)}>{t(`记录 ${branch.seq}`, `Event ${branch.seq}`)}</button>
      <span className="muted"> {branch.task === '' ? t('（无任务说明）', '(no task description)') : branch.task.slice(0, 60)}</span>
    </li>)}</ul>
    {shown !== null && <>
      <h3>{t(`子任务 ${shown.id}`, `Subtask ${shown.id}`)}</h3>
      <div className="conversation">
        {shown.rows.filter((row) => shownIn(verbosity, row)).map((row) => <RowView key={row.id} row={row} verbosity={verbosity} />)}
      </div>
    </>}
    {note !== null && <p className="stub">{t(
      `${note.kind === 'parent' ? '无法读取会话记录' : '无法读取子任务'}：${note.code}`,
      `Could not load ${note.kind === 'parent' ? 'conversation history' : 'subtask'}: ${note.code}`,
    )}</p>}
  </>;
}
