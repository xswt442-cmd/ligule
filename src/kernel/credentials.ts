import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { KernelError } from './error.js';
import { dataRoot } from './config-file.js';

const SERVICE = 'ligule';
const MAX_SECRET_BYTES = 16 * 1024;
const REFERENCE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type CredentialStatus = {
  reference: string;
  source: 'environment' | 'keyring' | 'missing';
  configured: boolean;
};

type KeyringEntry = {
  getPassword(): Promise<string | null>;
  setPassword(value: string): Promise<void>;
  deletePassword(): Promise<boolean>;
};

function validateReference(reference: unknown): asserts reference is string {
  if (typeof reference !== 'string' || reference.length > 128 || !REFERENCE_PATTERN.test(reference)) {
    throw new KernelError('credential_reference_invalid', { detail: 'reference must be a POSIX environment variable name' });
  }
}

function validateSecret(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || Buffer.byteLength(value, 'utf8') > MAX_SECRET_BYTES) {
    throw new KernelError('credential_value_invalid', { detail: 'credential value must be non-empty, contain no NUL, and fit within 16 KiB' });
  }
}

function environmentValue(reference: string): string | undefined {
  const value = process.env[reference];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

async function canonicalDataRoot(): Promise<string> {
  const requested = resolve(dataRoot());
  const missing: string[] = [];
  let candidate = requested;
  while (true) {
    try {
      let canonical = await realpath(candidate);
      for (let index = missing.length - 1; index >= 0; index -= 1) canonical = resolve(canonical, missing[index]);
      if (process.platform !== 'win32') return canonical;
      const stripped = canonical.replace(/^\\\\\?\\/, '').replace(/[\\/]+$/, '');
      const rooted = /^[A-Za-z]:$/.test(stripped) ? `${stripped}\\` : stripped;
      return rooted.toLowerCase();
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
        const parent = dirname(candidate);
        if (parent === candidate) break;
        missing.push(basename(candidate));
        candidate = parent;
        continue;
      }
      throw new KernelError('credential_store_unavailable', {
        cause: error,
        detail: 'the credential account could not be derived from the data root',
      });
    }
  }
  throw new KernelError('credential_store_unavailable', {
    detail: 'the credential account could not be derived from the data root',
  });
}

async function withEntry<T>(reference: string, operation: (entry: KeyringEntry) => Promise<T>): Promise<T> {
  const root = await canonicalDataRoot();
  const rootDigest = createHash('sha256').update(root, 'utf8').digest('hex');
  try {
    const { AsyncEntry } = await import('@napi-rs/keyring');
    const entry = new AsyncEntry(SERVICE, `${rootDigest}:${reference}`, {
      linux: { store: 'secret-service' },
    });
    return await operation(entry);
  } catch (cause) {
    throw new KernelError('credential_store_unavailable', {
      cause,
      detail: 'the system credential store could not complete the operation',
    });
  }
}

export async function resolveCredential(reference: string): Promise<string | undefined> {
  validateReference(reference);
  const fromEnvironment = environmentValue(reference);
  if (fromEnvironment !== undefined) return fromEnvironment;
  return withEntry(reference, async (entry) => {
    const value = await entry.getPassword();
    return value === null || value.length === 0 ? undefined : value;
  });
}

export async function credentialStatus(reference: string): Promise<CredentialStatus> {
  validateReference(reference);
  if (environmentValue(reference) !== undefined) {
    return { reference, source: 'environment', configured: true };
  }
  const value = await withEntry(reference, entry => entry.getPassword());
  const configured = value !== null && value.length > 0;
  return { reference, source: configured ? 'keyring' : 'missing', configured };
}

export async function storeCredential(reference: string, value: string): Promise<void> {
  validateReference(reference);
  validateSecret(value);
  if (environmentValue(reference) !== undefined) {
    throw new KernelError('credential_environment_override', { detail: 'the launching environment supplies this credential reference' });
  }
  await withEntry(reference, entry => entry.setPassword(value));
}

export async function deleteCredential(reference: string): Promise<boolean> {
  validateReference(reference);
  if (environmentValue(reference) !== undefined) {
    throw new KernelError('credential_environment_override', { detail: 'the launching environment supplies this credential reference' });
  }
  return withEntry(reference, entry => entry.deletePassword());
}
