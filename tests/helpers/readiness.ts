import type { Connection } from '../../core/dist/host/connection.js';

// A host finishes sandbox and permission probing before it answers the first request. On Windows
// that costs seconds to tens of seconds depending on the workspace size (measured here: about
// 6.4s for a small workspace, about 25s for this repository). The readiness phase gets its own
// allowance while every protocol request after it keeps the 10s deadline, which tells "the host
// never started" apart from "the request is slow" without enlarging the product timeout.
export const STARTUP_READY_MS = 60_000;

export async function ready(client: Connection, label = 'Host'): Promise<void> {
  const limit = Date.now() + STARTUP_READY_MS;
  for (;;) {
    const answered = await Promise.race([
      client.request('prefs.read', {}).then(() => true, () => false),
      new Promise(resolve => setTimeout(() => resolve(false), 1_000)),
    ]);
    if (answered) return;
    if (Date.now() > limit) throw new Error(`${label} did not answer within ${STARTUP_READY_MS}ms`);
  }
}
