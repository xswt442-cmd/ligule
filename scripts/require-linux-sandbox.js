import { probeLinuxSandboxIsolation } from '../core/dist/capability/sandbox-linux.js';

if (process.platform !== 'linux') {
  throw new Error('the required Linux sandbox probe can run only on Linux');
}

const result = await probeLinuxSandboxIsolation();
if (!result.available) {
  process.stderr.write(`Linux sandbox unavailable: ${result.reason ?? 'the isolation probe failed'}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('Linux bubblewrap isolation probe passed.\n');
}
