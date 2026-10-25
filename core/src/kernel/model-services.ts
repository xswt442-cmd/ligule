import { KernelError } from './error.js';

export type ModelService = {
  id: string;
  name: string;
  api: 'messages' | 'chat-completions';
  baseURL: string;
  apiKeyEnv: string;
  models: string[];
  modelSettings?: ModelServiceModelSettings[];
};
export type ModelServiceModelSettings = { id: string; name?: string; contextTokens?: number; outputTokens?: number; imageInput?: boolean };
export type ModelSelection = { provider: string; model: string };

const SERVICE_FIELDS = ['id', 'name', 'api', 'baseURL', 'apiKeyEnv', 'models', 'modelSettings'];
const MODEL_SETTINGS_FIELDS = ['id', 'name', 'contextTokens', 'outputTokens', 'imageInput'];
const serviceError = (detail: string): never => { throw new KernelError('model_service_invalid', { detail }); };

function objectOf(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return serviceError('a service must be an object');
  return value as Record<string, unknown>;
}

function textOf(value: unknown, name: string, max = 512): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) return serviceError(`${name} must be non-empty visible text`);
  return value.trim();
}

export function modelServices(value: unknown): ModelService[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) return serviceError('services must be an array of at most 32 entries');
  const ids = new Set<string>();
  return value.map((entry) => {
    const given = objectOf(entry);
    if (Object.keys(given).some((key) => !SERVICE_FIELDS.includes(key))) return serviceError('the service contains unsupported fields');
    const id = textOf(given.id, 'id', 64);
    if (!/^[a-z0-9][a-z0-9_-]*$/u.test(id) || id === 'legacy' || ids.has(id)) return serviceError('service ids must be unique lowercase names; legacy is reserved');
    ids.add(id);
    const name = textOf(given.name, 'name', 100);
    const api = given.api;
    if (api !== 'messages' && api !== 'chat-completions') return serviceError('api must be messages or chat-completions');
    const baseURL = textOf(given.baseURL, 'baseURL', 2048);
    let url: URL;
    try { url = new URL(baseURL); } catch { return serviceError('baseURL must be a full HTTP(S) URL'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return serviceError('baseURL must not contain credentials, a query, or a fragment');
    const apiKeyEnv = textOf(given.apiKeyEnv, 'apiKeyEnv', 128);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(apiKeyEnv)) return serviceError('apiKeyEnv must name an environment variable');
    if (!Array.isArray(given.models) || given.models.length < 1 || given.models.length > 128) return serviceError('a service must list 1–128 models');
    const models = [...new Set(given.models.map((model) => textOf(model, 'model', 256)))];
    let modelSettings: ModelServiceModelSettings[] | undefined;
    if (given.modelSettings !== undefined) {
      if (!Array.isArray(given.modelSettings)) return serviceError('modelSettings must be an array');
      const settingIds = new Set<string>();
      modelSettings = given.modelSettings.map((item) => {
        const setting = objectOf(item);
        if (Object.keys(setting).some((key) => !MODEL_SETTINGS_FIELDS.includes(key))) return serviceError('modelSettings contains unsupported fields');
        const settingId = textOf(setting.id, 'modelSettings.id', 256);
        if (!models.includes(settingId)) return serviceError('modelSettings.id must name a model in the same service');
        if (settingIds.has(settingId)) return serviceError('modelSettings ids must be unique');
        settingIds.add(settingId);
        const modelSetting: ModelServiceModelSettings = { id: settingId };
        if (setting.name !== undefined) modelSetting.name = textOf(setting.name, 'modelSettings.name', 100);
        for (const key of ['contextTokens', 'outputTokens'] as const) {
          const value = setting[key];
          if (value === undefined) continue;
          if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) return serviceError(`modelSettings.${key} must be a positive safe integer`);
          modelSetting[key] = value;
        }
        if (setting.imageInput !== undefined) {
          if (typeof setting.imageInput !== 'boolean') return serviceError('modelSettings.imageInput must be a boolean');
          modelSetting.imageInput = setting.imageInput;
        }
        if (modelSetting.contextTokens !== undefined && modelSetting.outputTokens !== undefined && modelSetting.outputTokens > modelSetting.contextTokens) {
          return serviceError('modelSettings.outputTokens must not exceed contextTokens');
        }
        return modelSetting;
      });
    }
    return { id, name, api, baseURL: baseURL.replace(/\/+$/u, ''), apiKeyEnv, models, ...(modelSettings === undefined ? {} : { modelSettings }) };
  });
}

export function modelSelection(value: unknown): ModelSelection {
  const given = objectOf(value);
  if (Object.keys(given).some((key) => key !== 'provider' && key !== 'model')) return serviceError('selection contains unsupported fields');
  return { provider: textOf(given.provider, 'provider', 64), model: textOf(given.model, 'model', 256) };
}

export function resolveModel(model: Record<string, unknown>, selection?: ModelSelection): Record<string, unknown> {
  const baseModel = { ...model };
  delete baseModel.serviceOutputLimit;
  delete baseModel.serviceContextTokens;
  delete baseModel.serviceImageInput;
  const services = modelServices(model.services);
  const chosen = selection ?? (model.selection === undefined ? undefined : modelSelection(model.selection));
  const legacyReady = typeof model.api === 'string' && typeof model.baseURL === 'string' && typeof model.model === 'string';
  const selected = chosen ?? (!legacyReady && services.length > 0 ? { provider: services[0].id, model: services[0].models[0] } : undefined);
  if (selected === undefined || selected.provider === 'legacy') return { ...baseModel, ...(selected === undefined ? {} : { model: selected.model }), serviceId: 'legacy' };
  const service = services.find((entry) => entry.id === selected.provider);
  if (service === undefined) throw new KernelError('model_service_not_found', { detail: selected.provider });
  if (!service.models.includes(selected.model)) throw new KernelError('model_not_available', { detail: 'the selected model is not listed for this service' });
  const modelSetting = service.modelSettings?.find((entry) => entry.id === selected.model);
  return {
    ...baseModel, api: service.api, baseURL: service.baseURL, apiKeyEnv: service.apiKeyEnv, model: selected.model, serviceId: service.id,
    ...(modelSetting?.outputTokens === undefined ? {} : { outputTokens: modelSetting.outputTokens, serviceOutputLimit: true }),
    ...(modelSetting?.contextTokens === undefined ? {} : { serviceContextTokens: modelSetting.contextTokens }),
    ...(modelSetting?.imageInput === undefined ? {} : { serviceImageInput: modelSetting.imageInput }),
  };
}

// 配置中的受管值使用 TOML 内联表；语法解析和节点定位仍由现有解析器完成。
export function servicesLiteral(services: ModelService[]): string {
  const quote = (value: string) => JSON.stringify(value);
  return `[${services.map((service) => {
    const modelSettings = service.modelSettings?.map((setting) => {
      const fields = [`id = ${quote(setting.id)}`];
      if (setting.name !== undefined) fields.push(`name = ${quote(setting.name)}`);
      if (setting.contextTokens !== undefined) fields.push(`contextTokens = ${setting.contextTokens}`);
      if (setting.outputTokens !== undefined) fields.push(`outputTokens = ${setting.outputTokens}`);
      if (setting.imageInput !== undefined) fields.push(`imageInput = ${setting.imageInput}`);
      return `{ ${fields.join(', ')} }`;
    });
    return `\n  { id = ${quote(service.id)}, name = ${quote(service.name)}, api = ${quote(service.api)}, baseURL = ${quote(service.baseURL)}, apiKeyEnv = ${quote(service.apiKeyEnv)}, models = [${service.models.map(quote).join(', ')}]${modelSettings === undefined ? '' : `, modelSettings = [${modelSettings.join(', ')}]`} }`;
  }).join(',')}\n]`;
}

export function selectionLiteral(selection: ModelSelection): string {
  return `{ provider = ${JSON.stringify(selection.provider)}, model = ${JSON.stringify(selection.model)} }`;
}
