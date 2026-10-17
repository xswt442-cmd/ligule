import { useCallback, useEffect, useState } from 'react';
import { code, type Client } from '../protocol';
import { WRITABLE_LAYERS } from '../config-layers';
import { Icon } from './Icon';
import { Modal, Row } from './ui';
import { useText } from '../locale';

type Rule = { tool: string; match?: string; decision: 'allow' | 'deny'; reason?: string };
type Shown = {
  rules?: Rule[];
  rulesSource?: string;
  // 配置中的默认策略；未配置时由 Host 返回空值，界面不自行推断。
  policyMode?: string;
  sources?: Record<string, string>;
  layers?: { layer: string; version: string; exists: boolean }[];
};
type Notice = { text: string; bad: boolean; code?: string };

const layerText = (layer: string, t: (chinese: string, english: string) => string): string => {
  if (layer === 'user') return t('使用者默认（~/.ligule/config.toml）', 'User defaults (~/.ligule/config.toml)');
  if (layer === 'projectLocal') return t('当前项目的本机覆盖（.ligule/config.local.toml）', 'This project’s local override (.ligule/config.local.toml)');
  return layer;
};

const sourceText = (source: string | undefined, t: (chinese: string, english: string) => string): string => {
  if (source === 'flag') return t('命令行 --config（只读）', 'Command line --config (read-only)');
  if (source === 'local') return t('当前项目的本机覆盖', 'This project’s local override');
  if (source === 'project') return t('项目共享配置（只读）', 'Shared project configuration (read-only)');
  if (source === 'user') return t('使用者默认', 'User defaults');
  return t('四层配置均未设置', 'Not set in any configuration layer');
};

const matchKind = (pattern: string, t: (chinese: string, english: string) => string) => pattern.includes('*')
  ? t('整段命令匹配', 'matches the whole command')
  : t('命令开头匹配', 'matches the start of the command');
const matchText = (pattern: string, t: (chinese: string, english: string) => string) => `${matchKind(pattern, t)} ${pattern}`;
const decisionText = (decision: Rule['decision'], t: (chinese: string, english: string) => string) =>
  decision === 'allow' ? t('放行', 'Allow') : t('不允许', 'Deny');

const blankRule = (): Rule => ({ tool: '', match: '', decision: 'allow', reason: '' });

export function PolicyRules({ client, projectRoot, onEdit }: {
  client: Client;
  projectRoot: string;
  /** 向父级报告尚未保存的编辑；空字符串表示撤回该报告。 */
  onEdit?: (reason: string) => void;
}) {
  const t = useText();
  const [shown, setShown] = useState<Shown | null>(null);
  const [note, setNote] = useState<Notice | null>(null);
  const [layer, setLayer] = useState('user');
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<{ index: number; rule: Rule } | null>(null);
  const [confirmNever, setConfirmNever] = useState(false);
  const held = saving
    ? t('“审批规则”正在保存；尚未收到结果。', 'Approval rules are saving; the result has not arrived yet.')
    : editing === null
      ? ''
      : editing.index < 0
        ? t('有一条新审批规则尚未保存。', 'A new approval rule is not saved yet.')
        : t(`第 ${editing.index + 1} 条审批规则的改动尚未保存。`, `Changes to approval rule ${editing.index + 1} are not saved yet.`);

  useEffect(() => {
    if (onEdit === undefined) return;
    onEdit(held);
    return () => onEdit('');
  }, [onEdit, held]);

  const target = projectRoot === '' ? {} : { projectRoot };

  const load = useCallback(async (keep = false): Promise<Shown | null> => {
    try {
      const answer = await client.call('config.get', target, 15_000) as Shown;
      setShown(answer);
      if (!keep) setNote(null);
      return answer;
    } catch (error) {
      setNote({ text: t('规则表读取失败。', 'Could not load approval rules.'), code: code(error), bad: true });
      return null;
    }
  }, [client, projectRoot]);

  useEffect(() => {
    void load();
  }, [load]);

  const versionOf = () => shown?.layers?.find((item) => item.layer === layer)?.version ?? '';

  const rulesFrom = () => shown?.rulesSource === undefined
    ? t('规则表来源无法读取。', 'Could not read the source of these rules.')
    : shown.rulesSource === 'none'
      ? t('四层配置均未设置规则表。', 'No configuration layer defines a rules table.')
      : t(`当前来源：${sourceText(shown.rulesSource, t)}。`, `Current source: ${sourceText(shown.rulesSource, t)}.`);

  const describe = (count: number) => t(
    `规则表现有 ${count} 条。新规则和默认档从下一次判定起生效；已经派发的调用不变，正运行的会话档位也不变。`,
    `The rules table has ${count} entries. Rule and default-tier changes apply from the next decision. Dispatched calls and a running session’s tier are unchanged.`,
  );

  const afterSave = async (saved: string) => {
    const fresh = await load(true);
    if (fresh !== null) setNote({ text: `${saved} ${describe(fresh.rules?.length ?? 0)}`, bad: false });
  };

  const setMode = async (mode: 'ask' | 'auto' | 'never') => {
    setSaving(true);
    try {
      await client.call('config.set', { field: 'policy.mode', value: mode, layer, version: versionOf(), ...target }, 30_000);
      await afterSave(t(`已将配置默认档设为 ${mode}，写入${layerText(layer, t)}。`, `Set the default tier to ${mode} in ${layerText(layer, t)}.`));
    } catch (error) {
      setNote(saveFailure(error, t));
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
      const saved = editing.index < 0
        ? t(`已新增规则并写入${layerText(layer, t)}。`, `Added a rule to ${layerText(layer, t)}.`)
        : t(`已修改第 ${editing.index + 1} 条规则并写入${layerText(layer, t)}。`, `Updated rule ${editing.index + 1} in ${layerText(layer, t)}.`);
      await afterSave(saved);
      setEditing(null);
    } catch (error) {
      setNote(saveFailure(error, t));
    } finally {
      setSaving(false);
    }
  };

  const removeRule = async (index: number) => {
    setSaving(true);
    try {
      await client.call('config.set', { field: 'policy.rules', layer, version: versionOf(), op: 'remove', index, ...target }, 30_000);
      await afterSave(t(`已从${layerText(layer, t)}移除第 ${index + 1} 条规则。`, `Removed rule ${index + 1} from ${layerText(layer, t)}.`));
    } catch (error) {
      setNote(saveFailure(error, t));
    } finally {
      setSaving(false);
    }
  };

  const rules = shown?.rules ?? [];

  return <>
    <button type="button" className="rail-refresh" disabled={saving} onClick={() => void load()}><Icon name="refresh" size={13} />{t('重新读取', 'Reload')}</button>
    {note !== null && <div className="session-note" data-tone={note.bad ? 'bad' : undefined}>
      <span>{note.text}</span>
      {note.code !== undefined && <details><summary>{t('错误代码', 'Error code')}</summary><code>{note.code}</code></details>}
    </div>}
    {shown === null ? <p className="stub">{t('正在读取规则表…', 'Loading approval rules…')}</p> : <>
      <p className="sheet-note">{t('显示合并后的规则表。规则与默认档按当前会话所属项目读取；选择另一项目后随之切换。没有打开的会话时使用 Host 启动项目。', 'This is the merged rules table. Rules and the default tier use the project of the current session and follow the selected project. With no session open, the Host’s startup project is used.')} {rulesFrom()}</p>
      <Row label={t('写入位置', 'Save to')}>
        <select value={layer} disabled={saving} onChange={(event) => setLayer(event.target.value)}>
          {WRITABLE_LAYERS.map(([id]) => <option key={id} value={id}>{layerText(id, t)}</option>)}
        </select>
      </Row>
      <Row label={t('默认审批方式', 'Default approval mode')} note={t(`会话可单独更改自己的档位。当前配置来源：${sourceText(shown.sources?.['policy.mode'], t)}。`, `A session can override this mode for itself. Current source: ${sourceText(shown.sources?.['policy.mode'], t)}.`)}>
        <select
          value={shown.policyMode ?? ''}
          disabled={saving}
          onChange={(event) => { if (event.target.value === 'never') setConfirmNever(true); else if (event.target.value !== '') void setMode(event.target.value as 'ask' | 'auto'); }}
        >
          <option value="">{t('未设置', 'Not set')}</option>
          <option value="ask">ask — {t('未被放行规则覆盖的调用需要批准', 'Calls not covered by an allow rule require approval')}</option>
          <option value="auto">auto — {t('由守卫与命令语法判定，放行规则不参与', 'Guards and command parsing decide; allow rules do not apply')}</option>
          <option value="never">never — {t('跳过逐项批准；越界、拒绝规则和模糊操作仍会被拒绝', 'Skip per-action approval; boundaries, deny rules, and ambiguous operations still block')}</option>
        </select>
      </Row>
      {shown.policyMode === 'never' && <p className="session-note" data-tone="bad">{t('完全不需审批已设为配置默认。工具仍受工作区边界、拒绝规则和安全守卫约束。', 'No approval is the configured default. Workspace boundaries, deny rules, and safety guards still apply.')}</p>}

      <h3 className="group-label">{t(`规则（${rules.length} 条）`, `Rules (${rules.length})`)}</h3>
      <p className="sheet-note">{t('在逐次询问模式下，复合命令的每一段都要被同一条放行规则覆盖，才会跳过询问。禁止规则作用于整条命令及各段，放行规则不能覆盖它。', 'In ask mode, one allow rule must cover every part of a compound command to skip approval. A deny rule applies to the full command and each part; an allow rule cannot override it.')}</p>
      {rules.length === 0 && <p className="stub">{shown.rules === undefined
        ? t('此 Host 不提供配置读写，无法读取规则表。', 'This Host does not provide configuration access, so the rules table is unavailable.')
        : t('当前没有审批规则。添加一条规则即可开始。', 'There are no approval rules. Add a rule to get started.')}</p>}
      {rules.map((rule, index) => <div className="rule-row" key={`${index}:${rule.tool}`}>
        <span className="rule-kind" data-decision={rule.decision}>{decisionText(rule.decision, t)}</span>
        <code className="rule-tool">{rule.tool}</code>
        <span className="rule-detail">{rule.match === undefined || rule.match === '' ? t('每次调用', 'Every call') : matchText(rule.match, t)}</span>
        {rule.reason !== undefined && rule.reason !== '' && <span className="rule-detail">{rule.reason}</span>}
        <span className="bar-spacer" />
        <button type="button" className="mini chip" disabled={saving} onClick={() => setEditing({ index, rule: { ...blankRule(), ...rule, match: rule.match ?? '', reason: rule.reason ?? '' } })}>{t('编辑', 'Edit')}</button>
        <button type="button" className="mini chip" disabled={saving} onClick={() => void removeRule(index)}>{t('移除', 'Remove')}</button>
      </div>)}

      {editing === null ? <button type="button" disabled={saving} onClick={() => { setNote(null); setEditing({ index: -1, rule: blankRule() }); }}>{t('添加规则', 'Add rule')}</button>
        : <div className="region-group">
          <h3>{editing.index < 0 ? t('新规则', 'New rule') : t(`编辑规则 ${editing.index + 1}`, `Edit rule ${editing.index + 1}`)}</h3>
          <Row label={t('工具能力名', 'Tool capability')} note={t('普通工具填写工具名。MCP 工具使用 mcp:<server>/<tool>，不使用 mcp.call。', 'Use the tool name for built-in tools. For MCP tools, use mcp:<server>/<tool>, not mcp.call.')}>
            <input value={editing.rule.tool} placeholder={t('例如 read、exec、write', 'e.g. read, exec, write')} onChange={(event) => setEditing({ ...editing, rule: { ...editing.rule, tool: event.target.value } })} />
          </Row>
          <Row label={t('命令匹配', 'Command match')} note={t('只匹配命令文本。模式从命令开头匹配，并在参数边界结束；* 匹配其后的任意文本。留空表示匹配该工具的所有调用，包括没有命令文本的文件操作。', 'Matches command text only. The pattern starts at the command beginning and ends at an argument boundary; * matches any text after it. Leave blank to match every call for this tool, including file operations without command text.')}>
            <input value={editing.rule.match} onChange={(event) => setEditing({ ...editing, rule: { ...editing.rule, match: event.target.value } })} />
          </Row>
          <Row label={t('判定', 'Decision')}>
            <select value={editing.rule.decision} onChange={(event) => setEditing({ ...editing, rule: { ...editing.rule, decision: event.target.value as Rule['decision'] } })}>
              <option value="allow">{t('放行', 'Allow')}</option>
              <option value="deny">{t('不允许', 'Deny')}</option>
            </select>
          </Row>
          <Row label={t('理由', 'Reason')}>
            <input value={editing.rule.reason} onChange={(event) => setEditing({ ...editing, rule: { ...editing.rule, reason: event.target.value } })} />
          </Row>
          <p className="session-note">
            {t('预览：写入', 'Preview: write to')} {layerText(layer, t)} — {decisionText(editing.rule.decision, t)} <code>{editing.rule.tool === '' ? t('请填写工具名', 'Enter a tool name') : editing.rule.tool}</code>
            {editing.rule.match ? <>; {matchKind(editing.rule.match, t)} <code>{editing.rule.match}</code></> : `; ${t('匹配每次调用', 'matches every call')}`}
            {editing.rule.reason === '' ? '' : <>; {t('理由', 'Reason')}: {editing.rule.reason}</>}.
          </p>
          <div className="inline-field">
            <button type="button" disabled={saving || editing.rule.tool === ''} onClick={() => void saveRule()}>{t('保存', 'Save')}</button>
            <button type="button" disabled={saving} onClick={() => setEditing(null)}>{t('取消', 'Cancel')}</button>
          </div>
        </div>}
    </>}
    {confirmNever && <Modal title={t('启用完全不需审批？', 'Enable no-approval mode?')} className="confirm" onClose={() => setConfirmNever(false)}><h2 className="confirm-lead">{t('此配置会应用于使用该默认值的会话。', 'This default applies to sessions that inherit it.')}</h2><p className="confirm-note">{t('工具调用不会逐项等待批准，可能修改工作区文件或运行命令。工作区边界、拒绝规则与安全守卫仍生效；需要额外审批或无法安全判定的操作会被拒绝。', 'Tool calls will not wait for individual approval and may modify workspace files or run commands. Workspace boundaries, deny rules, and safety guards remain active; operations requiring extra approval or a safe determination will be denied.')}</p><div className="confirm-actions"><button type="button" onClick={() => setConfirmNever(false)}>{t('取消', 'Cancel')}</button><button type="button" className="primary-button" onClick={() => { setConfirmNever(false); void setMode('never'); }}>{t('确认启用', 'Enable')}</button></div></Modal>}
  </>;
}

function saveFailure(error: unknown, t: (chinese: string, english: string) => string): Notice {
  const stableCode = code(error);
  return {
    text: stableCode === 'config_version_stale'
      ? t('配置文件已被其他写入修改，本次没有保存。重新读取后再试。', 'The configuration changed elsewhere, so this change was not saved. Reload and try again.')
      : t('规则未保存。', 'The rule was not saved.'),
    code: stableCode,
    bad: true,
  };
}
