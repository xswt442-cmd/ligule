import { useCallback, useEffect, useState } from 'react';
import { code, type Client } from '../protocol';
import { useText } from '../locale';
import { Icon } from './Icon';
import { Modal, Row } from './ui';

type ServerEntry = { command?: string; args?: string[]; env?: Record<string, string>; cwd?: string };
type ConfigShown = {
  layers?: { layer: string; version: string; exists: boolean; mcpServers?: Record<string, ServerEntry> }[];
};
type Draft = { name: string; command: string; args: string; env: string; cwd: string };
type Note = { text: string; bad: boolean; code?: string };

// 服务器配置写入用户配置层的 mcp.servers；每台服务器一张 TOML 表。
// 配置身份（identityDigest）随之变化，变更后需要在信任面板重新信任。
export function McpServersPanel({ client, projectRoot }: { client: Client; projectRoot: string }) {
  const t = useText();
  const [servers, setServers] = useState<Record<string, ServerEntry> | null>(null);
  const [version, setVersion] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const target = projectRoot === '' ? {} : { projectRoot };

  const load = useCallback(async (keepNote = false) => {
    try {
      const answer = await client.call('config.get', target, 15_000) as ConfigShown;
      // 服务器表来自使用者默认层的那一次读取，与写入用的版本同源。
      setServers(answer.layers?.find((item) => item.layer === 'user')?.mcpServers ?? {});
      setVersion(answer.layers?.find((item) => item.layer === 'user')?.version ?? '');
      if (!keepNote) setNote(null);
    } catch (error) {
      setNote({ text: t('无法读取 MCP Server 配置。', 'Could not read MCP server configuration.'), code: code(error), bad: true });
    }
  }, [client, projectRoot, t]);

  useEffect(() => { void load(); }, [load]);

  const edit = (name: string) => {
    const entry = servers?.[name] ?? {};
    setDraft({
      name,
      command: entry.command ?? '',
      args: (entry.args ?? []).join('\n'),
      env: Object.entries(entry.env ?? {}).map(([key, value]) => `${key}=${value}`).join('\n'),
      cwd: entry.cwd ?? '',
    });
  };

  const save = async () => {
    if (draft === null) return;
    setBusy(true);
    setNote(null);
    try {
      const args = draft.args.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== '');
      const env: Record<string, string> = {};
      for (const line of draft.env.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== '')) {
        const parsed = /^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/u.exec(line);
        if (parsed === null) throw Object.assign(new Error('env line'), { code: 'mcp_env_line_invalid' });
        env[parsed[1]] = parsed[2];
      }
      await client.call('config.set', {
        ...target,
        field: 'mcp.servers',
        layer: 'user',
        version,
        op: 'set',
        serverName: draft.name.trim(),
        serverCommand: draft.command.trim(),
        ...(args.length === 0 ? {} : { serverArgs: args }),
        ...(Object.keys(env).length === 0 ? {} : { serverEnv: env }),
        ...(draft.cwd.trim() === '' ? {} : { serverCwd: draft.cwd.trim() }),
      }, 30_000);
      await load(true);
      setDraft(null);
      setNote({
        text: t(`已保存 ${draft.name.trim()}。配置身份变化后需要在下方信任面板重新信任。`, `${draft.name.trim()} was saved. A changed configuration needs trust again in the panel below.`),
        bad: false,
      });
    } catch (error) {
      setNote({ text: t('MCP Server 配置没有保存。', 'MCP server configuration was not saved.'), code: code(error), bad: true });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (name: string) => {
    setBusy(true);
    setNote(null);
    try {
      await client.call('config.set', { ...target, field: 'mcp.servers', layer: 'user', version, op: 'remove', serverName: name }, 30_000);
      await load(true);
      setNote({ text: t(`已移除 ${name}。`, `${name} was removed.`), bad: false });
    } catch (error) {
      setNote({ text: t('MCP Server 配置没有保存。', 'MCP server configuration was not saved.'), code: code(error), bad: true });
      await load(true);
    } finally {
      setBusy(false);
      setRemoving(null);
    }
  };

  const entries = Object.entries(servers ?? {}).sort(([left], [right]) => left.localeCompare(right));

  return <div className="mcp-servers-panel">
    <div className="agent-control-toolbar">
      <span className="agent-control-status">{t(`${entries.length} 个已配置 Server（使用者默认层）`, `${entries.length} configured servers (user defaults layer)`)}</span>
      <button type="button" className="rail-refresh" disabled={busy || servers === null} onClick={() => void load()}><Icon name="refresh" size={13} />{t('重新读取', 'Reload')}</button>
      <button type="button" disabled={busy || servers === null} onClick={() => setDraft({ name: '', command: '', args: '', env: '', cwd: '' })}>{t('添加 Server', 'Add server')}</button>
    </div>
    {note !== null && <div className="session-note" data-tone={note.bad ? 'bad' : undefined}>
      <span>{note.text}</span>{note.code !== undefined && <code>{note.code}</code>}
    </div>}
    <p className="agent-control-notice">{t('这里编辑使用者默认层的 [mcp.servers] 表：command 是不带参数的可执行文件，参数逐行写入 args，环境变量只接受 ${NAME} 引用。变更写入后按新配置身份生效，信任需要重新确认。', 'This edits the [mcp.servers] table of the user defaults layer: command is the executable without arguments, args takes one argument per line, and environment entries only accept ${NAME} references. Changes take effect under a new configuration identity and trust must be confirmed again.')}</p>
    {servers === null ? <p className="stub">{t('正在读取 Server…', 'Loading servers…')}</p>
      : entries.length === 0 ? <p className="stub">{t('使用者默认层还没有配置 MCP Server。', 'No MCP servers are configured in the user defaults layer.')}</p>
        : entries.map(([name, entry]) => <section className="mcp-trust-server" key={name}>
          <div className="mcp-trust-heading">
            <strong>{name}</strong>
            <code className="catalog-tag">{entry.command ?? ''}</code>
          </div>
          <dl className="mcp-trust-details">
            <dt>{t('参数', 'Arguments')}</dt><dd>{(entry.args ?? []).length === 0 ? t('无', 'None') : <code>{(entry.args ?? []).join('\n')}</code>}</dd>
            <dt>{t('工作目录', 'Working directory')}</dt><dd>{entry.cwd === undefined ? t('默认', 'Default') : <code>{entry.cwd}</code>}</dd>
            <dt>{t('环境变量', 'Environment')}</dt><dd>{Object.keys(entry.env ?? {}).length === 0 ? t('无', 'None') : <code>{Object.entries(entry.env ?? {}).map(([key, value]) => `${key}=${value}`).join('\n')}</code>}</dd>
          </dl>
          <div className="inline-field mcp-trust-actions">
            <button type="button" className="mini chip" disabled={busy} onClick={() => edit(name)}>{t('编辑', 'Edit')}</button>
            <button type="button" className="mini chip danger" disabled={busy} onClick={() => setRemoving(name)}>{t('移除', 'Remove')}</button>
          </div>
        </section>)}

    {draft !== null && <Modal title={t('编辑 MCP Server', 'Edit MCP server')} className="confirm" onClose={() => setDraft(null)}>
      <Row label={t('名称', 'Name')}>
        <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="playwright" />
      </Row>
      <Row label={t('程序', 'Executable')}>
        <input value={draft.command} onChange={(event) => setDraft({ ...draft, command: event.target.value })} placeholder="npx" />
      </Row>
      <Row label={t('参数（每行一个）', 'Arguments (one per line)')}>
        <textarea rows={3} value={draft.args} onChange={(event) => setDraft({ ...draft, args: event.target.value })} placeholder={'-y\n@playwright/mcp'} />
      </Row>
      <Row label={t('环境变量（每行 KEY=${NAME}）', 'Environment (one KEY=${NAME} per line)')}>
        <textarea rows={2} value={draft.env} onChange={(event) => setDraft({ ...draft, env: event.target.value })} placeholder="API_TOKEN=${MY_API_TOKEN}" />
      </Row>
      <Row label={t('工作目录（可选）', 'Working directory (optional)')}>
        <input value={draft.cwd} onChange={(event) => setDraft({ ...draft, cwd: event.target.value })} />
      </Row>
      <div className="confirm-actions">
        <button type="button" onClick={() => setDraft(null)}>{t('取消', 'Cancel')}</button>
        <button type="button" className="primary-button" disabled={busy || draft.name.trim() === '' || draft.command.trim() === ''} onClick={() => void save()}>{t('保存到使用者默认层', 'Save to user defaults')}</button>
      </div>
    </Modal>}

    {removing !== null && <Modal title={t('移除 MCP Server', 'Remove MCP server')} className="confirm" onClose={() => setRemoving(null)}>
      <h2 className="confirm-lead">{t(`移除 ${removing}？`, `Remove ${removing}?`)}</h2>
      <p className="confirm-note">{t('只从使用者默认配置中删除这台服务器；信任记录与其他配置层不受影响。', 'This removes the server from the user defaults layer only; trust records and other layers are untouched.')}</p>
      <div className="confirm-actions">
        <button type="button" onClick={() => setRemoving(null)}>{t('取消', 'Cancel')}</button>
        <button type="button" className="primary-button" disabled={busy} onClick={() => void remove(removing)}>{t('确认移除', 'Remove server')}</button>
      </div>
    </Modal>}
  </div>;
}
