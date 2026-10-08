import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { code, type Client } from '../protocol';
import { Icon } from './Icon';

// 审批规则这一栏走的是「模型与端点」那四条已经在用的写路径：选层、先预览、带着读回来的那一个版本发，
// 把保存结果与什么时候生效分两句说出来；版本对不上时报冲突那一句，不报成功（方案 7.2）。
// 字段名与形状跟契约一致：`policy.mode`（值为 'ask' 或 'auto'）与 `policy.rules`（op 为 add / update / remove）。
type Rule = { tool: string; match?: string; decision: 'allow' | 'deny'; reason?: string };
type Shown = {
  rules?: Rule[];
  rulesSource?: string;
  policy?: string;
  layers?: { layer: string; version: string; exists: boolean }[];
};

// 可写的两层与它落在哪一个约定位置（与「模型与端点」那一栏是同一批层）。
const LAYERS: [string, string][] = [
  ['user', '使用者默认那一层（~/.ligule/config.toml）'],
  ['projectLocal', '当前项目的本机覆盖（.ligule/config.local.toml）'],
];
const nameOf = (layer: string) => LAYERS.find(([id]) => id === layer)?.[1] ?? layer;

const DECISION_NAMES: Record<Rule['decision'], string> = { allow: '放行', deny: '不允许' };

// 空白的一条待写规则：新增从这一份起，编辑读回那一条填进来。
const blankRule = (): Rule => ({ tool: '', match: '', decision: 'allow', reason: '' });

export function PolicyRules({ client }: { client: Client }) {
  const [shown, setShown] = useState<Shown | null>(null);
  const [note, setNote] = useState('');
  const [layer, setLayer] = useState('user');
  const [saving, setSaving] = useState(false);
  // `editing` 是 null 就是没在写规则；给了 index 是改那一条，给 -1 是新增一条。
  const [editing, setEditing] = useState<{ index: number; rule: Rule } | null>(null);

  const load = useCallback(async () => {
    try {
      setShown(await client.call('config.get', {}, 15_000) as Shown);
      // 读得回来就把上一次读不回来的那句说明清掉：那一句话带着「再问一次」的按钮，留着就成了一句假话。
      setNote('');
    } catch (error) {
      setNote(`规则表读不回来：${code(error)}`);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const versionOf = () => shown?.layers?.find((item) => item.layer === layer)?.version ?? '';

  // 一次写之后把返回的 `rules` 摊回界面：交回的就是写完那一份表，不自己拼。
  // 那一份层的版本也跟着交回的那一份换掉：下一次写要带的是刚落盘那一份的版本，不然自己刚写过的那一次会被读成「别人改过」。
  const applyAnswer = (answer: { rules?: Rule[]; created?: boolean; layers?: Shown['layers'] }) => {
    setShown((current) => ({
      ...(current ?? {}),
      ...(answer.rules === undefined ? {} : { rules: answer.rules }),
      ...(answer.layers === undefined ? {} : { layers: answer.layers }),
    }));
    return answer;
  };

  // 保存结果一句、什么时候生效一句：这两句从不合在一起（方案 7.2）。
  const describe = (saved: string, answer: { rules?: Rule[] }) => {
    const count = answer.rules?.length ?? 0;
    return `${saved}这一份表现在一共 ${count} 条。配置里的规则表在下一次装配那一份宿主时才重算，跑着的这一轮用的还是开始时的规则。`;
  };

  const setMode = async (mode: 'ask' | 'auto') => {
    setSaving(true);
    try {
      const answer = await client.call('config.set', { field: 'policy.mode', value: mode, layer, version: versionOf() }, 30_000) as { rules?: Rule[] };
      applyAnswer(answer);
      setNote(describe(`配置默认档已写成 ${mode}，落进${nameOf(layer)}。`, answer));
    } catch (error) {
      setNote(conflictOr(error));
    } finally {
      setSaving(false);
    }
  };

  const saveRule = async () => {
    if (editing === null || editing.rule.tool === '') return;
    const rule: Rule = {
      tool: editing.rule.tool,
      ...(editing.rule.match === '' ? {} : { match: editing.rule.match }),
      decision: editing.rule.decision,
      ...(editing.rule.reason === undefined || editing.rule.reason === '' ? {} : { reason: editing.rule.reason }),
    };
    // 协议表里那四格各是一个字符串，规则的形状由宿主那一边校验（D100）。
    const flat = {
      ruleTool: rule.tool,
      ruleDecision: rule.decision,
      ...(rule.match === undefined ? {} : { ruleMatch: rule.match }),
      ...(rule.reason === undefined ? {} : { ruleReason: rule.reason }),
    };
    const params = editing.index < 0
      ? { field: 'policy.rules', layer, version: versionOf(), op: 'add', ...flat }
      : { field: 'policy.rules', layer, version: versionOf(), op: 'update', index: editing.index, ...flat };
    setSaving(true);
    try {
      const answer = await client.call('config.set', params, 30_000) as { rules?: Rule[] };
      applyAnswer(answer);
      setNote(describe(`${editing.index < 0 ? '加了一条规则' : '改了第 ' + String(editing.index + 1) + ' 条规则'}，落进${nameOf(layer)}。`, answer));
      setEditing(null);
    } catch (error) {
      setNote(conflictOr(error));
    } finally {
      setSaving(false);
    }
  };

  const removeRule = async (index: number) => {
    setSaving(true);
    try {
      const answer = await client.call('config.set', { field: 'policy.rules', layer, version: versionOf(), op: 'remove', index }, 30_000) as { rules?: Rule[] };
      applyAnswer(answer);
      setNote(describe(`去掉了第 ${index + 1} 条规则，落进${nameOf(layer)}。`, answer));
    } catch (error) {
      setNote(conflictOr(error));
    } finally {
      setSaving(false);
    }
  };

  const rules = shown?.rules ?? [];

  return <>
    <button type="button" className="rail-refresh" onClick={() => void load()}><Icon name="refresh" size={13} /> 再问一次</button>
    {note !== '' && <p className="session-note">{note}</p>}
    {shown === null ? <p className="stub">规则表还没读回来。</p> : <>
      <p className="sheet-note">
        规则表来自哪一层由宿主交回：现在写着这一份表的是 <code>{shown.rulesSource ?? '读不出来'}</code> 层。整份表读的是折好的那一份合并结果。
      </p>
      <Row label="写进哪一层">
        <select value={layer} onChange={(event) => setLayer(event.target.value)}>
          {LAYERS.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
      </Row>
      <Row label="配置默认档" note="整个运行默认按哪一档走。会话临时改的档位不动这一格。">
        <select value={shown.policy ?? 'ask'} disabled={saving} onChange={(event) => void setMode(event.target.value as 'ask' | 'auto')}>
          <option value="ask">ask（每件事都先问到人）</option>
          <option value="auto">auto（规则、守卫与命令语法都过关才直接放行）</option>
        </select>
      </Row>

      <h3 className="group-label">规则表（{rules.length} 条）</h3>
      {rules.length === 0 && <p className="stub">配置里现在没有一条规则。下面那一枚「加一条规则」加上第一条。</p>}
      {rules.map((rule, index) => <div className="rule-row" key={`${index}:${rule.tool}`}>
        <span className="rule-kind" data-decision={rule.decision}>{DECISION_NAMES[rule.decision]}</span>
        <code className="rule-tool">{rule.tool}</code>
        {rule.match !== undefined && rule.match !== '' && <span className="rule-detail">匹配 {rule.match}</span>}
        {rule.reason !== undefined && rule.reason !== '' && <span className="rule-detail">{rule.reason}</span>}
        <span className="bar-spacer" />
        <button type="button" className="mini chip" disabled={saving} onClick={() => setEditing({ index, rule: { ...blankRule(), ...rule, match: rule.match ?? '', reason: rule.reason ?? '' } })}>改</button>
        <button type="button" className="mini chip" disabled={saving} onClick={() => void removeRule(index)}>去掉</button>
      </div>)}

      {editing === null ? <button type="button" onClick={() => { setNote(''); setEditing({ index: -1, rule: blankRule() }); }}>加一条规则</button>
        : <div className="region-group">
          <h3>{editing.index < 0 ? '新加的那一条' : `改第 ${editing.index + 1} 条`}</h3>
          <Row label="工具名">
            <input value={editing.rule.tool} placeholder="read、exec、write" onChange={(event) => setEditing({ ...editing, rule: { ...editing.rule, tool: event.target.value } })} />
          </Row>
          <Row label="匹配的字" note="只在命令文本或路径里含这一串字时命中。整件工具都放行就留空。">
            <input value={editing.rule.match} onChange={(event) => setEditing({ ...editing, rule: { ...editing.rule, match: event.target.value } })} />
          </Row>
          <Row label="判定">
            <select value={editing.rule.decision} onChange={(event) => setEditing({ ...editing, rule: { ...editing.rule, decision: event.target.value as Rule['decision'] } })}>
              <option value="allow">放行</option>
              <option value="deny">不允许</option>
            </select>
          </Row>
          <Row label="为什么这么定">
            <input value={editing.rule.reason} onChange={(event) => setEditing({ ...editing, rule: { ...editing.rule, reason: event.target.value } })} />
          </Row>
          {/* 先预览真正会写进去的那一行：这一行就是发出去的那一条规则，界面不藏别的东西。 */}
          <p className="session-note">
            要写进{nameOf(layer)}的那一条是：判定 {DECISION_NAMES[editing.rule.decision]} <code>{editing.rule.tool === '' ? '（还没填工具名）' : editing.rule.tool}</code>
            {editing.rule.match === '' ? '' : <>，匹配 <code>{editing.rule.match}</code></>}
            {editing.rule.reason === '' ? '' : <>，理由 {editing.rule.reason}</>}。
          </p>
          <div className="inline-field">
            <button type="button" disabled={saving || editing.rule.tool === ''} onClick={() => void saveRule()}>保存</button>
            <button type="button" onClick={() => setEditing(null)}>不收这笔</button>
          </div>
        </div>}
    </>}
  </>;
}

function Row({ label, note, children }: { label: string; note?: string; children: ReactNode }) {
  return <div className="sheet-row">
    <span className="sheet-label">{label}</span>
    <span className="sheet-value">
      {children}
      {note !== undefined && note !== '' && <span className="sheet-hint">{note}</span>}
    </span>
  </div>;
}

// 版本对不上时报的是冲突那一句（与「模型与端点」那一栏同一条说法），不能看着像成功。
function conflictOr(error: unknown): string {
  return code(error) === 'config_version_stale'
    ? '那一层文件在这之后被别的过程或你在编辑器里改过。这一次没有写进去，他的那份留着。按「再问一次」读回最新版本再试。'
    : `没写进去：${code(error)}`;
}
