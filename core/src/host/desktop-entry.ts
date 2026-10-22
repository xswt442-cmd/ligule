#!/usr/bin/env node
import { serveHost } from './host.js';
import { loadHostEnvironment } from './environment.js';
import { createConfigStore } from '../kernel/config-store.js';
import { createInteractivePermissionContext } from '../capability/permission-capabilities.js';
import { fileURLToPath } from 'node:url';

const projectRoot = process.cwd();
const shippedModes = fileURLToPath(new URL('../../modes/', import.meta.url));
async function loadProjectEnvironment(root: string) {
  return loadHostEnvironment(root, shippedModes);
}
const { layers, ...environment } = await loadProjectEnvironment(projectRoot);
const permission = await createInteractivePermissionContext({
  shellConfig: environment.config,
  workspaceRoot: environment.config.workspaceRoot ?? environment.config.boundary ?? projectRoot,
});
serveHost({
  ...environment,
  permission,
  loadEnvironment: loadProjectEnvironment,
  interactive: true,
  permissionControl: true,
  configLayers: layers,
  configStoreFor: (root, ownLayers) => createConfigStore({ projectRoot: root, layers: ownLayers }),
});
