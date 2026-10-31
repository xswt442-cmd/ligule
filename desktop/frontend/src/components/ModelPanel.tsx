import { useCallback, useEffect, useRef, useState } from 'react';
import { code, type Client } from '../protocol';
import { useText } from '../locale';
import { encodeModelRows, legacyService, mergeModelRows, modelName, modelRows, newModelRow, presetService, type ModelCatalog, type ModelRow, type ModelService, uniqueModelIds } from '../model-catalog';
import { Icon } from './Icon';
import { ModelSelectionDialog } from './ModelSelectionDialog';
import { Modal } from './ui';
import { HoldSheet } from './HoldSheet';

type Editor = { service: ModelService; rows: ModelRow[]; key: string; original: string };
const editorSignature = (service: ModelService, rows: ModelRow[]) => JSON.stringify({ service, rows: rows.map(({ id, name, contextTokens, outputTokens, imageInput }) => ({ id, name, contextTokens, outputTokens, imageInput })) });
type Credential = { source: 'environment' | 'keyring' | 'missing'; configured: boolean };
const PRESETS = {
  deepseek: { name: 'DeepSeek', api: 'chat-completions' as const, baseURL: 'https://api.deepseek.com/v1' },
  openai: { name: 'OpenAI', api: 'chat-completions' as const, baseURL: 'https://api.openai.com/v1' },
  anthropic: { name: 'Anthropic', api: 'messages' as const, baseURL: 'https://api.anthropic.com/v1' },
};

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
  const [pendingModels, setPendingModels] = useState<string[] | null>(null);
  const [confirm, setConfirm] = useState<{ type: 'service' | 'key'; service: ModelService } | null>(null);
  const [selectedPreset, setSelectedPreset] = useState('custom');
  const request = useRef(0);
  const project = projectRoot === '' ? {} : { projectRoot };
  const changed = editor !== null && (editor.key !== '' || editorSignature(editor.service, editor.rows) !== editor.original);
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
    setSelectedPreset('custom');
    const id = `service_${crypto.randomUUID().slice(0, 8)}`;
    const value: ModelService = service === undefined
      ? { id, name: '', api: 'chat-completions', baseURL: '', apiKeyEnv: `LIGULE_${id.toUpperCase()}_KEY`, models: [] }
      : { ...service, id: service.id === 'legacy' ? id : service.id };
    const rows = modelRows(value);
    setEditor({ service: value, rows, key: '', original: editorSignature(value, rows) });
    const source = catalog?.sources['model.services'];
    setLayer(source === 'local' ? 'projectLocal' : 'user');
    setFailure('');
    setNote('');
    setPendingModels(null);
  };
  const patch = (part: Partial<ModelService>) => setEditor(current => current === null ? null : { ...current, service: { ...current.service, ...part } });
  const patchRow = (key: string, part: Partial<ModelRow>) => setEditor(current => current === null ? null : { ...current, rows: current.rows.map(row => row.key === key ? { ...row, ...part } : row) });
  const applyPreset = (id: keyof typeof PRESETS | 'custom') => {
    setSelectedPreset(id);
    if (id === 'custom') return;
    const preset = PRESETS[id];
    const existing = editor !== null && (catalog?.services ?? []).some(service => service.id === editor.service.id);
    const service = presetService(preset, editor?.service ?? null, existing, `${id}_${crypto.randomUUID().slice(0, 8)}`);
    setEditor({ service, rows: [], key: editor?.key ?? '', original: existing ? editor.original : editorSignature(service, []) });
    setLayer(catalog?.sources['model.services'] === 'local' ? 'projectLocal' : 'user');
    setFailure('');
    setNote('');
  };
  const fetchModels = async () => {
    if (editor === null || busy) return;
    setBusy(true); setFailure(''); setNote('');
    try {
      // 获取模型仅使用本次输入的密钥；只有显式保存服务才允许修改凭据库。
      const answer = await client.call('models.discover', { ...project, api: editor.service.api, baseURL: editor.service.baseURL, reference: editor.service.apiKeyEnv, ...(editor.key === '' ? {} : { temporaryKey: editor.key }) }, 20_000) as { models: string[] };
      const models = uniqueModelIds(answer.models);
      const existing = new Set(editor.rows.map(row => row.id.trim()));
      const additions = models.filter(model => !existing.has(model));
      setNote(models.length === 0
        ? t('服务没有返回可用模型。现有模型已保留，可以手动添加。', 'The service returned no models. Existing entries are preserved; you can add models manually.')
        : additions.length === 0
          ? t('获取到的模型已全部在目录中。', 'All discovered models are already in the catalog.')
          : '');
      if (additions.length > 0) setPendingModels(models);
    } catch (error) { setFailure(code(error)); }
    finally { setBusy(false); }
  };
  const addDiscoveredModels = (selected: string[]) => {
    if (editor === null || selected.length === 0) return;
    try {
      const rows = mergeModelRows(editor.rows, selected);
      setEditor(current => current === null || current.service.id !== editor.service.id ? current : { ...current, rows });
      setPendingModels(null);
      setNote(t(`已添加 ${selected.length} 个模型。保存服务后生效。`, `Added ${selected.length} models. Save the service to apply changes.`));
    } catch (error) { setFailure(code(error)); }
  };
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
      const encoded = encodeModelRows(editor.rows);
      const service = { ...editor.service, ...encoded };
      if (encoded.modelSettings === undefined) delete service.modelSettings;
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
  const modelFailure = failure === 'model_id_duplicate' ? t('模型标识不能重复。', 'Model IDs must be unique.')
    : failure === 'model_id_invalid' ? t('请为每一行填写有效的模型标识。', 'Enter a valid model ID for every row.')
      : failure === 'model_limit_invalid' ? t('Token 数必须是正整数，留空表示使用默认值。', 'Token limits must be positive integers. Leave blank to use defaults.')
        : failure === 'model_output_exceeds_context' ? t('最大输出 token 数不能超过上下文窗口。', 'The output limit cannot exceed the context window.')
          : failure === 'model_catalog_empty' ? t('请至少添加一个模型。', 'Add at least one model.')
            : failure === 'model_catalog_too_large' ? t('每个服务最多支持 128 个模型，请减少条目后重试。', 'Each service supports up to 128 models. Reduce the catalog and retry.')
              : failure === 'model_name_invalid' ? t('显示名称最多 100 个字符，不能包含控制字符。', 'Display names must contain at most 100 characters and no control characters.') : '';
  const failureMessage = failure === 'provider_output_budget_unsupported'
    ? t('输出额度超过模型、能力配置或上下文允许的上限，请降低数值后保存。', 'The output budget exceeds a model, capability, or context limit. Reduce it and save again.')
    : failure === 'model_not_available' || failure === 'model_service_not_found'
      ? t('当前默认或会话选择仍引用此模型服务。请先切换到保留的模型，再删除条目。', 'A default or session selection still references this model service. Switch to a retained model before deleting entries.')
    : failure === 'provider_credential_missing'
    ? t('请填写 API Key 或设置对应环境变量，再获取模型。', 'Enter an API key or set its environment variable, then fetch models.')
    : failure === 'model_discovery_credential_unbound'
      ? t('已存储密钥仅限用户级配置中绑定的服务端点。请确认地址并填写临时 Key，或将服务保存到用户级设置。', 'Stored keys require an endpoint bound in user-level settings. Verify the address and enter a temporary key, or save the service in user-level settings.')
      : failure === 'model_discovery_insecure_transport'
      ? t('获取模型要求 HTTPS，或使用本机回环地址。', 'Model discovery requires HTTPS or a local loopback address.')
      : failure === 'model_discovery_failed'
        ? t('无法从服务获取模型。请检查网络、服务地址和凭据。', 'Could not fetch models. Check the network, endpoint, and credential.')
      : failure === 'model_discovery_unsupported'
        ? t('此协议暂不支持自动获取模型，请手动填写。', 'Automatic model discovery is unavailable for this protocol. Enter models manually.')
        : t('操作未完成，请检查填写内容或凭据设施。', 'Could not complete the action. Check the fields or credential store.');

  return <div className="model-settings">
    <div className="settings-intro"><h2>{t('模型服务', 'Model services')}</h2><p>{t('保存服务与模型，在输入区切换。密钥使用系统凭据库，环境变量优先。', 'Save services and models, then switch in the composer. API keys use the system credential store; environment variables take priority.')}</p></div>
    {note && <p className="inline-notice" role="status">{note}</p>}
    {failure && <div className="inline-notice" role="alert"><span>{modelFailure || (failure === 'config_version_stale' ? t('配置已被修改，请刷新后重试。', 'Configuration changed. Refresh and retry.') : failureMessage)}</span><details><summary>{t('详情', 'Details')}</summary><code>{failure}</code></details><button type="button" disabled={busy} onClick={() => void load().catch(error => setFailure(code(error)))}>{t('刷新', 'Refresh')}</button></div>}
    {editor === null ? <>
      {defaultChoices.length > 0 && <label className="service-default-select">{t('默认模型', 'Default model')}<select disabled={busy} value={JSON.stringify([defaultSelection?.provider, defaultSelection?.model])} onChange={event => { const choice = defaultChoices.find(item => item.value === event.target.value); if (choice !== undefined) void selectDefault(choice.service, choice.model); }}>{defaultChoices.map(choice => <option key={choice.value} value={choice.value}>{choice.service.id === 'legacy' ? t('现有配置', 'Existing configuration') : choice.service.name} / {modelName(choice.service, choice.model)}</option>)}</select></label>}
      {legacy !== null && <div className="service-row"><Icon name="spark" /><div><strong>{t('现有模型配置', 'Existing model configuration')}</strong><span>{legacy.models[0]}</span></div><button type="button" onClick={() => begin(legacy)}>{t('另存为服务', 'Save as a service')}</button></div>}
      {services.map(service => <div key={service.id} className="service-row"><Icon name="spark" /><div><strong>{service.name}{defaultSelection?.provider === service.id && <span className="service-default">{t('默认', 'Default')}</span>}</strong><span>{service.models.join(', ')}</span></div><button type="button" disabled={busy} onClick={() => begin(service)}>{t('编辑', 'Edit')}</button><button type="button" className="icon-button" aria-label={t(`删除服务 ${service.name}`, `Delete service ${service.name}`)} onClick={() => setConfirm({ type: 'service', service })}><Icon name="close" size={14} /></button></div>)}
      {catalog !== null && services.length === 0 && legacy === null && <p className="model-empty">{t('添加第一个服务，即可开始对话。', 'Add your first service to start a conversation.')}</p>}
      <button type="button" className="add-service" disabled={catalog === null} onClick={() => begin()}><Icon name="plus" size={15} />{t('添加服务', 'Add service')}</button>
    </> : <form className="service-form" onSubmit={(event) => { event.preventDefault(); void save(); }}><fieldset className="service-fields" disabled={busy}>
      <label>{t('快速配置', 'Quick setup')}<select value={selectedPreset} onChange={event => applyPreset(event.target.value as keyof typeof PRESETS | 'custom')}><option value="custom">{t('自定义兼容服务', 'Custom compatible service')}</option><option value="deepseek">DeepSeek</option><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option></select></label>
      <label>{t('服务名称', 'Service name')}<input value={editor.service.name} maxLength={100} onChange={event => patch({ name: event.target.value })} placeholder={t('例如 DeepSeek', 'For example, DeepSeek')} required /></label>
      <label>{t('接口类型', 'API type')}<select value={editor.service.api} onChange={event => patch({ api: event.target.value as ModelService['api'] })}><option value="chat-completions">Chat Completions</option><option value="messages">Messages</option></select></label>
      <label>{t('服务地址', 'Base URL')}<input type="url" value={editor.service.baseURL} onChange={event => patch({ baseURL: event.target.value })} placeholder="https://api.example.com/v1" required /></label>
      <section className="service-model-catalog" aria-label={t('模型目录', 'Model catalog')}>
        <div className="model-catalog-heading"><h3>{t('模型目录', 'Model catalog')} <span>{editor.rows.length}/128</span></h3><button type="button" disabled={busy || editor.service.api !== 'chat-completions' || editor.service.baseURL.trim() === '' || !validReference} onClick={() => void fetchModels()}>{t('获取可用模型并填入', 'Fetch and add models')}</button></div>
        <p className="model-catalog-help">{t('Token 数留空使用默认值。图像输入选择“自动”时仅启用已验证模型，未知模型默认拒绝图片；请按服务实际能力选择“支持”。获取列表会保留已有参数。', 'Blank token limits use defaults. Automatic image input enables only verified models; unknown models reject images. Select Supported only when the service supports images. Fetching preserves existing settings.')}</p>
        <div className="model-table-scroll" tabIndex={0} aria-label={t('模型配置表，可横向滚动', 'Model configuration table, scroll horizontally')}><table className="model-config-table"><thead><tr><th scope="col">{t('模型标识', 'Model ID')}</th><th scope="col">{t('显示名称', 'Display name')}</th><th scope="col">{t('上下文窗口', 'Context window')}</th><th scope="col">{t('最大输出 token', 'Max output tokens')}</th><th scope="col">{t('图像输入', 'Image input')}</th><th scope="col"><span className="sr-only">{t('操作', 'Actions')}</span></th></tr></thead><tbody>
          {editor.rows.map((row, index) => <tr key={row.key}>
            <td><input aria-label={t(`第 ${index + 1} 行模型标识`, `Model ID, row ${index + 1}`)} value={row.id} maxLength={256} onChange={event => patchRow(row.key, { id: event.target.value })} placeholder="model-id" required /></td>
            <td><input aria-label={t(`第 ${index + 1} 行显示名称`, `Display name, row ${index + 1}`)} value={row.name} maxLength={100} onChange={event => patchRow(row.key, { name: event.target.value })} placeholder={row.id || t('可选', 'Optional')} /></td>
            <td><input type="number" min={1} step={1} inputMode="numeric" aria-label={t(`第 ${index + 1} 行上下文窗口`, `Context window, row ${index + 1}`)} value={row.contextTokens} onChange={event => patchRow(row.key, { contextTokens: event.target.value })} placeholder={t('默认', 'Default')} /></td>
            <td><input type="number" min={1} step={1} inputMode="numeric" aria-label={t(`第 ${index + 1} 行最大输出 token`, `Max output tokens, row ${index + 1}`)} value={row.outputTokens} onChange={event => patchRow(row.key, { outputTokens: event.target.value })} placeholder={t('默认', 'Default')} /></td>
            <td><select aria-label={t(`第 ${index + 1} 行图像输入`, `Image input, row ${index + 1}`)} value={row.imageInput === undefined ? 'auto' : String(row.imageInput)} onChange={event => patchRow(row.key, { imageInput: event.target.value === 'auto' ? undefined : event.target.value === 'true' })}><option value="auto">{t('自动', 'Automatic')}</option><option value="true">{t('支持', 'Supported')}</option><option value="false">{t('不支持', 'Unsupported')}</option></select></td>
            <td><button type="button" className="icon-button model-remove-row" aria-label={t(`删除模型 ${row.id || index + 1}`, `Delete model ${row.id || index + 1}`)} onClick={() => setEditor(current => current === null ? null : { ...current, rows: current.rows.filter(item => item.key !== row.key) })}><Icon name="trash" size={14} /></button></td>
          </tr>)}
          {editor.rows.length === 0 && <tr><td colSpan={6} className="model-catalog-empty">{t('获取服务模型列表，或手动添加第一个模型。', 'Fetch models from the service or add your first model manually.')}</td></tr>}
        </tbody></table></div>
        <button type="button" className="model-add-row" disabled={editor.rows.length >= 128} onClick={() => setEditor(current => current === null ? null : { ...current, rows: [...current.rows, newModelRow()] })}><Icon name="plus" size={14} />{t('添加模型', 'Add model')}</button>
      </section>
      {editor.service.api !== 'chat-completions' && <p className="field-help">{t('当前协议不提供兼容的模型目录接口，请手动填写模型标识。', 'This protocol has no compatible model directory endpoint. Enter model IDs manually.')}</p>}
      <label>{t('API Key', 'API key')}<input type="password" autoComplete="new-password" value={editor.key} disabled={credential?.source === 'environment'} onChange={event => setEditor({ ...editor, key: event.target.value })} placeholder={credential?.configured ? t('已设置。输入新密钥可替换。', 'Configured. Enter a new key to replace it.') : t('输入密钥，或使用环境变量', 'Enter a key, or use an environment variable')} /></label>
      <p className="field-help">{credential?.source === 'environment' ? t('当前由环境变量提供。请在启动环境中修改或删除。', 'Supplied by the environment. Change or remove it in the launching environment.') : credentialError ? t('系统凭据库暂不可用。可以设置下方环境变量。', 'System credential store is unavailable. You can use the environment variable below.') : t('保存后不显示密钥原文。留空会保留已存密钥。', 'Saved keys are not shown. Leave blank to keep the stored key.')}</p>
      {credential?.source === 'keyring' && <button type="button" className="text-button" onClick={() => setConfirm({ type: 'key', service: editor.service })}>{t('删除已存密钥', 'Delete stored key')}</button>}
      <details><summary>{t('凭据引用与保存位置', 'Credential reference and save location')}</summary><div className="service-advanced"><label>{t('环境变量名', 'Environment variable')}<input value={editor.service.apiKeyEnv} onChange={event => patch({ apiKeyEnv: event.target.value })} pattern="[A-Za-z_][A-Za-z0-9_]*" maxLength={128} required /></label><label>{t('保存到', 'Save to')}<select value={layer} onChange={event => setLayer(event.target.value)}><option value="user">{t('用户配置', 'User configuration')}</option><option value="projectLocal">{t('项目本地配置', 'Project local configuration')}</option></select></label></div></details>
      <div className="form-actions"><button type="button" disabled={busy} onClick={() => { if (changed) setLeaving(true); else setEditor(null); }}>{t('返回列表', 'Back to services')}</button><button type="submit" className="primary-button" disabled={busy || !validReference}>{busy ? t('保存中…', 'Saving…') : t('保存服务', 'Save service')}</button></div>
    </fieldset></form>}
    {confirm !== null && <Modal title={confirm.type === 'key' ? t('删除密钥？', 'Delete API key?') : t('删除服务？', 'Delete service?')} className="confirm" onClose={() => { if (!busy) setConfirm(null); }}><h2 className="confirm-lead">{confirm.type === 'key' ? t('删除已存密钥？', 'Delete the stored API key?') : t(`删除服务“${confirm.service.name}”？`, `Delete “${confirm.service.name}”?`)}</h2><p className="confirm-note">{confirm.type === 'key' ? t('使用相同凭据引用的服务都将受到影响。', 'All services using this credential reference will be affected.') : t('会话记录和已存密钥将保留。在用会话保留当前连接，直到重新选择。', 'Conversation history and stored keys are kept. Sessions using this service retain their connection until another selection is made.')}</p><div className="confirm-actions"><button type="button" disabled={busy} onClick={() => setConfirm(null)}>{t('取消', 'Cancel')}</button><button type="button" disabled={busy} onClick={() => void remove()}>{t('删除', 'Delete')}</button></div></Modal>}
    {pendingModels !== null && editor !== null && <ModelSelectionDialog models={pendingModels} existingModels={editor.rows.map(row => row.id)} onCancel={() => { setPendingModels(null); setNote(t('未添加模型，目录未更改。', 'No models were added; the catalog is unchanged.')); }} onAdd={addDiscoveredModels} />}
    {leaving && <HoldSheet lead={t('放弃未保存的修改？', 'Discard unsaved changes?')} reasons={[t('模型服务有未保存的修改', 'Model service has unsaved changes')]} onStay={() => setLeaving(false)} onLeave={() => { setLeaving(false); setEditor(null); }} />}
  </div>;
}
