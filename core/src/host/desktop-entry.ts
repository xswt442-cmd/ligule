#!/usr/bin/env node
import { serveHost } from './host.js';
import { loadHostEnvironment } from './environment.js';
import { createConfigStore } from '../kernel/config-store.js';
import { fileURLToPath } from 'node:url';

const projectRoot = process.cwd();
const shippedModes = fileURLToPath(new URL('../../modes/', import.meta.url));
async function loadProjectEnvironment(root: string) {
  return loadHostEnvironment(root, shippedModes);
}
const { layers, ...environment } = await loadProjectEnvironment(projectRoot);
serveHost({
  ...environment,
  loadEnvironment: loadProjectEnvironment,
  interactive: true,
  configLayers: layers,
  configStoreFor: (root, ownLayers) => createConfigStore({ projectRoot: root, layers: ownLayers }),
});
