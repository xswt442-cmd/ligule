import { useState } from 'react';
import { DropdownMenu } from 'radix-ui';
import { useText } from '../locale';
import { code } from '../protocol';
import type { Status } from '../status';
import { Icon } from './Icon';
import { keepEscape, Modal } from './ui';

export function PolicyPicker({ status, disabled, onSelect }: {
  status: Status | null;
  disabled: boolean;
  onSelect: (mode: 'ask' | 'auto' | 'never' | null) => Promise<void>;
}) {
  const t = useText();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const [confirmNever, setConfirmNever] = useState(false);
  const active = status?.policySource === 'config' ? 'default' : status?.policy;
  const title = status === null ? t('审批方式', 'Approvals') : status.policy === 'ask'
    ? t('逐次审批', 'Ask each time') : status.policy === 'auto' ? t('按规则审批', 'Rule-based approval') : status.policy === 'never' ? t('完全不需审批', 'No approval') : status.policy;
  const choose = async (value: 'ask' | 'auto' | 'never' | null) => {
    setBusy(true);
    setFailure('');
    try { await onSelect(value); setOpen(false); }
    catch (error) { setFailure(code(error)); }
    finally { setBusy(false); }
  };
  const choices = [
    { value: 'ask', label: t('逐次审批', 'Ask each time'), mode: 'ask' as const },
    { value: 'auto', label: t('按规则审批', 'Rule-based approval'), mode: 'auto' as const },
    { value: 'never', label: t('完全不需审批', 'No approval'), mode: 'never' as const },
    { value: 'default', label: t('使用默认', 'Use default'), mode: null },
  ];
  return <>
  <DropdownMenu.Root open={open} onOpenChange={setOpen}>
    <DropdownMenu.Trigger asChild><button type="button" className="composer-choice" disabled={disabled || status === null || busy} title={t('当前会话审批方式', 'Approval mode for this conversation')}><Icon name="check" size={14} /><span>{title}</span><Icon name="fold" size={12} /></button></DropdownMenu.Trigger>
    <DropdownMenu.Portal><DropdownMenu.Content className="menu policy-picker" side="top" align="start" sideOffset={8} onEscapeKeyDown={keepEscape}>
      <DropdownMenu.Label className="model-group-name">{t('审批方式', 'Approval mode')}</DropdownMenu.Label>
      {choices.map(choice => <DropdownMenu.Item key={choice.value} disabled={busy || active === choice.value} onSelect={event => { event.preventDefault(); if (choice.mode === 'never') { setOpen(false); setConfirmNever(true); } else void choose(choice.mode); }}><span>{choice.label}</span>{active === choice.value && <Icon name="check" size={14} />}</DropdownMenu.Item>)}
      <p className="policy-picker-note">{t('所有操作仍受工作区边界和拒绝规则约束。', 'Workspace boundaries and deny rules always apply.')}</p>
      <p className="policy-picker-note">{t('无审批只跳过逐项确认；安全守卫仍会拒绝越界或无法安全判定的操作。', 'No approval skips per-action confirmation only; safety guards still deny out-of-bound or ambiguous operations.')}</p>
      {status?.policySource === 'config' && <p className="policy-picker-note">{t('当前使用配置默认值。', 'Currently using the configured default.')}</p>}
      {busy && <p className="policy-picker-note" role="status">{t('正在更新审批方式…', 'Updating approval mode…')}</p>}
      {failure && <div className="workspace-picker-error" role="alert"><span>{t('审批方式未更新。', 'Approval mode was not updated.')}</span><code>{failure}</code></div>}
    </DropdownMenu.Content></DropdownMenu.Portal>
  </DropdownMenu.Root>
  {confirmNever && <Modal title={t('启用完全不需审批？', 'Enable no-approval mode?')} className="confirm" onClose={() => setConfirmNever(false)}><h2 className="confirm-lead">{t('之后的工具调用不会逐项等待批准。', 'Tool calls will no longer wait for individual approval.')}</h2><p className="confirm-note">{t('工具可能修改工作区文件或运行命令。工作区边界、拒绝规则与安全守卫仍会生效；需要额外审批或无法安全判定的操作会被拒绝。', 'Tools may modify workspace files or run commands. Workspace boundaries, deny rules, and safety guards remain active; operations requiring extra approval or an unambiguous safety decision will be denied.')}</p><div className="confirm-actions"><button type="button" onClick={() => setConfirmNever(false)}>{t('取消', 'Cancel')}</button><button type="button" className="primary-button" onClick={() => { setConfirmNever(false); void choose('never'); }}>{t('确认启用', 'Enable')}</button></div></Modal>}
  </>;
}
