import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const PINNED_NODE_VERSION = 'v24.21.0';

export interface RuntimeLocationOptions {
  resourcesPath?: string;
  repositoryRoot?: string;
  environment?: NodeJS.ProcessEnv;
  node?: string;
}

export interface HostRuntime {
  node: string;
  cli: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export function resolveHostRuntime(options: RuntimeLocationOptions): HostRuntime {
  const environment = options.environment ?? process.env;
  const resourcesPath = options.resourcesPath;
  const bundledApp = resourcesPath === undefined ? undefined : join(resourcesPath, 'app');
  const cli = resourcesPath !== undefined
    ? join(bundledApp as string, 'dist', 'cli.js')
    : options.repositoryRoot === undefined ? undefined : join(options.repositoryRoot, 'dist', 'cli.js');
  if (cli === undefined || !existsSync(cli)) throw new Error('Host CLI was not found at its fixed runtime location');
  const appRoot = dirname(dirname(cli));
  const node = resourcesPath !== undefined
    ? join(resourcesPath, 'node', process.platform === 'win32' ? 'node.exe' : 'node')
    : options.node;
  if (node === undefined || !existsSync(node)) throw new Error('The pinned Node runtime was not found at its fixed location');
  validateNode24(node, environment);
  return {
    node,
    cli: resolve(cli),
    cwd: resolve(appRoot),
    env: sanitizedHostEnvironment(environment),
  };
}

export function sanitizedHostEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...environment };
  delete result.NODE_OPTIONS;
  delete result.NODE_PATH;
  delete result.ELECTRON_RUN_AS_NODE;
  delete result.LIGULE_DESKTOP_CSP_NONCE;
  return result;
}

function validateNode24(node: string, environment: NodeJS.ProcessEnv): void {
  let version: string;
  try {
    version = execFileSync(node, ['--version'], {
      env: sanitizedHostEnvironment(environment),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 5_000,
    }).trim();
  } catch {
    throw new Error('The configured Node runtime could not be verified');
  }
  const match = /^v(\d+)\./u.exec(version);
  if (match === null || version !== PINNED_NODE_VERSION) throw new Error(`The Host requires Node.js ${PINNED_NODE_VERSION}`);
}
