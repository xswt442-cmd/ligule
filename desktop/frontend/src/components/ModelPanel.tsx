import { useCallback, useEffect, useState } from 'react';
import { code, type Client } from '../protocol';
import { Icon } from './Icon';

// 「模型与端点」那一格读的是 `config.get`（实现顺序第 67 步），改的是 `config.set`（第 90、91 步）：
// 宿主只交白名单里那几格，界面要不到别的一格，也读不到密钥本身——凭据只从环境变量读（D13）。
// 这里列的四个字段与宿主那份白名单是同一批：说错名字宿主报 `config_field_unknown`，界面不猜。
type Shown = {
  model?: { api?: string; baseURL?: string; model?: string; apiKeyEnv?: string };
  layers?: { layer: string; version: string; exists: boolean }[];
  sources?: Record<string, string>;
};

// 来源那一格说的是装载那一次读到的四层（D8 的次序）：`flag` 与 `project` 都是只读的，改文件盖不过它们。
const SOURCE_NAMES: Record<string, string> = {
  flag: '命令行 `--config`（只读）',
  local: '当前项目的本机覆盖',
  project: '项目共享那一份（只读）',
  user: '使用者默认',
  none: '四层里都没写',
};

type Draft = { field: string; label: string; value: string; choices?: string[] };

const FIELDS: Draft[] = [
  { field: 'model.api', label: '接口类型', value: '', choices: ['messages', 'chat-completions'] },
  { field: 'model.baseURL', label: '服务地址', value: '' },
  { field: 'model.model', label: '模型名', value: '' },
  { field: 'model.apiKeyEnv', label: '密钥的环境变量名', value: '' },
];

// 可写的两层，以及那两层各自落在哪一个约定位置（方案 7.2 那张表）。
// 项目共享的那一份 `config.toml` 不在这里：它跟着仓库走，改它等于替别人改。
const LAYERS: [string, string][] = [
  ['user', '使用者默认那一层（~/.ligule/config.toml）'],
  ['projectLocal', '当前项目的本机覆盖（.ligule/config.local.toml）'],
];

const nameOf = (layer: string) => LAYERS.find(([id]) => id === layer)?.[1] ?? layer;

export function ModelPanel({ client, sessionId }: { client: Client; sessionId: string | null }) {
  const [shown, setShown] = useState<Shown | null>(null);
  const [note, setNote] = useState('');
  // 这一份会话现在打的是哪一份模型、等在它边界上的又是哪一份（方案 7.1 三种读数里的两格）。
  const [inUse, setInUse] = useState<{ model?: string | null; pendingModel?: string | null }>({});
  const [draft, setDraft] = useState<Draft | null>(null);
  const [layer, setLayer] = useState('user');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (keep = false) => {
    if (!keep) setNote('');
    try {
      setShown(await client.call('config.get', {}, 15_000) as Shown);
    } catch (error) {
      setNote(`配置读不回来：${code(error)}`);
    }
    if (sessionId === null) {
      setInUse({});
      return;
    }
    try {
      setInUse(await client.call('status.get', { sessionId }, 15_000) as { model?: string | null; pendingModel?: string | null });
    } catch {
      // 状态读不回来只说明不了「现在生效的是哪一份」，不该带走这一栏别的内容：配置那几格是另一条回答。
      setInUse({});
    }
  }, [client, sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const model = shown?.model ?? {};
  const valueOf = (field: string) => (model as Record<string, string | undefined>)[field.split('.')[1]];

  const save = async () => {
    if (draft === null) return;
    // 那一格版本是读回来时带在身上的，原样交回去：它不是给人看的数，是给宿主比对「这之后有没有人改过」。
    const version = shown?.layers?.find((item) => item.layer === layer)?.version ?? '';
    setSaving(true);
    try {
      const answer = await client.call('config.set', { field: draft.field, value: draft.value, layer, version }, 30_000) as
        { applies?: { sessionId: string; when: string }[]; failure?: { code: string }; created?: boolean; shadowed?: boolean };
      const now = (answer.applies ?? []).filter((item) => item.when === 'now').length;
      const waiting = (answer.applies ?? []).filter((item) => item.when === 'round').length;
      // 保存结果一句、什么时候生效一句，两句从不合在一起（方案 7.2：文件已保存与该会话未生效分别显示）。
      const saved = `文件已写进${nameOf(layer)}${answer.created === true ? '（这一层原先没有那一份文件）' : ''}。`;
      // 被只读那一层盖着、或提供方重算失败时，说的是「谁还不会用上新值」这一件事实，不再补「没有会话要换」。
      let effect: string;
      if (answer.shadowed === true) effect = '这一条由命令行那一层写着，改文件盖不过它：这一具宿主不会用上新值。';
      else if (answer.failure !== undefined) effect = `提供方重算配置没成（${answer.failure.code}）：会话还没用上它。`;
      else if (waiting > 0 && now > 0) effect = `${now} 份空着的会话现在就换，${waiting} 份跑着的会话等自己那一轮收尾之后才换。`;
      else if (waiting > 0) effect = `${waiting} 份会话等自己那一轮收尾之后才换。`;
      else if (now > 0) effect = `${now} 份空着的会话现在就换上它。`;
      else effect = '这一具宿主里没有会话属于这个项目，所以现在没有会话会换上它。';
      setNote(`${saved}${effect}`);
      setDraft(null);
      // 重读时把这一句留着：`load` 一开头会收掉上一回的说明，先写就等着被它擦掉（浏览器里量到过）。
      await load(true);
    } catch (error) {
      const kind = code(error);
      setNote(kind === 'config_version_stale'
        ? '那一层文件在这之后被别的过程或你在编辑器里改过。这一次没有写进去，他的那份留着。按「再问一次」读回最新版本再试。'
        : `没写进去：${kind}`);
    } finally {
      setSaving(false);
    }
  };

  return <>
    <button type="button" className="rail-refresh" onClick={() => void load()}><Icon name="refresh" size={13} /> 再问一次</button>
    {note !== '' && <p className="session-note">{note}</p>}
    {FIELDS.map((item) => {
      const current = valueOf(item.field);
      const editing = draft !== null && draft.field === item.field;
      return <div key={item.field} className="sheet-row">
        <span className="sheet-label">{item.label}</span>
        {/* 改的那一段用的还是读数那一格的形状：值、写进哪一层与两个动作排在同一条上。 */}
        <span className="sheet-value">{editing ? <>
          {item.choices === undefined
            ? <input value={draft.value} onChange={(event) => setDraft({ ...draft, value: event.target.value })} />
            : <select value={draft.value} onChange={(event) => setDraft({ ...draft, value: event.target.value })}>
              {item.choices.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>}
          <select value={layer} onChange={(event) => setLayer(event.target.value)}>
            {LAYERS.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
          <button type="button" disabled={saving} onClick={() => void save()}>保存</button>
          <button type="button" onClick={() => setDraft(null)}>不收这笔</button>
        </> : <span className="mono">{current ?? '读不出来或没写这一格'}</span>}</span>
        <span className="row-note">来源 {SOURCE_NAMES[shown?.sources?.[item.field] ?? 'none']}
          {shown?.sources?.[item.field] === 'flag' ? '，改文件盖不过它' : ''}</span>
        {!editing && <button type="button" onClick={() => { setDraft(item); setNote(''); }}>改</button>}
      </div>;
    })}
    {draft !== null && <p className="session-note">
      要把「{draft.label}」从「{valueOf(draft.field) ?? '（没写）'}」改成「{draft.value}」，写进{nameOf(layer)}。
    </p>}
    <p className="sheet-note">
      这几格读的是这一具宿主启动时折好的那一份快照（D8）；每一条后面那一句说的是它由四层里哪一层写着，项目共享与命令行那两层只能读。
      {sessionId === null ? '现在没有打开的会话，说不出模型用的是哪一份'
        : <>这一份会话现在用的是 <code>{inUse.model ?? '读不出来'}</code>
          {inUse.pendingModel === undefined || inUse.pendingModel === null ? '，没有等着换的那一份' : <>，等在它轮次边界上的是 <code>{inUse.pendingModel}</code></>}</>}。
      地址只展示协议、主机、端口与路径那一段，密钥的值从来不进配置。
      审批规则表不在这四条里：它在设置里另一栏「审批规则」那里改。
    </p>
  </>;
}
