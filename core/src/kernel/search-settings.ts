import { KernelError } from './error.js';
import { createConfig, type ConfigLayer, type ConfigSnapshot } from './config.js';
import { modelServices } from './model-services.js';

export type SearchSettings = {
  provider: 'deepseek';
  serviceId: string;
  apiKeyEnv: string;
};

const TRUSTED_LAYERS = ['user', 'flag', 'managed'] as const satisfies readonly ConfigLayer[];

function invalidSettings(): never {
  throw new KernelError('search_settings_invalid', { detail: 'trusted search settings or service binding are invalid' });
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function trustedConfig(layers: Partial<Record<ConfigLayer, Record<string, unknown>>>): ConfigSnapshot {
  const filtered: Partial<Record<ConfigLayer, Record<string, unknown>>> = {};
  for (const name of TRUSTED_LAYERS) {
    const layer = layers[name];
    if (layer === undefined) continue;
    const model = recordOf(layer.model);
    filtered[name] = {
      ...(layer.search === undefined ? {} : { search: layer.search }),
      ...(model?.services === undefined ? {} : { model: { services: model.services } }),
    };
  }
  return createConfig(filtered);
}

function isDeepSeekBaseURL(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'https:'
    && url.hostname === 'api.deepseek.com'
    && url.port === ''
    && url.username === ''
    && url.password === ''
    && url.search === ''
    && url.hash === ''
    && ['', '/', '/v1', '/v1/', '/anthropic/v1', '/anthropic/v1/'].includes(url.pathname);
}

/** Resolve search settings only from trusted configuration and a service in the same trusted catalog. */
export function searchSettingsOf(
  config: ConfigSnapshot,
  layers?: Partial<Record<ConfigLayer, Record<string, unknown>>>,
): SearchSettings | undefined {
  let selectedConfig: ConfigSnapshot;
  try {
    selectedConfig = layers === undefined ? config : trustedConfig(layers);
  } catch (cause) {
    throw new KernelError('search_settings_invalid', { cause, detail: 'trusted search configuration could not be read' });
  }

  const hasSearch = Object.hasOwn(selectedConfig, 'search');
  if (!hasSearch) return undefined;

  const search = recordOf(selectedConfig.search);
  if (search === undefined || Object.keys(search).some((key) => key !== 'provider' && key !== 'serviceId')) {
    return invalidSettings();
  }
  if (search.provider !== 'deepseek'
    || typeof search.serviceId !== 'string'
    || !/^[a-z0-9][a-z0-9_-]*$/u.test(search.serviceId)) {
    return invalidSettings();
  }

  let services;
  const model = recordOf(selectedConfig.model);
  try {
    services = modelServices(model?.services);
  } catch (cause) {
    throw new KernelError('search_service_invalid', { cause, detail: 'the trusted service catalog is invalid' });
  }
  const service = services.find((candidate) => candidate.id === search.serviceId);
  const rawServices = Array.isArray(model?.services) ? model.services : [];
  const rawService = rawServices.map(recordOf).find((candidate) => candidate?.id === search.serviceId);
  const rawBaseURL = rawService?.baseURL;
  if (service === undefined || typeof rawBaseURL !== 'string' || !isDeepSeekBaseURL(rawBaseURL)
    || typeof service.apiKeyEnv !== 'string'
    || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(service.apiKeyEnv)) {
    throw new KernelError('search_service_unavailable', { detail: 'the selected trusted service is unavailable for search' });
  }

  return { provider: 'deepseek', serviceId: service.id, apiKeyEnv: service.apiKeyEnv };
}
