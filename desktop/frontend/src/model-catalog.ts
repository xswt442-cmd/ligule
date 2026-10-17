export type ModelSettings = { id: string; name?: string; contextTokens?: number; outputTokens?: number };
export type ModelService = { id: string; name: string; api: 'messages' | 'chat-completions'; baseURL: string; apiKeyEnv: string; models: string[]; modelSettings?: ModelSettings[] };
export type ModelSelection = { provider: string; model: string };
export type ModelCatalog = {
  model: { api?: string; baseURL?: string; model?: string; apiKeyEnv?: string };
  services?: ModelService[];
  selection?: ModelSelection | null;
  layers: { layer: string; version: string; exists: boolean }[];
  sources: Record<string, string>;
};

// 切换预设只改正在编辑的服务配置；已有服务的身份和凭据引用不能变。
export function presetService(preset: Pick<ModelService, 'name' | 'api' | 'baseURL'>, previous: ModelService | null, existing: boolean, generatedId: string): ModelService {
  const id = existing && previous !== null ? previous.id : generatedId;
  return { id, ...preset, apiKeyEnv: existing && previous !== null ? previous.apiKeyEnv : `LIGULE_${id.toUpperCase()}_KEY`, models: [] };
}

export function legacyService(catalog: ModelCatalog): ModelService | null {
  const { api, baseURL, model, apiKeyEnv } = catalog.model;
  if ((api !== 'messages' && api !== 'chat-completions') || !baseURL || !model) return null;
  return { id: 'legacy', name: 'legacy', api, baseURL, apiKeyEnv: apiKeyEnv ?? 'LIGULE_API_KEY', models: [model] };
}

export type ModelRow = { key: string; id: string; name: string; contextTokens: string; outputTokens: string };

export function newModelRow(id = '', settings?: ModelSettings): ModelRow {
  return { key: crypto.randomUUID(), id, name: settings?.name ?? '', contextTokens: settings?.contextTokens?.toString() ?? '', outputTokens: settings?.outputTokens?.toString() ?? '' };
}

export function modelRows(service: ModelService): ModelRow[] {
  return service.models.map(id => newModelRow(id, service.modelSettings?.find(item => item.id === id)));
}

/** Discovery adds IDs while retaining manually edited names and token limits. */
export function mergeModelRows(rows: ModelRow[], discovered: string[]): ModelRow[] {
  const ids = new Set(rows.map(row => row.id.trim()));
  const next = [...rows];
  for (const id of discovered) {
    if (ids.has(id)) continue;
    ids.add(id);
    next.push(newModelRow(id));
  }
  if (next.length > 128) throw Object.assign(new Error('model_catalog_too_large'), { code: 'model_catalog_too_large' });
  return next;
}

export function encodeModelRows(rows: ModelRow[]): Pick<ModelService, 'models' | 'modelSettings'> {
  const fail = (code: string): never => { throw Object.assign(new Error(code), { code }); };
  if (rows.length === 0) return fail('model_catalog_empty');
  if (rows.length > 128) return fail('model_catalog_too_large');
  const ids = new Set<string>();
  const modelSettings: ModelSettings[] = [];
  const models = rows.map(row => {
    const id = row.id.trim();
    if (id === '' || id.length > 256 || /[\u0000-\u001f\u007f]/u.test(id)) return fail('model_id_invalid');
    if (ids.has(id)) return fail('model_id_duplicate');
    ids.add(id);
    const settings: ModelSettings = { id };
    const name = row.name.trim();
    if (name.length > 100 || /[\u0000-\u001f\u007f]/u.test(name)) return fail('model_name_invalid');
    if (name !== '') settings.name = name;
    for (const field of ['contextTokens', 'outputTokens'] as const) {
      if (row[field].trim() === '') continue;
      const value = Number(row[field]);
      if (!Number.isSafeInteger(value) || value < 1) return fail('model_limit_invalid');
      settings[field] = value;
    }
    if (settings.contextTokens !== undefined && settings.outputTokens !== undefined && settings.outputTokens > settings.contextTokens) return fail('model_output_exceeds_context');
    if (Object.keys(settings).length > 1) modelSettings.push(settings);
    return id;
  });
  return { models, ...(modelSettings.length === 0 ? {} : { modelSettings }) };
}

export function modelName(service: ModelService, id: string): string {
  return service.modelSettings?.find(item => item.id === id)?.name ?? id;
}
