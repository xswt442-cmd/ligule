import type { ConfigSnapshot } from '../kernel/config.js';
import type { LoadedLayers } from '../kernel/config-store.js';
import { resolveCredential } from '../kernel/credentials.js';
import { isBearerCredential } from '../capability/network.js';
import { KernelError } from '../kernel/error.js';
import { searchSettingsOf } from '../kernel/search-settings.js';
import { createWebSearchPlugin } from '../tools/web-search.js';

export interface SearchStatus {
  readonly configured: boolean;
  readonly available: boolean;
  readonly serviceId?: string;
  readonly code?: string;
}

/** Only a configured service with a present credential contributes a model-callable tool. */
export async function createSearchSupport(config: ConfigSnapshot, layers: LoadedLayers) {
  let serviceId: string | undefined;
  try {
    const settings = searchSettingsOf(config, Object.keys(layers).length === 0 ? undefined : layers);
    if (settings === undefined) return { status: { configured: false, available: false, code: 'search_not_configured' } satisfies SearchStatus };
    serviceId = settings.serviceId;
    const credential = await resolveCredential(settings.apiKeyEnv);
    if (credential === undefined) {
      return { status: { configured: true, available: false, serviceId, code: 'search_credential_missing' } satisfies SearchStatus };
    }
    if (!isBearerCredential(credential)) return { status: { configured: true, available: false, serviceId, code: 'search_credential_invalid' } satisfies SearchStatus };
    return { status: { configured: true, available: true, serviceId } satisfies SearchStatus,
      plugin: createWebSearchPlugin(settings) };
  } catch (error) {
    if (!(error instanceof KernelError)) throw error;
    return { status: { configured: true, available: false, ...(serviceId === undefined ? {} : { serviceId }),
      code: error.code } satisfies SearchStatus };
  }
}
