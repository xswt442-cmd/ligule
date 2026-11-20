import { randomUUID } from 'node:crypto';

/** An environment variable name that no other test run shares. */
export function randomReference(): string {
  return `LIGULE_TEST_${randomUUID().replaceAll('-', '_').toUpperCase()}`;
}

/** Put an environment variable back the way the test found it. */
export function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
