import { useCallback, useEffect, useState } from 'react';
import { code, type Client } from '../protocol';
import { layerName, sourceLine, WRITABLE_LAYERS } from '../config-layers';
import { Icon } from './Icon';
import { Row } from './ui';

// 审批规则这一栏走的是「模型与端点」那四条已经在用的写路径：选层、先预览、带着读回来的那一个版本发，
// 把保存结果与什么时候生效分两句说出来；版本对不上时报冲突那一句，不报成功（方案 7.2）。
// 档位、规则表、来源与那一份版本出自 `config.get` 的一次读取，写完再读一遍，界面不拿写入的回答自己拼（方案 3A）。
// 字段名与形状跟契约一致：`policy.mode`（值为 'ask' 或 'auto'）与 `policy.rules`（op 为 add / update / remove）。
type Rule = { tool: string; match?: string; decision: 'allow' | 'deny'; reason?: string };
type Shown = {
  rules?: Rule[];
  rulesSource?: string;
  // 配置文件里此刻写着的那一份默认档：没写这一条时宿主交回的是空，界面不猜一档（方案 3A）。
  policyMode?: string;
  sources?: Record<string, string>;
  layers?: { layer: string; version: string; exists: boolean }[];
};

const DECISION_NAMES: Record<Rule['decision'], string> = { allow: '放行', deny: '不允许' };

// 一条规则怎么写才算命中，界面要说成判定里的那一种读法（`src/kernel/match.js`）：
// 带 `*` 的是把整段命令比完，不带的是命令的开头且要对到一个参数的边界为止。
const matchKind = (pattern: string) => (pattern.includes('*') ? '整段命令对得上' : '命令开头是');
const matchText = (pattern: string) => `${matchKind(pattern)} ${pattern}`;

// 空白的一条待写规则：新增从这一份起，编辑读回那一条填进来。
const blankRule = (): Rule => ({ tool: '', match: '', decision: 'allow', reason: '' });

export function PolicyRules({ client, projectRoot, onEdit }: {
  client: Client;
  projectRoot: string;
  /** 这一栏手里攥着没写进配置的东西时报给父层，空串是收回（审阅 G2）。 */
  onEdit?: (reason: string) => void;
}) {
  const [shown, setShown] = useState<Shown | null>(null);
  // 说明那一句带着自己的语气：读不回来与没写进去才报警，写完与预览不报（方案 4.3 那一句）。
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);
  const [layer, setLayer] = useState('user');
  const [saving, setSaving] = useState(false);
  // `editing` 是 null 就是没在写规则；给了 index 是改那一条，给 -1 是新增一条。
  const [editing, setEditing] = useState<{ index: number; rule: Rule } | null>(null);
  // 正在写配置时也算攥着：那一次的答复还没读回来，离开就看不见它写成没有。
  const held = saving
    ? '「审批规则」正在写配置文件，这一笔的答复还没读回来'
    : editing === null
      ? ''
      : editing.index < 0 ? '「审批规则」里有一条新规则还没保存' : `「审批规则」里第 ${editing.index + 1} 条的改动还没保存`;

  useEffect(() => {
    if (onEdit === undefined) return;
    onEdit(held);
    return () => onEdit('');
  }, [onEdit, held]);

  // 这一栏读写的是哪一份项目的文件：左侧选了别的项目，这里的读与写就跟着换成那一个项目的两层（方案 3.2、审阅 F3）。
  const target = projectRoot === '' ? {} : { projectRoot };

  const load = useCallback(async (keep = false): Promise<Shown | null> => {
    try {
      const answer = await client.call('config.get', target, 15_000) as Shown;
      setShown(answer);
      // 读得回来就把上一次读不回来的那句说明清掉：那一句话带着「再问一次」的按钮，留着就成了一句假话。
      if (!keep) setNote(null);
      return answer;
    } catch (error) {
      setNote({ text: `规则表读不回来：${code(error)}`, bad: true });
      return null;
    }
  }, [client, projectRoot]);

  useEffect(() => {
    void load();
  }, [load]);

  const versionOf = () => shown?.layers?.find((item) => item.layer === layer)?.version ?? '';

  // 生效那一张表出自哪一层，由同一次读取交回；那一格读不出来时说出来，不写成「四层里都没写」。
  const rulesFrom = () => shown?.rulesSource === undefined
    ? '哪一层写着这一张表读不出来'
    : shown.rulesSource === 'none'
      ? '四层里都没写这一张表'
      : `现在写着这一张表的是${sourceLine(shown.rulesSource)}`;

  // 写完重读一遍（与「模型与端点」那一栏同一条路）：界面上的规则表、档位、来源与那一份版本说的是同一时刻的那一份文件。
  // 不拿写入那一次的回答自己拼：自己拼出来那一份只有这一栏知道，下一次写要带的版本也就不一定是刚落盘的那一份。
  const afterSave = async (saved: string) => {
    const fresh = await load(true);
    if (fresh !== null) setNote({ text: `${saved}${describe(fresh.rules?.length ?? 0)}`, bad: false });
  };

  // 保存结果一句、什么时候生效一句：这两句从不合在一起（方案 7.2）。
  // 生效的边界是下一次判定（方案 7.3 第一行），不是下一次装配宿主：已经派发出去的那一次调用不受这一笔影响。
  const describe = (count: number) => `这一份表现在一共 ${count} 条。规则表与默认档从下一次判定起用上这一份，已经派发出去的那一次调用不变；跑着的会话自己改过档位的那一份不动。`;

  const setMode = async (mode: 'ask' | 'auto') => {
    setSaving(true);
    try {
      await client.call('config.set', { field: 'policy.mode', value: mode, layer, version: versionOf(), ...target }, 30_000);
      await afterSave(`配置默认档已写成 ${mode}，落进${layerName(layer)}。`);
    } catch (error) {
      setNote({ text: conflictOr(error), bad: true });
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
      ? { field: 'policy.rules', layer, version: versionOf(), op: 'add', ...target, ...flat }
      : { field: 'policy.rules', layer, version: versionOf(), op: 'update', index: editing.index, ...target, ...flat };
    setSaving(true);
    try {
      await client.call('config.set', params, 30_000);
      await afterSave(`${editing.index < 0 ? '加了一条规则' : `改了第 ${editing.index + 1} 条规则`}，落进${layerName(layer)}。`);
      setEditing(null);
    } catch (error) {
      setNote({ text: conflictOr(error), bad: true });
    } finally {
      setSaving(false);
    }
  };

  const removeRule = async (index: number) => {
    setSaving(true);
    try {
      await client.call('config.set', { field: 'policy.rules', layer, version: versionOf(), op: 'remove', index, ...target }, 30_000);
      await afterSave(`去掉了第 ${index + 1} 条规则，落进${layerName(layer)}。`);
    } catch (error) {
      setNote({ text: conflictOr(error), bad: true });
    } finally {
      setSaving(false);
    }
  };

  const rules = shown?.rules ?? [];

  return <>
    <button type="button" className="rail-refresh" onClick={() => void load()}><Icon name="refresh" size={13} /> 再问一次</button>
    {note !== null && <p className="session-note" data-tone={note.bad ? 'bad' : undefined}>{note.text}</p>}
    {shown === null ? <p className="stub">规则表还没读回来。</p> : <>
      <p className="sheet-note">这一份表是四层折完的结果，{rulesFrom()}。这一栏读与写的是这一份会话所属那一个项目的两层文件；左侧选了别的项目，这里跟着换成那一个项目的文件。没有打开的会话时说的是这一具宿主启动时那一个项目。</p>
      <Row label="写进哪一层">
        <select value={layer} onChange={(event) => setLayer(event.target.value)}>
          {WRITABLE_LAYERS.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
      </Row>
      {/* 档位读的是这一次读取交回的那一份值：四层里没写就摆在「没写」那一格，界面不替配置文件猜一档（方案 3A）。 */}
      <Row label="配置默认档" note={`整个运行默认按哪一档走。会话临时改的档位不动这一格。现在写着这一条的是${sourceLine(shown.sources?.['policy.mode'])}。`}>
        <select
          value={shown.policyMode ?? ''}
          disabled={saving}
          onChange={(event) => { if (event.target.value !== '') void setMode(event.target.value as 'ask' | 'auto'); }}
        >
          <option value="">（四层里都没写这一条）</option>
          <option value="ask">ask（没有放行规则盖住的调用要问到人）</option>
          <option value="auto">auto（看守卫与命令语法，放行规则在这一档不参与）</option>
        </select>
      </Row>

      <h3 className="group-label">规则表（{rules.length} 条）</h3>
      {/* 这一张表在判定链里排在守卫之前、问人之前（`src/kernel/policy.js`）：一条命令分成几段时怎么算，写规则的人要在界面上看得见。 */}
      <p className="sheet-note">一条命令被拆成几段时，逐次询问这一档要同一条放行规则盖住每一段才不问人，几条规则各盖住一段不算盖住。不允许的规则对整条文本与每一段都生效，写在它前面的放行规则压不掉它。</p>
      {rules.length === 0 && <p className="stub">{shown.rules === undefined ? '这一具宿主没有配置文件的读写口，规则表读不出来。' : '配置里现在没有一条规则。下面那一枚「加一条规则」加上第一条。'}</p>}
      {rules.map((rule, index) => <div className="rule-row" key={`${index}:${rule.tool}`}>
        <span className="rule-kind" data-decision={rule.decision}>{DECISION_NAMES[rule.decision]}</span>
        <code className="rule-tool">{rule.tool}</code>
        <span className="rule-detail">{rule.match === undefined || rule.match === '' ? '每一次调用' : matchText(rule.match)}</span>
        {rule.reason !== undefined && rule.reason !== '' && <span className="rule-detail">{rule.reason}</span>}
        <span className="bar-spacer" />
        <button type="button" className="mini chip" disabled={saving} onClick={() => setEditing({ index, rule: { ...blankRule(), ...rule, match: rule.match ?? '', reason: rule.reason ?? '' } })}>改</button>
        <button type="button" className="mini chip" disabled={saving} onClick={() => void removeRule(index)}>去掉</button>
      </div>)}

      {editing === null ? <button type="button" onClick={() => { setNote(null); setEditing({ index: -1, rule: blankRule() }); }}>加一条规则</button>
        : <div className="region-group">
          <h3>{editing.index < 0 ? '新加的那一条' : `改第 ${editing.index + 1} 条`}</h3>
          <Row label="工具的能力名" note="普通工具用它自己的名字。MCP 的调用按 mcp:<服务器>/<工具> 判，登记表里的 mcp.call 不是这一格要写的那一个。">
            <input value={editing.rule.tool} placeholder="read、exec、write" onChange={(event) => setEditing({ ...editing, rule: { ...editing.rule, tool: event.target.value } })} />
          </Row>
          <Row label="匹配的命令" note="只比命令文本，不比文件路径。这一串要从命令的开头对上，并且对到一个参数的边界为止；串里的 * 是往后的任意内容，整段比完。留空是这一件工具的每一次调用都算命中：读文件那一类调用没有命令文本，只有留空的规则盖得住。">
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
            要写进{layerName(layer)}的那一条是：判定 {DECISION_NAMES[editing.rule.decision]} <code>{editing.rule.tool === '' ? '（还没填工具名）' : editing.rule.tool}</code>
            {editing.rule.match ? <>，{matchKind(editing.rule.match)} <code>{editing.rule.match}</code></> : '，每一次调用都算命中'}
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

// 版本对不上时报的是冲突那一句（与「模型与端点」那一栏同一条说法），不能看着像成功。
function conflictOr(error: unknown): string {
  return code(error) === 'config_version_stale'
    ? '那一层文件在这之后被别的过程或你在编辑器里改过。这一次没有写进去，他的那份留着。按「再问一次」读回最新版本再试。'
    : `没写进去：${code(error)}`;
}
