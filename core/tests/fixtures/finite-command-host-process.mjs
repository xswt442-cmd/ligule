import { serveHost } from '../../dist/host/host.js';
import { providerFromConfig } from '../../dist/host/provider.js';
import { createConfig } from '../../dist/kernel/config.js';
import { createPermissionContext } from '../../dist/kernel/permission.js';

const [projectRoot, sessionDirectory, baseURL] = process.argv.slice(2);
if (!projectRoot || !sessionDirectory || !baseURL) process.exit(64);

const config = createConfig({ user: {
  boundary: projectRoot,
  host: { sessionDirectory },
  model: { api: 'chat-completions', baseURL, model: 'local-test-model', apiKeyEnv: 'LIGULE_TUI_TEST_API_KEY' },
  loop: { iterations: 4, modelCalls: 4 },
  limits: { contextTokens: 200_000 },
  policy: { mode: 'ask' },
} });
const permission = createPermissionContext('full-access', 'unrestricted', {
  filesystemRead: 'full', filesystemWrite: 'full', network: 'full', process: 'full',
});
serveHost({
  input: process.stdin,
  output: process.stdout,
  config,
  provider: providerFromConfig(config),
  policy: config.policy,
  permission,
  permissionControl: true,
  interactive: true,
});
