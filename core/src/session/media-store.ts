import { createMediaStore as createStorage } from '../capability/media.js';
import { parseSessionBytes } from './record.js';

export function createMediaStore(...args: Parameters<typeof createStorage>) {
  const storage = createStorage(...args);
  return {
    ...storage,
    advanceSessionScan: (scan: Parameters<typeof storage.advanceSessionScan>[0]) => storage.advanceSessionScan(scan, parseSessionBytes),
    cleanup: (options?: Parameters<typeof storage.cleanup>[1]) => storage.cleanup(parseSessionBytes, options),
  };
}
