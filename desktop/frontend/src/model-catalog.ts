export type ModelSettings = { id: string; name?: string; contextTokens?: number; outputTokens?: number; imageInput?: boolean };
export type ModelService = { id: string; name: string; api: 'messages' | 'chat-completions'; baseURL: string; apiKeyEnv: string; models: string[]; modelSettings?: ModelSettings[] };
export type ModelSelection = { provider: string; model: string };
// 会话级思考档：Host 只对声明了该能力的模型下发 available；'default' 表示继承模型默认值。
export type ThinkingView = { available: readonly string[]; defaultEffort: string | null; effective: string; pending: string | null };
// 规范顺序只用于展示；未知档位排在已记录档位之后，避免新档位被静默丢弃。
const THINKING_ORDER: readonly string[] = ['none', 'low', 'high', 'max'];
export function thinkingChoices(available: readonly string[]): string[] {
  const known = new Set(available);
  return [...THINKING_ORDER.filter(effort => known.has(effort)), ...[...known].filter(effort => !THINKING_ORDER.includes(effort))];
}
export type ModelCatalog = {
  model: { api?: string; baseURL?: string; model?: string; apiKeyEnv?: string };
  services?: ModelService[];
  selection?: ModelSelection | null;
  layers: { layer: string; version: string; exists: boolean }[];
  sources: Record<string, string>;
};

// 切换预设只修改当前编辑的服务配置，保留服务 ID 和凭据引用。
export function presetService(preset: Pick<ModelService, 'name' | 'api' | 'baseURL'>, previous: ModelService | null, existing: boolean, generatedId: string): ModelService {
  const id = existing && previous !== null ? previous.id : generatedId;
  return { id, ...preset, apiKeyEnv: existing && previous !== null ? previous.apiKeyEnv : `LIGULE_${id.toUpperCase()}_KEY`, models: [] };
}

export function legacyService(catalog: ModelCatalog): ModelService | null {
  const { api, baseURL, model, apiKeyEnv } = catalog.model;
  if ((api !== 'messages' && api !== 'chat-completions') || !baseURL || !model) return null;
  return { id: 'legacy', name: 'legacy', api, baseURL, apiKeyEnv: apiKeyEnv ?? 'LIGULE_API_KEY', models: [model] };
}

export type ModelRow = { key: string; id: string; name: string; contextTokens: string; outputTokens: string; imageInput?: boolean };

export function newModelRow(id = '', settings?: ModelSettings): ModelRow {
  return { key: crypto.randomUUID(), id, name: settings?.name ?? '', contextTokens: settings?.contextTokens?.toString() ?? '', outputTokens: settings?.outputTokens?.toString() ?? '', ...(settings?.imageInput === undefined ? {} : { imageInput: settings.imageInput }) };
}

export function modelRows(service: ModelService): ModelRow[] {
  return service.models.map(id => newModelRow(id, service.modelSettings?.find(item => item.id === id)));
}

/** 合并发现结果时补入模型 ID，并保留用户编辑过的名称和 Token 限制。 */
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

export function uniqueModelIds(discovered: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of discovered) {
    const id = value.trim();
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    unique.push(id);
  }
  return unique;
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
    if (row.imageInput !== undefined) settings.imageInput = row.imageInput;
    if (settings.contextTokens !== undefined && settings.outputTokens !== undefined && settings.outputTokens > settings.contextTokens) return fail('model_output_exceeds_context');
    if (Object.keys(settings).length > 1) modelSettings.push(settings);
    return id;
  });
  return { models, ...(modelSettings.length === 0 ? {} : { modelSettings }) };
}

export function modelName(service: ModelService, id: string): string {
  return service.modelSettings?.find(item => item.id === id)?.name ?? id;
}
