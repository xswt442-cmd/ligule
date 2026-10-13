import { useState } from 'react';
import { DropdownMenu } from 'radix-ui';
import { useText } from '../locale';
import { code } from '../protocol';
import type { Status } from '../status';
import { Icon } from './Icon';
import { keepEscape } from './ui';

export function PolicyPicker({ status, disabled, onSelect }: {
  status: Status | null;
  disabled: boolean;
  onSelect: (mode: 'ask' | 'auto' | null) => Promise<void>;
}) {
  const t = useText();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const active = status?.policySource === 'config' ? 'default' : status?.policy;
  const title = status === null ? t('审批方式', 'Approvals') : status.policy === 'ask'
    ? t('逐次审批', 'Ask each time') : status.policy === 'auto' ? t('按规则审批', 'Rule-based approval') : status.policy;
  const choose = async (value: 'ask' | 'auto' | null) => {
    setBusy(true);
    setFailure('');
    try { await onSelect(value); setOpen(false); }
    catch (error) { setFailure(code(error)); }
    finally { setBusy(false); }
  };
  const choices = [
    { value: 'ask', label: t('逐次审批', 'Ask each time'), mode: 'ask' as const },
    { value: 'auto', label: t('按规则审批', 'Rule-based approval'), mode: 'auto' as const },
    { value: 'default', label: t('使用默认', 'Use default'), mode: null },
  ];
  return <DropdownMenu.Root open={open} onOpenChange={setOpen}>
    <DropdownMenu.Trigger asChild><button type="button" className="composer-choice" disabled={disabled || status === null || busy} title={t('当前会话审批方式', 'Approval mode for this conversation')}><Icon name="check" size={14} /><span>{title}</span><Icon name="fold" size={12} /></button></DropdownMenu.Trigger>
    <DropdownMenu.Portal><DropdownMenu.Content className="menu policy-picker" side="top" align="start" sideOffset={8} onEscapeKeyDown={keepEscape}>
      <DropdownMenu.Label className="model-group-name">{t('审批方式', 'Approval mode')}</DropdownMenu.Label>
      {choices.map(choice => <DropdownMenu.Item key={choice.value} disabled={busy || active === choice.value} onSelect={event => { event.preventDefault(); void choose(choice.mode); }}><span>{choice.label}</span>{active === choice.value && <Icon name="check" size={14} />}</DropdownMenu.Item>)}
      <p className="policy-picker-note">{t('所有操作仍受工作区边界和拒绝规则约束。', 'Workspace boundaries and deny rules always apply.')}</p>
      {status?.policySource === 'config' && <p className="policy-picker-note">{t('当前使用配置默认值。', 'Currently using the configured default.')}</p>}
      {busy && <p className="policy-picker-note" role="status">{t('正在更新审批方式…', 'Updating approval mode…')}</p>}
      {failure && <div className="workspace-picker-error" role="alert"><span>{t('审批方式未更新。', 'Approval mode was not updated.')}</span><code>{failure}</code></div>}
    </DropdownMenu.Content></DropdownMenu.Portal>
  </DropdownMenu.Root>;
}
