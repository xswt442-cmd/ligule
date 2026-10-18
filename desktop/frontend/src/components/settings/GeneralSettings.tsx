import { useEffect, useState } from 'react';
import { Group, Row } from '../ui';
import { code, type Client } from '../../protocol';
import type { WorkspaceRoster } from '../../rail';
import type { Settings } from '../../settings';
import { useText } from '../../locale';

export function GeneralSettings({ client, language, patch }: {
  client: Client;
  language: Settings['language'];
  patch: (part: Partial<Settings>) => void;
}) {
  const t = useText();
  const [roster, setRoster] = useState<WorkspaceRoster | null>(null);
  const [failure, setFailure] = useState<{ operation: 'read' | 'save'; code: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    void client.call('workspaces.list', {}, 15_000)
      .then((value) => { if (active) setRoster(value as WorkspaceRoster); })
      .catch((error: unknown) => { if (active) setFailure({ operation: 'read', code: code(error) }); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [client, reload]);

  const changeDefault = async (directory: string) => {
    setSaving(true);
    setFailure(null);
    try {
      setRoster(await client.call('workspace.default.set', { directory }, 15_000) as WorkspaceRoster);
    } catch (error) {
      setFailure({ operation: 'save', code: code(error) });
    } finally {
      setSaving(false);
    }
  };
  const defaultDirectory = roster?.workspaces.find((workspace) => workspace.identity === roster.default)?.directory ?? '';

  return <>
    <Group title={t('语言', 'Language')}>
      <Row label={t('界面语言', 'Interface language')}>
        <select value={language} onChange={(event) => patch({ language: event.target.value as Settings['language'] })}>
          <option value="auto">{t('跟随系统', 'Follow system')}</option>
          <option value="zh">简体中文</option>
          <option value="en">English</option>
        </select>
      </Row>
    </Group>
    <Group title={t('工作区', 'Workspace')}>
      <Row label={t('默认工作区', 'Default workspace')} note={t('新建会话时使用。只能选择侧栏中已登记的工作区。', 'Used for new sessions. Choose a workspace already listed in the sidebar.')}>
        <select
          value={defaultDirectory}
          disabled={loading || saving || roster === null}
          onChange={(event) => void changeDefault(event.target.value)}
        >
          <option value="">{t('不设置默认工作区', 'No default workspace')}</option>
          {roster?.workspaces.map((workspace) => <option key={workspace.identity} value={workspace.directory}>{workspace.name || workspace.directory}</option>)}
        </select>
      </Row>
      {loading && <p className="stub">{t('正在读取工作区…', 'Loading workspaces…')}</p>}
      {!loading && roster?.workspaces.length === 0 && <p className="stub">{t('侧栏还没有登记工作区。', 'No workspaces are listed in the sidebar yet.')}</p>}
      {failure !== null && <div className="session-note" data-tone="bad">
        <p>{failure.operation === 'read'
          ? t('无法读取工作区列表。', 'Could not load the workspace list.')
          : t('默认工作区没有保存。', 'The default workspace was not saved.')}</p>
        <details><summary>{t('错误代码', 'Error code')}</summary><code>{failure.code}</code></details>
        {failure.operation === 'read' && <button type="button" onClick={() => { setLoading(true); setFailure(null); setReload((value) => value + 1); }}>{t('重新读取', 'Reload')}</button>}
      </div>}
    </Group>
  </>;
}
