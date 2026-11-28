import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { dataRoot } from '../kernel/config-file.js';
import { KernelError, KernelRuntimeError } from '../kernel/error.js';
import { workspaceIdentity } from '../kernel/workspace.js';
import { errorCode, isRecord } from '../shared/guards.js';
import { withLockedAtomicFile } from '../storage/locked-file.js';

export type McpTrustScope = 'project' | 'user';

export function mcpTrustKey(server: string, identityDigest: string): string {
  return `${server}\u0000${identityDigest}`;
}

export interface McpTrustEntry {
  readonly source: 'trusted-ui';
  readonly scope: McpTrustScope;
  readonly projectIdentity: string | null;
  readonly server: string;
  readonly identityDigest: string;
  readonly trusted: boolean;
  readonly updatedAt: string;
}

interface McpTrustStore {
  readonly schemaVersion: 1;
  readonly entries: readonly McpTrustEntry[];
}

interface StoreRead {
  readonly store: McpTrustStore;
  readonly version: string;
  readonly mode?: number;
}

const STORE_LIMIT_BYTES = 1024 * 1024;
const ENTRY_LIMIT = 4096;
const LOCK_STALE_MS = 10_000;
const SCOPES: readonly McpTrustScope[] = ['project', 'user'];

export function mcpTrustPathOf(home = homedir()): string {
  return join(dataRoot(home), 'mcp-trust.json');
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
}

function invalidStore(cause?: unknown): KernelError {
  return new KernelError('mcp_trust_store_invalid', { cause });
}

function validateEntry(value: unknown): McpTrustEntry {
  const keys = ['source', 'scope', 'projectIdentity', 'server', 'identityDigest', 'trusted', 'updatedAt'];
  if (!isRecord(value) || !onlyKeys(value, keys)
    || value.source !== 'trusted-ui'
    || !SCOPES.includes(value.scope as McpTrustScope)
    || (value.projectIdentity !== null && (typeof value.projectIdentity !== 'string' || !isAbsolute(value.projectIdentity)))
    || (value.scope === 'project') !== (typeof value.projectIdentity === 'string')
    || typeof value.server !== 'string' || value.server === '' || value.server.length > 128
    || typeof value.identityDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(value.identityDigest)
    || typeof value.trusted !== 'boolean'
    || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw invalidStore();
  }
  return Object.freeze({
    source: 'trusted-ui',
    scope: value.scope as McpTrustScope,
    projectIdentity: value.projectIdentity as string | null,
    server: value.server,
    identityDigest: value.identityDigest,
    trusted: value.trusted,
    updatedAt: value.updatedAt,
  });
}

function storeVersion(entries: readonly McpTrustEntry[]): string {
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

async function readStore(path: string): Promise<StoreRead> {
  let bytes: Buffer;
  try { bytes = await readFile(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const store: McpTrustStore = { schemaVersion: 1, entries: [] };
      return { store, version: storeVersion(store.entries) };
    }
    throw new KernelRuntimeError('mcp_trust_store_read_failed', { cause: error });
  }
  if (bytes.byteLength > STORE_LIMIT_BYTES) throw new KernelError('mcp_trust_store_too_large');
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); } catch (cause) { throw invalidStore(cause); }
  if (!isRecord(value) || !onlyKeys(value, ['schemaVersion', 'entries']) || value.schemaVersion !== 1
    || !Array.isArray(value.entries) || value.entries.length > ENTRY_LIMIT) throw invalidStore();
  const entries = value.entries.map(validateEntry);
  const keys = entries.map((entry) => JSON.stringify([entry.scope, entry.projectIdentity, entry.server, entry.identityDigest]));
  if (new Set(keys).size !== keys.length) throw invalidStore();
  return { store: { schemaVersion: 1, entries }, version: storeVersion(entries), mode: (await stat(path)).mode & 0o777 };
}

export async function listMcpTrust(path = mcpTrustPathOf()): Promise<{ readonly version: string; readonly entries: readonly McpTrustEntry[] }> {
  const { store, version } = await readStore(resolve(path));
  return { version, entries: store.entries };
}

export async function setMcpServerTrust(path: string, input: {
  readonly scope: McpTrustScope;
  readonly projectRoot: string;
  readonly server: string;
  readonly identityDigest: string;
  readonly trusted: boolean;
}, expectedVersion: string): Promise<{ readonly version: string; readonly entries: readonly McpTrustEntry[] }> {
  if (!SCOPES.includes(input.scope) || typeof input.server !== 'string' || input.server === '' || input.server.length > 128
    || typeof input.identityDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(input.identityDigest)
    || typeof input.trusted !== 'boolean' || typeof input.projectRoot !== 'string' || !isAbsolute(input.projectRoot)) {
    throw new KernelError('mcp_trust_input_invalid');
  }
  let projectIdentity: string | null = null;
  if (input.scope === 'project') {
    try {
      const canonical = await realpath(resolve(input.projectRoot));
      if (!(await stat(canonical)).isDirectory()) throw new Error('not a directory');
      projectIdentity = workspaceIdentity(canonical);
    } catch (cause) { throw new KernelError('mcp_trust_project_invalid', { cause }); }
  }

  return withLockedAtomicFile(path, {
    lockStaleMs: LOCK_STALE_MS,
    lockRetries: { retries: 8, minTimeout: 10, maxTimeout: 100 },
    renameMaxAttempts: 8,
    renameMaxBackoffMs: 200,
    errors: {
      onLockFailed: (cause) => errorCode(cause) === 'ELOCKED'
        ? new KernelError('mcp_trust_store_locked', { cause })
        : new KernelRuntimeError('mcp_trust_store_lock_failed', { cause }),
      onLockLost: (cause) => new KernelRuntimeError('mcp_trust_store_lock_lost', { cause }),
      onUnlockFailed: (cause) => new KernelRuntimeError('mcp_trust_store_unlock_failed', { cause }),
      onReplaceFailed: (cause) => new KernelRuntimeError('mcp_trust_store_replace_failed', { cause }),
    },
    run: async ({ target }) => {
      const before = await readStore(target);
      if (expectedVersion !== before.version) throw new KernelError('mcp_trust_version_stale');
      const now = new Date().toISOString();
      const entry = validateEntry({
        source: 'trusted-ui',
        scope: input.scope,
        projectIdentity,
        server: input.server,
        identityDigest: input.identityDigest,
        trusted: input.trusted,
        updatedAt: now,
      });
      const same = (one: McpTrustEntry) => one.scope === entry.scope && one.projectIdentity === entry.projectIdentity
        && one.server === entry.server && one.identityDigest === entry.identityDigest;
      const entries = before.store.entries.some(same)
        ? before.store.entries.map((one) => same(one) ? entry : one)
        : [...before.store.entries, entry];
      if (entries.length > ENTRY_LIMIT) throw new KernelError('mcp_trust_entry_limit');
      const store: McpTrustStore = { schemaVersion: 1, entries };
      const bytes = Buffer.from(`${JSON.stringify(store)}\n`, 'utf8');
      if (bytes.byteLength > STORE_LIMIT_BYTES) throw new KernelError('mcp_trust_store_too_large');
      return {
        content: bytes,
        mode: before.mode ?? 0o600,
        beforeRename: async () => {
          if ((await readStore(target)).version !== before.version) throw new KernelError('mcp_trust_version_stale');
        },
        result: { version: storeVersion(entries), entries },
      };
    },
  });
}

export async function mcpServerTrust(path: string, projectRoot: string, server: string, identityDigest: string): Promise<McpTrustEntry | undefined> {
  let projectIdentity: string;
  try {
    const canonical = await realpath(resolve(projectRoot));
    if (!(await stat(canonical)).isDirectory()) throw new Error('not a directory');
    projectIdentity = workspaceIdentity(canonical);
  } catch (cause) { throw new KernelError('mcp_trust_project_invalid', { cause }); }
  const { store } = await readStore(resolve(path));
  const projectEntry = store.entries.find((entry) => entry.scope === 'project' && entry.projectIdentity === projectIdentity
    && entry.server === server && entry.identityDigest === identityDigest);
  if (projectEntry !== undefined) return projectEntry;
  return store.entries.find((entry) => entry.scope === 'user' && entry.server === server && entry.identityDigest === identityDigest);
}
