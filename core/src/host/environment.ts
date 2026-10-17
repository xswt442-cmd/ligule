import { resolve } from 'node:path';
import { createConfig } from '../kernel/config.js';
import { loadConfigLayers } from '../kernel/config-file.js';
import { extensionSources } from '../kernel/extensions.js';
import { DEFAULT_MODE, modeDirectories } from '../kernel/modes.js';
import { hostProviderFromConfig } from './provider.js';
import type { createHost, EnvironmentSeed } from './host.js';

/** Read all project resources from the same configuration-layer snapshot. */
export async function loadProjectConfig(projectRoot: string, flags: string[] = []) {
  const layers = await loadConfigLayers({ projectRoot, flags });
  const user = { boundary: projectRoot, ...layers.user };
  const config = createConfig({ ...layers, user });
  const extensions = await extensionSources({ ...layers, user }, { projectRoot });
  return { config, extensions, layers };
}

export async function loadHostEnvironment(projectRoot: string, shippedModes: string, flags: string[] = []): Promise<EnvironmentSeed> {
  const loaded = await loadProjectConfig(projectRoot, flags);
  const config: EnvironmentSeed['config'] = Object.freeze({ ...loaded.config, workspaceRoot: resolve(projectRoot) });
  return {
    ...loaded,
    config,
    provider: hostProviderFromConfig(config),
    policy: config.policy as Parameters<typeof createHost>[0]['policy'],
    modeName: typeof config.mode === 'string' ? config.mode : DEFAULT_MODE,
    modePaths: modeDirectories(projectRoot, shippedModes),
  };
}
