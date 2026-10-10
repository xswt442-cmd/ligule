import { useState } from 'react';
import { DropdownMenu } from 'radix-ui';
import { useText } from '../locale';
import { code, type Client } from '../protocol';
import { Icon } from './Icon';
import { Modal, keepEscape } from './ui';

export function SessionActions({ client, sessionId, name, archived, onLabel, onBranch, onExport, onTasks, onRefresh, onCompact }: {
  client: Client;
  sessionId: string;
  name: string;
  archived: boolean;
  onLabel: (label: { name: string; archived: boolean }) => void;
  onBranch: () => void;
  onExport: () => void;
  onTasks: () => void;
  onRefresh: () => void;
  onCompact: () => void;
}) {
  const t = useText();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState('');
  const label = async (part: { name?: string; archived?: boolean }) => {
    setSaving(true);
    setFailure('');
    try {
      const result = await client.call('session.label', { sessionId, ...part }, 15_000) as { name: string; archived: boolean };
      onLabel(result);
      setEditing(false);
    } catch (error) {
      setFailure(code(error));
    } finally { setSaving(false); }
  };
  return <>
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild><button type="button" className="icon-button" aria-label={t('会话菜单', 'Conversation menu')}><Icon name="more" size={19} /></button></DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu" align="end" sideOffset={8} onEscapeKeyDown={keepEscape}>
          <DropdownMenu.Item onSelect={() => { setDraft(name); setFailure(''); setEditing(true); }}>{t('重命名', 'Rename')}</DropdownMenu.Item>
          <DropdownMenu.Item disabled={saving} onSelect={() => void label({ archived: !archived })}>{archived ? t('取消归档', 'Restore conversation') : t('归档会话', 'Archive conversation')}</DropdownMenu.Item>
          <DropdownMenu.Item onSelect={onBranch}>{t('分支会话', 'Branch conversation')}</DropdownMenu.Item>
          <DropdownMenu.Item onSelect={onExport}>{t('导出 Markdown', 'Export Markdown')}</DropdownMenu.Item>
          <DropdownMenu.Separator className="menu-separator" />
          <DropdownMenu.Item onSelect={onTasks}>{t('查看子任务', 'View subtasks')}</DropdownMenu.Item>
          <DropdownMenu.Item onSelect={onRefresh}>{t('刷新记录', 'Refresh conversation')}</DropdownMenu.Item>
          <DropdownMenu.Item onSelect={onCompact}>{t('压缩上下文', 'Compact context')}</DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
    {editing && <Modal title={t('重命名会话', 'Rename conversation')} className="confirm" onClose={() => { if (!saving) setEditing(false); }}>
      <h2 className="confirm-lead">{t('重命名会话', 'Rename conversation')}</h2>
      <input aria-label={t('会话名称', 'Conversation name')} value={draft} maxLength={120} disabled={saving} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.keyCode !== 229 && draft.trim() !== '') void label({ name: draft.trim() });
      }} />
      {failure !== '' && <p role="alert">{t('无法保存名称。', 'Could not save the name.')} <code>{failure}</code></p>}
      <div className="confirm-actions">
        <button type="button" disabled={saving} onClick={() => setEditing(false)}>{t('取消', 'Cancel')}</button>
        <button type="button" disabled={saving || draft.trim() === ''} onClick={() => void label({ name: draft.trim() })}>{saving ? t('保存中…', 'Saving…') : t('保存', 'Save')}</button>
      </div>
    </Modal>}
    {!editing && failure !== '' && <span role="alert" className="action-error">{t('操作失败', 'Action failed')} <code>{failure}</code></span>}
  </>;
}
