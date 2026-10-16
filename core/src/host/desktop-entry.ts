#!/usr/bin/env node
import { createConfig } from '../kernel/config.js';
import { loadConfigLayers } from '../kernel/config-file.js';
import { extensionSources } from '../kernel/extensions.js';
import { DEFAULT_MODE, modeDirectories } from '../kernel/modes.js';
import { hostProviderFromConfig, serveHost } from './host.js';
import { createConfigStore } from '../kernel/config-store.js';
import { fileURLToPath } from 'node:url';

const projectRoot = process.cwd();
const layers = await loadConfigLayers({ projectRoot });
const user = { boundary: projectRoot, ...layers.user };
const config = createConfig({ ...layers, user });
const extensions = await extensionSources({ ...layers, user }, { projectRoot });
const shippedModes = fileURLToPath(new URL('../../modes/', import.meta.url));
const modePaths = modeDirectories(projectRoot, shippedModes);
async function loadProjectEnvironment(root: string) {
  const projectLayers = await loadConfigLayers({ projectRoot: root });
  const projectUser = { boundary: root, ...projectLayers.user };
  const projectConfig = createConfig({ ...projectLayers, user: projectUser });
  return {
    config: projectConfig,
    provider: hostProviderFromConfig(projectConfig),
    policy: projectConfig.policy as Parameters<typeof serveHost>[0]['policy'],
    layers: projectLayers,
    modeName: typeof projectConfig.mode === 'string' ? projectConfig.mode : DEFAULT_MODE,
    modePaths: modeDirectories(root, shippedModes),
    extensions: await extensionSources({ ...projectLayers, user: projectUser }, { projectRoot: root }),
  };
}
serveHost({
  config,
  provider: hostProviderFromConfig(config),
  policy: config.policy as Parameters<typeof serveHost>[0]['policy'],
  extensions,
  loadEnvironment: loadProjectEnvironment,
  interactive: true,
  configLayers: layers,
  configStoreFor: (root, ownLayers) => createConfigStore({ projectRoot: root, layers: ownLayers }),
  modeName: typeof config.mode === 'string' ? config.mode : DEFAULT_MODE,
  modePaths,
});
