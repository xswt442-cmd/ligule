import { KernelError } from './error.js';

export type ModelService = {
  id: string;
  name: string;
  api: 'messages' | 'chat-completions';
  baseURL: string;
  apiKeyEnv: string;
  models: string[];
};
export type ModelSelection = { provider: string; model: string };

const SERVICE_FIELDS = ['id', 'name', 'api', 'baseURL', 'apiKeyEnv', 'models'];
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
    return { id, name, api, baseURL: baseURL.replace(/\/+$/u, ''), apiKeyEnv, models };
  });
}

export function modelSelection(value: unknown): ModelSelection {
  const given = objectOf(value);
  if (Object.keys(given).some((key) => key !== 'provider' && key !== 'model')) return serviceError('selection contains unsupported fields');
  return { provider: textOf(given.provider, 'provider', 64), model: textOf(given.model, 'model', 256) };
}

export function resolveModel(model: Record<string, unknown>, selection?: ModelSelection): Record<string, unknown> {
  const services = modelServices(model.services);
  const chosen = selection ?? (model.selection === undefined ? undefined : modelSelection(model.selection));
  const legacyReady = typeof model.api === 'string' && typeof model.baseURL === 'string' && typeof model.model === 'string';
  const selected = chosen ?? (!legacyReady && services.length > 0 ? { provider: services[0].id, model: services[0].models[0] } : undefined);
  if (selected === undefined || selected.provider === 'legacy') return { ...model, ...(selected === undefined ? {} : { model: selected.model }), serviceId: 'legacy' };
  const service = services.find((entry) => entry.id === selected.provider);
  if (service === undefined) throw new KernelError('model_service_not_found', { detail: selected.provider });
  if (!service.models.includes(selected.model)) throw new KernelError('model_not_available', { detail: 'the selected model is not listed for this service' });
  return { ...model, api: service.api, baseURL: service.baseURL, apiKeyEnv: service.apiKeyEnv, model: selected.model, serviceId: service.id };
}

// 配置中的受管值使用 TOML 内联表；语法解析和节点定位仍由现有解析器完成。
export function servicesLiteral(services: ModelService[]): string {
  const quote = (value: string) => JSON.stringify(value);
  return `[${services.map((service) => `\n  { id = ${quote(service.id)}, name = ${quote(service.name)}, api = ${quote(service.api)}, baseURL = ${quote(service.baseURL)}, apiKeyEnv = ${quote(service.apiKeyEnv)}, models = [${service.models.map(quote).join(', ')}] }`).join(',')}\n]`;
}

export function selectionLiteral(selection: ModelSelection): string {
  return `{ provider = ${JSON.stringify(selection.provider)}, model = ${JSON.stringify(selection.model)} }`;
}
