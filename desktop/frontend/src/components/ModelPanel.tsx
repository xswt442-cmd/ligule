import { useCallback, useEffect, useRef, useState } from 'react';
import { code, type Client } from '../protocol';
import { useText } from '../locale';
import { legacyService, type ModelCatalog, type ModelService } from '../model-catalog';
import { Icon } from './Icon';
import { Modal } from './ui';
import { HoldSheet } from './HoldSheet';

type Editor = { service: ModelService; models: string; key: string; original: string };
type Credential = { source: 'environment' | 'keyring' | 'missing'; configured: boolean };

export function ModelPanel({ client, projectRoot, onEdit }: {
  client: Client;
  sessionId: string | null;
  projectRoot: string;
  onEdit?: (reason: string) => void;
}) {
  const t = useText();
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [layer, setLayer] = useState('user');
  const [credential, setCredential] = useState<Credential | null>(null);
  const [credentialError, setCredentialError] = useState('');
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [failure, setFailure] = useState('');
  const [note, setNote] = useState('');
  const [confirm, setConfirm] = useState<{ type: 'service' | 'key'; service: ModelService } | null>(null);
  const request = useRef(0);
  const project = projectRoot === '' ? {} : { projectRoot };
  const changed = editor !== null && (editor.key !== '' || JSON.stringify({ ...editor.service, models: editor.models }) !== editor.original);
  useEffect(() => {
    onEdit?.(busy ? t('模型服务正在保存', 'Model service is being saved') : changed ? t('模型服务有未保存的修改', 'Model service has unsaved changes') : '');
    return () => onEdit?.('');
  }, [busy, changed, onEdit, t]);

  const load = useCallback(async () => {
    const own = ++request.current;
    const shown = await client.call('config.get', projectRoot === '' ? {} : { projectRoot }, 15_000) as ModelCatalog;
    if (own === request.current) setCatalog(shown);
    return shown;
  }, [client, projectRoot]);
  useEffect(() => { void load().catch(error => setFailure(code(error))); return () => { request.current += 1; }; }, [load]);

  const reference = editor?.service.apiKeyEnv ?? '';
  const validReference = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(reference);
  useEffect(() => {
    let active = true;
    setCredential(null);
    setCredentialError('');
    if (!validReference) return;
    void client.call('credentials.status', { reference }, 15_000).then(
      result => { if (active) setCredential(result as Credential); },
      error => { if (active) setCredentialError(code(error)); },
    );
    return () => { active = false; };
  }, [client, reference, validReference]);

  const begin = (service?: ModelService) => {
    const id = `service_${crypto.randomUUID().slice(0, 8)}`;
    const value: ModelService = service === undefined
      ? { id, name: '', api: 'chat-completions', baseURL: '', apiKeyEnv: `LIGULE_${id.toUpperCase()}_KEY`, models: [] }
      : { ...service, id: service.id === 'legacy' ? id : service.id };
    const models = value.models.join('\n');
    setEditor({ service: value, models, key: '', original: JSON.stringify({ ...value, models }) });
    const source = catalog?.sources['model.services'];
    setLayer(source === 'local' ? 'projectLocal' : 'user');
    setFailure('');
    setNote('');
  };
  const patch = (part: Partial<ModelService>) => setEditor(current => current === null ? null : { ...current, service: { ...current.service, ...part } });
  const write = async (field: string, value: unknown, snapshot: ModelCatalog) => {
    const version = snapshot.layers.find(item => item.layer === layer)?.version;
    if (version === undefined) throw Object.assign(new Error('config_write_unsupported'), { code: 'config_write_unsupported' });
    return await client.call('config.set', { ...project, field, value, layer, version }, 30_000) as { shadowed?: boolean; failure?: { code: string }; applies?: { when: string }[] };
  };
  const savedNote = (result: { shadowed?: boolean; failure?: { code: string }; applies?: { when: string }[] }) => result.shadowed
    ? t('已保存。更高优先级的配置仍在生效。', 'Saved. A higher-priority configuration remains in effect.')
    : result.failure ? t('配置已保存，部分会话仍使用当前连接。', 'Configuration saved. Some sessions keep their current connection.')
      : result.applies?.some(item => item.when === 'round') ? t('已保存，运行中的会话在本轮结束后应用。', 'Saved. Running sessions apply the change after this turn.')
        : t('已保存。', 'Saved.');
  const save = async () => {
    if (catalog === null || editor === null || busy) return;
    setBusy(true); setFailure(''); setNote('');
    let serviceSaved = false;
    let stage: 'config' | 'refresh' | 'credential' = 'config';
    try {
      const service = { ...editor.service, models: [...new Set(editor.models.split('\n').map(model => model.trim()).filter(Boolean))] };
      const existing = catalog.services ?? [];
      const next = existing.some(item => item.id === service.id) ? existing.map(item => item.id === service.id ? service : item) : [...existing, service];
      const result = await write('model.services', next, catalog);
      serviceSaved = true;
      stage = 'refresh';
      await load();
      stage = 'credential';
      if (editor.key !== '') await client.call('credentials.set', { reference: service.apiKeyEnv, value: editor.key }, 30_000);
      setNote(savedNote(result));
      setEditor(null);
    } catch (error) {
      setFailure(code(error));
      if (serviceSaved) setNote(stage === 'credential'
        ? t('服务已保存，密钥未保存。请重试或使用环境变量。', 'Service saved; API key was not saved. Retry or use an environment variable.')
        : t('服务已保存，但无法刷新配置。请重新读取。', 'Service saved, but configuration could not be refreshed. Reload to continue.'));
    } finally { setBusy(false); }
  };
  const selectDefault = async (service: ModelService, model = service.models[0]) => {
    if (catalog === null || busy) return;
    setBusy(true); setFailure(''); setNote('');
    try {
      const result = await write('model.selection', { provider: service.id, model }, catalog);
      await load();
      setNote(savedNote(result));
    } catch (error) { setFailure(code(error)); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (confirm === null || catalog === null || busy) return;
    setBusy(true); setFailure(''); setNote('');
    try {
      if (confirm.type === 'key') {
        await client.call('credentials.delete', { reference: confirm.service.apiKeyEnv }, 15_000);
        setCredential({ source: 'missing', configured: false });
        setNote(t('密钥已删除。', 'API key deleted.'));
      } else {
        const result = await write('model.services', (catalog.services ?? []).filter(item => item.id !== confirm.service.id), catalog);
        setNote(savedNote(result));
        await load();
      }
      setConfirm(null);
    } catch (error) { setFailure(code(error)); }
    finally { setBusy(false); }
  };
  const services = catalog?.services ?? [];
  const legacy = catalog === null ? null : legacyService(catalog);
  const defaultChoices = [...(legacy === null ? [] : [legacy]), ...services].flatMap(service => service.models.map(model => ({ service, model, value: JSON.stringify([service.id, model]) })));
  const defaultSelection = catalog?.selection ?? (legacy !== null ? { provider: 'legacy', model: legacy.models[0] } : services.length === 0 ? null : { provider: services[0].id, model: services[0].models[0] });

  return <div className="model-settings">
    <div className="settings-intro"><h2>{t('模型服务', 'Model services')}</h2><p>{t('保存服务与模型，在输入区切换。密钥使用系统凭据库，环境变量优先。', 'Save services and models, then switch in the composer. API keys use the system credential store; environment variables take priority.')}</p></div>
    {note && <p className="inline-notice" role="status">{note}</p>}
    {failure && <div className="inline-notice" role="alert"><span>{failure === 'config_version_stale' ? t('配置已被修改，请刷新后重试。', 'Configuration changed. Refresh and retry.') : t('操作未完成，请检查填写内容或凭据设施。', 'Could not complete the action. Check the fields or credential store.')}</span><details><summary>{t('详情', 'Details')}</summary><code>{failure}</code></details><button type="button" disabled={busy} onClick={() => void load().catch(error => setFailure(code(error)))}>{t('刷新', 'Refresh')}</button></div>}
    {editor === null ? <>
      {defaultChoices.length > 0 && <label className="service-default-select">{t('默认模型', 'Default model')}<select disabled={busy} value={JSON.stringify([defaultSelection?.provider, defaultSelection?.model])} onChange={event => { const choice = defaultChoices.find(item => item.value === event.target.value); if (choice !== undefined) void selectDefault(choice.service, choice.model); }}>{defaultChoices.map(choice => <option key={choice.value} value={choice.value}>{choice.service.id === 'legacy' ? t('现有配置', 'Existing configuration') : choice.service.name} / {choice.model}</option>)}</select></label>}
      {legacy !== null && <div className="service-row"><Icon name="spark" /><div><strong>{t('现有模型配置', 'Existing model configuration')}</strong><span>{legacy.models[0]}</span></div><button type="button" onClick={() => begin(legacy)}>{t('另存为服务', 'Save as a service')}</button></div>}
      {services.map(service => <div key={service.id} className="service-row"><Icon name="spark" /><div><strong>{service.name}{defaultSelection?.provider === service.id && <span className="service-default">{t('默认', 'Default')}</span>}</strong><span>{service.models.join(', ')}</span></div><button type="button" disabled={busy} onClick={() => begin(service)}>{t('编辑', 'Edit')}</button><button type="button" className="icon-button" aria-label={t(`删除服务 ${service.name}`, `Delete service ${service.name}`)} onClick={() => setConfirm({ type: 'service', service })}><Icon name="close" size={14} /></button></div>)}
      {catalog !== null && services.length === 0 && legacy === null && <p className="model-empty">{t('添加第一个服务，即可开始对话。', 'Add your first service to start a conversation.')}</p>}
      <button type="button" className="add-service" disabled={catalog === null} onClick={() => begin()}><Icon name="plus" size={15} />{t('添加服务', 'Add service')}</button>
    </> : <form className="service-form" onSubmit={(event) => { event.preventDefault(); void save(); }}><fieldset className="service-fields" disabled={busy}>
      <label>{t('服务名称', 'Service name')}<input value={editor.service.name} maxLength={100} onChange={event => patch({ name: event.target.value })} placeholder={t('例如 DeepSeek', 'For example, DeepSeek')} required /></label>
      <label>{t('接口类型', 'API type')}<select value={editor.service.api} onChange={event => patch({ api: event.target.value as ModelService['api'] })}><option value="chat-completions">Chat Completions</option><option value="messages">Messages</option></select></label>
      <label>{t('服务地址', 'Base URL')}<input type="url" value={editor.service.baseURL} onChange={event => patch({ baseURL: event.target.value })} placeholder="https://api.example.com/v1" required /></label>
      <label>{t('模型', 'Models')}<textarea value={editor.models} onChange={event => setEditor({ ...editor, models: event.target.value })} placeholder={t('每行一个模型标识', 'One model ID per line')} rows={3} required /></label>
      <label>{t('API Key', 'API key')}<input type="password" autoComplete="new-password" value={editor.key} disabled={credential?.source === 'environment'} onChange={event => setEditor({ ...editor, key: event.target.value })} placeholder={credential?.configured ? t('已设置。输入新密钥可替换。', 'Configured. Enter a new key to replace it.') : t('输入密钥，或使用环境变量', 'Enter a key, or use an environment variable')} /></label>
      <p className="field-help">{credential?.source === 'environment' ? t('当前由环境变量提供。请在启动环境中修改或删除。', 'Supplied by the environment. Change or remove it in the launching environment.') : credentialError ? t('系统凭据库暂不可用。可以设置下方环境变量。', 'System credential store is unavailable. You can use the environment variable below.') : t('保存后不显示密钥原文。留空会保留已存密钥。', 'Saved keys are not shown. Leave blank to keep the stored key.')}</p>
      {credential?.source === 'keyring' && <button type="button" className="text-button" onClick={() => setConfirm({ type: 'key', service: editor.service })}>{t('删除已存密钥', 'Delete stored key')}</button>}
      <details><summary>{t('凭据引用与保存位置', 'Credential reference and save location')}</summary><div className="service-advanced"><label>{t('环境变量名', 'Environment variable')}<input value={editor.service.apiKeyEnv} onChange={event => patch({ apiKeyEnv: event.target.value })} pattern="[A-Za-z_][A-Za-z0-9_]*" maxLength={128} required /></label><label>{t('保存到', 'Save to')}<select value={layer} onChange={event => setLayer(event.target.value)}><option value="user">{t('用户配置', 'User configuration')}</option><option value="projectLocal">{t('项目本地配置', 'Project local configuration')}</option></select></label></div></details>
      <div className="form-actions"><button type="button" disabled={busy} onClick={() => { if (changed) setLeaving(true); else setEditor(null); }}>{t('返回列表', 'Back to services')}</button><button type="submit" className="primary-button" disabled={busy || !validReference}>{busy ? t('保存中…', 'Saving…') : t('保存服务', 'Save service')}</button></div>
    </fieldset></form>}
    {confirm !== null && <Modal title={confirm.type === 'key' ? t('删除密钥？', 'Delete API key?') : t('删除服务？', 'Delete service?')} className="confirm" onClose={() => { if (!busy) setConfirm(null); }}><h2 className="confirm-lead">{confirm.type === 'key' ? t('删除已存密钥？', 'Delete the stored API key?') : t(`删除服务“${confirm.service.name}”？`, `Delete “${confirm.service.name}”?`)}</h2><p className="confirm-note">{confirm.type === 'key' ? t('使用相同凭据引用的服务都将受到影响。', 'All services using this credential reference will be affected.') : t('会话记录和已存密钥将保留。在用会话保留当前连接，直到重新选择。', 'Conversation history and stored keys are kept. Sessions using this service retain their connection until another selection is made.')}</p><div className="confirm-actions"><button type="button" disabled={busy} onClick={() => setConfirm(null)}>{t('取消', 'Cancel')}</button><button type="button" disabled={busy} onClick={() => void remove()}>{t('删除', 'Delete')}</button></div></Modal>}
    {leaving && <HoldSheet lead={t('放弃未保存的修改？', 'Discard unsaved changes?')} reasons={[t('模型服务有未保存的修改', 'Model service has unsaved changes')]} onStay={() => setLeaving(false)} onLeave={() => { setLeaving(false); setEditor(null); }} />}
  </div>;
}
