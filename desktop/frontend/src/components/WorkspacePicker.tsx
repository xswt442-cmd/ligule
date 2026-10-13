import { useCallback, useEffect, useState } from 'react';
import { Popover } from 'radix-ui';
import { useText } from '../locale';
import { code, type Client } from '../protocol';
import type { WorkspaceRoster } from '../rail';
import { Icon } from './Icon';
import { keepEscape } from './ui';

export function WorkspacePicker({ client, directory, disabled, revision, onSelect }: {
  client: Client;
  directory: string;
  disabled: boolean;
  revision: number;
  onSelect: (directory: string) => Promise<void>;
}) {
  const t = useText();
  const [open, setOpen] = useState(false);
  const [roster, setRoster] = useState<WorkspaceRoster | null>(null);
  const [path, setPath] = useState('');
  const [loading, setLoading] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [failure, setFailure] = useState('');
  const load = useCallback(async () => {
    setLoading(true);
    setFailure('');
    try { setRoster(await client.call('workspaces.list', {}, 15_000) as WorkspaceRoster); }
    catch (error) { setFailure(code(error)); }
    finally { setLoading(false); }
  }, [client]);
  useEffect(() => { void load(); }, [load, open, revision]);

  const choose = async (root: string) => {
    if (choosing || root.trim() === '') return;
    setChoosing(true);
    setFailure('');
    try {
      // 由 Host 验证目录；正式新会话仍在首次发送时创建，权限由 Host 决定。
      await client.call('sessions.list', { projectRoot: root }, 15_000);
      await onSelect(root);
      setPath('');
      setOpen(false);
    } catch (error) { setFailure(code(error)); }
    finally { setChoosing(false); }
  };
  const name = roster?.workspaces.find(item => item.directory === directory)?.name
    || directory.split(/[\\/]+/).filter(Boolean).at(-1) || t('选择工作区', 'Choose workspace');
  return <div className="new-workspace">
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild><button type="button" className="workspace-choice" disabled={disabled || choosing} title={directory} aria-label={t('选择新会话工作区', 'Choose workspace for new conversation')}><Icon name="folder" size={14} /><span>{name}</span><Icon name="fold" size={12} /></button></Popover.Trigger>
      <Popover.Portal><Popover.Content className="workspace-picker" side="top" align="start" sideOffset={8} onEscapeKeyDown={keepEscape} aria-label={t('新会话工作区', 'New conversation workspace')}>
        <strong>{t('选择工作区', 'Choose workspace')}</strong>
        {loading && <p role="status">{t('正在读取工作区…', 'Loading workspaces…')}</p>}
        {failure !== '' && <div className="workspace-picker-error" role="alert"><span>{failure === 'host_project_root_missing'
          ? t('目录不存在，请检查路径。', 'The directory does not exist. Check the path.')
          : t('无法打开工作区，请检查目录或重新读取。', 'Could not open the workspace. Check the directory or reload.')}</span><details><summary>{t('详情', 'Details')}</summary><code>{failure}</code></details><button type="button" disabled={loading || choosing} onClick={() => void load()}>{t('重新读取', 'Reload')}</button></div>}
        <div className="workspace-options" role="listbox" aria-label={t('已登记工作区', 'Registered workspaces')}>
          {roster?.workspaces.map(item => <button key={item.identity} type="button" role="option" aria-selected={item.directory === directory} disabled={choosing || loading} onClick={() => void choose(item.directory)} title={item.directory}><Icon name="folder" size={14} /><span><strong>{item.name}</strong><small>{item.directory}</small></span>{item.directory === directory && <Icon name="check" size={14} />}</button>)}
        </div>
        <form onSubmit={event => { event.preventDefault(); void choose(path.trim()); }}>
          <label htmlFor="new-workspace-path">{t('打开其他目录', 'Open another directory')}</label>
          <div className="inline-field"><input id="new-workspace-path" value={path} onChange={event => setPath(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault(); }} disabled={choosing} placeholder={t('输入目录路径', 'Enter a directory path')} /><button type="submit" disabled={choosing || path.trim() === ''}>{choosing ? t('打开中…', 'Opening…') : t('打开', 'Open')}</button></div>
        </form>
      </Popover.Content></Popover.Portal>
    </Popover.Root>
  </div>;
}
