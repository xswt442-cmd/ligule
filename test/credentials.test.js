import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  credentialStatus, deleteCredential, resolveCredential, storeCredential,
} from '../dist/kernel/credentials.js';

const temporaryRoot = fileURLToPath(new URL('../testplace/tmp/', import.meta.url));

function randomReference() {
  return `LIGULE_TEST_${randomUUID().replaceAll('-', '_').toUpperCase()}`;
}

function restoreEnvironment(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function assertSecret(actual, expected, message) {
  assert.equal(actual === expected, true, message);
}

async function withFixture(run) {
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(join(temporaryRoot, 'credentials-'));
  const homeA = join(directory, 'home-a');
  const homeB = join(directory, 'home-b');
  await mkdir(homeA);
  await mkdir(homeB);
  const previousHome = process.env.LIGULE_HOME;
  const reference = randomReference();
  const previousReference = process.env[reference];
  process.env.LIGULE_HOME = homeA;
  delete process.env[reference];
  try {
    return await run({ directory, homeA, homeB, reference });
  } finally {
    restoreEnvironment('LIGULE_HOME', previousHome);
    restoreEnvironment(reference, previousReference);
    await rm(directory, { recursive: true, force: true });
  }
}

test('credential references and values reject invalid input without exposing values', async () => {
  const invalidReferences = ['', '1INVALID', 'WITH-DASH', 'WITH\0NUL'];
  for (const reference of invalidReferences) {
    await assert.rejects(resolveCredential(reference), error => error.code === 'credential_reference_invalid');
    await assert.rejects(credentialStatus(reference), error => error.code === 'credential_reference_invalid');
    await assert.rejects(deleteCredential(reference), error => error.code === 'credential_reference_invalid');
  }
  await withFixture(async ({ reference }) => {
    const invalidValues = ['', 'contains\0nul', 'é'.repeat(8193), null];
    for (const value of invalidValues) {
      await assert.rejects(storeCredential(reference, value), error => {
        assert.equal(error.code, 'credential_value_invalid');
        if (typeof value === 'string' && value.length > 0) assert.equal(error.detail.includes(value), false);
        return true;
      });
    }
  });
});

test('a non-empty environment value takes precedence and rejects keyring mutation', async () => {
  await withFixture(async ({ reference }) => {
    const environmentValue = `environment-${randomUUID()}`;
    const previous = process.env[reference];
    process.env[reference] = environmentValue;
    try {
      assertSecret(await resolveCredential(reference), environmentValue, 'the environment credential should win');
      assert.deepEqual(await credentialStatus(reference), {
        reference,
        source: 'environment',
        configured: true,
      });
      await assert.rejects(storeCredential(reference, `replacement-${randomUUID()}`), error => error.code === 'credential_environment_override');
      await assert.rejects(deleteCredential(reference), error => error.code === 'credential_environment_override');
    } finally {
      restoreEnvironment(reference, previous);
    }
  });
});

