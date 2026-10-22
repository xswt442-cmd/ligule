import type { Client } from './protocol';
import type { Record_ } from './rows';

type Snapshot = { events: Record_[]; hasMore: boolean; writerActive: boolean };

export function observeExternalSession({ client, projectRoot, sessionId, limit, isCurrent, onSnapshot }: {
  client: Client;
  projectRoot: string;
  sessionId: string;
  limit: number;
  isCurrent: () => boolean;
  onSnapshot: (snapshot: Snapshot) => void;
}): () => void {
  let disposed = false;
  let inFlight = false;
  const refresh = async () => {
    if (disposed || inFlight) return;
    inFlight = true;
    try {
      const snapshot = await client.call('session.observe', {
        projectRoot, sessionId, limit, fullResults: true,
      }, 10_000) as Snapshot;
      if (disposed || !isCurrent()) return;
      onSnapshot(snapshot);
    } catch {
      // A failed read-only poll leaves the last observed snapshot in place.
    } finally {
      inFlight = false;
    }
  };
  void refresh();
  const timer = setInterval(() => void refresh(), 1_000);
  return () => { disposed = true; clearInterval(timer); };
}
