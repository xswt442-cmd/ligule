import type { ReactNode } from 'react';
import { DropdownMenu } from 'radix-ui';
import type { RailGroup } from '../../rail';
import { useText } from '../../locale';
import { Icon } from '../Icon';
import { keepEscape } from '../ui';
import type { SessionSummary } from './types';

export function WorkspaceGroup({ group, sessions, folded, onToggle, onCreate, onSetDefault, onHide, onRemove, children }: {
  group: RailGroup;
  sessions: SessionSummary[];
  folded: boolean;
  onToggle: (identity: string) => void;
  onCreate: (root: string) => void;
  onSetDefault: (root: string, clearing: boolean) => void;
  onHide: (root: string) => void;
  onRemove: (root: string, isDefault: boolean) => void;
  children: ReactNode;
}) {
  const t = useText();
  return <section className="rail-group">
    <h3 className="group-label">
      <button
        type="button"
        className="group-fold"
        aria-expanded={!folded}
        title={group.root}
        onClick={() => onToggle(group.identity)}
      >
        <Icon name={folded ? 'unfold' : 'fold'} size={13} />
        <Icon name={folded ? 'folder' : 'folderOpen'} size={14} />
        <span className="group-root">{group.label}{group.isDefault ? ` · ${t('默认', 'Default')}` : ''}</span>
      </button>
      <span className="group-count">{sessions.length}</span>
      <button type="button" className="group-new" title={t(`在 ${group.label} 中新建会话`, `New conversation in ${group.label}`)} aria-label={t(`在 ${group.label} 中新建会话`, `New conversation in ${group.label}`)} onClick={() => onCreate(group.root)}>
        <Icon name="plus" size={15} />
      </button>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button type="button" className="icon-button group-menu" aria-label={t(`${group.label}工作区菜单`, `${group.label} workspace menu`)} title={t('工作区菜单', 'Workspace menu')}><Icon name="more" size={17} /></button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="menu" align="end" sideOffset={4} onEscapeKeyDown={keepEscape}>
            <DropdownMenu.Item onSelect={() => onSetDefault(group.root, group.isDefault)}>
              {group.isDefault ? t('取消默认工作区', 'Clear default workspace') : t('设为默认工作区', 'Set as default workspace')}
            </DropdownMenu.Item>
            <DropdownMenu.Separator className="menu-separator" />
            <DropdownMenu.Item onSelect={() => onHide(group.root)}>{t('从侧栏移除', 'Remove from sidebar')}</DropdownMenu.Item>
            <DropdownMenu.Separator className="menu-separator" />
            <DropdownMenu.Item onSelect={() => onRemove(group.root, group.isDefault)}>{t('删除工作区登记…', 'Remove workspace registration…')}</DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </h3>
    {!folded && sessions.length === 0 && group.sessions.length > 0 && <div className="rail-empty">{t('归档会话已隐藏。', 'Archived conversations are hidden.')}</div>}
    {!folded && children}
  </section>;
}
