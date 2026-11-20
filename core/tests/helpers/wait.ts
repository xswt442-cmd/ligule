import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

/** Wait until a test-owned endpoint stops accepting connections. */
export async function waitForUnavailable(url: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      await response.body?.cancel();
    } catch {
      return;
    }
    await delay(20);
  }
  assert.fail(`server at ${url} remained reachable`);
}
