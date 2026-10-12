import { createHash } from 'node:crypto';
import { resolveCredential } from '../../dist/kernel/credentials.js';

const value = await resolveCredential(process.env.LIGULE_CREDENTIAL_TEST_REFERENCE);
if (value === undefined || createHash('sha256').update(value).digest('hex') !== process.env.LIGULE_CREDENTIAL_TEST_DIGEST) {
  throw new Error('the credential did not persist across processes');
}
process.stdout.write('credential persisted\n');
