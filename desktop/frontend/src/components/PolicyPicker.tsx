import { useState } from 'react';
import { DropdownMenu } from 'radix-ui';
import { useText } from '../locale';
import { code } from '../protocol';
import type { Status } from '../status';
import { Icon } from './Icon';
import { keepEscape, Modal } from './ui';

type PolicySelection = 'ask' | 'auto' | 'none';
type PolicyValue = PolicySelection | 'never';

export function PolicyPicker({ status, initialPolicy, disabled, onSelect }: {
  status: Status | null;
  initialPolicy: PolicyValue | null;
  disabled: boolean;
  onSelect: (mode: PolicySelection | null) => Promise<void>;
}) {
  const t = useText();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const [confirmNone, setConfirmNone] = useState(false);
  const active = status === null ? initialPolicy ?? 'default' : status.policySource === 'config' ? 'default' : status.policy;
  const title = status === null
    ? initialPolicy === null ? t('默认审批', 'Default approval') : policyLabel(initialPolicy, t)
    : policyLabel(status.policy, t);
  const choose = async (value: PolicySelection | null) => {
    setBusy(true);
    setFailure('');
    try { await onSelect(value); setOpen(false); }
    catch (error) { setFailure(code(error)); setOpen(true); }
    finally { setBusy(false); }
  };
  const choices = [
    { value: 'ask', label: t('逐次审批', 'Ask each time'), mode: 'ask' as const },
    { value: 'auto', label: t('按规则审批', 'Rule-based approval'), mode: 'auto' as const },
    { value: 'none', label: t('不受审批', 'No approval'), mode: 'none' as const },
    { value: 'default', label: t('使用默认', 'Use default'), mode: null },
  ];
  return <>
  <DropdownMenu.Root open={open} onOpenChange={setOpen}>
    <DropdownMenu.Trigger asChild><button type="button" className="composer-choice" disabled={disabled || busy} title={status === null ? t('新会话审批方式', 'Approval mode for the new conversation') : t('当前会话审批方式', 'Approval mode for this conversation')}><Icon name="check" size={14} /><span>{title}</span><Icon name="fold" size={12} /></button></DropdownMenu.Trigger>
    <DropdownMenu.Portal><DropdownMenu.Content className="menu policy-picker" side="top" align="start" sideOffset={8} onEscapeKeyDown={keepEscape}>
      <DropdownMenu.Label className="model-group-name">{status === null ? t('新会话审批方式', 'New conversation approval mode') : status.policySource === 'session' ? t('审批方式 · 本会话覆盖', 'Approval mode · session override') : t('审批方式', 'Approval mode')}</DropdownMenu.Label>
      {choices.map(choice => <DropdownMenu.Item key={choice.value} disabled={busy || active === choice.value} onSelect={event => { event.preventDefault(); if (choice.mode === 'none') { setOpen(false); setConfirmNone(true); } else void choose(choice.mode); }}><span>{choice.label}</span>{active === choice.value && <Icon name="check" size={14} />}</DropdownMenu.Item>)}
      {status !== null && status.policyDefault !== undefined && <p className="policy-picker-note">{t(`项目默认：${policyLabel(status.policyDefault, t)}；选「使用默认」回到这一项。`, `Project default: ${policyLabel(status.policyDefault, t)}; pick "Use default" to return to it.`)}</p>}
      {busy && <p className="policy-picker-note" role="status">{t('正在更新审批方式…', 'Updating approval mode…')}</p>}
      {failure && <div className="workspace-picker-error" role="alert"><span>{t('审批方式未更新。', 'Approval mode was not updated.')}</span><code>{failure}</code></div>}
    </DropdownMenu.Content></DropdownMenu.Portal>
  </DropdownMenu.Root>
  {confirmNone && <Modal title={t('切换为不受审批？', 'Use no-approval mode?')} className="confirm" onClose={() => setConfirmNone(false)}><h2 className="confirm-lead">{t('普通工具调用将按权限直接执行，不再逐项等待批准。', 'Ordinary tool calls will follow their permission boundaries without per-action approval.')}</h2><p className="confirm-note">{t('工作区边界、拒绝规则、系统硬拒绝及需要独立信任的操作仍受限制。', 'Workspace boundaries, deny rules, system hard denials, and operations requiring separate trust remain restricted.')}</p><div className="confirm-actions"><button type="button" onClick={() => setConfirmNone(false)}>{t('取消', 'Cancel')}</button><button type="button" className="primary-button" onClick={() => { setConfirmNone(false); void choose('none'); }}>{t('确认启用', 'Enable')}</button></div></Modal>}
  </>;
}

function policyLabel(mode: string, t: (chinese: string, english: string) => string): string {
  if (mode === 'ask') return t('逐次审批', 'Ask each time');
  if (mode === 'auto') return t('按规则审批', 'Rule-based approval');
  if (mode === 'none') return t('不受审批', 'No approval');
  if (mode === 'never') return t('旧版 never（需要明确迁移）', 'Legacy never (explicit migration required)');
  return mode;
}
