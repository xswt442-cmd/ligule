/**
 * Orders the records a session view holds.
 *
 * The Host appends one record per sequence number and delivers each one to a
 * connected client. A view can still miss records: a live record may arrive
 * while its opening snapshot is in flight, the connection may drop between two
 * records, or a subscriber may attach late. This window keeps the highest
 * sequence already applied so the caller can ignore replays, and report a gap
 * before showing records out of order.
 */
export type WindowRecord = { seq?: number };


export type Incoming =
  | { apply: true }
  | { apply: false; reason: 'duplicate' }
  | { apply: false; reason: 'gap'; missingFrom: number; missingTo: number };

function seqOf(record: WindowRecord): number | undefined {
  const seq = record.seq;
  return Number.isSafeInteger(seq) && (seq as number) >= 1 ? seq as number : undefined;
}

export type RecoveryPage = { events: readonly WindowRecord[]; hasMore: boolean };

/**
 * The page to read next when the view misses records older than the page it holds.
 *
 * Returns `null` once the page reaches the missing range, or when the Host has no
 * earlier records: the caller should then show that the gap cannot be filled
 * instead of pretending the view is complete.
 */
export function olderRecoveryPage(page: RecoveryPage, missingFrom: number): { before: number } | null {
  const sequences = page.events.map(record => seqOf(record)).filter((seq): seq is number => seq !== undefined);
  if (sequences.length === 0) return null;
  const oldest = Math.min(...sequences);
  if (oldest <= missingFrom || !page.hasMore) return null;
  return { before: oldest };
}

export class SessionWindow<T extends WindowRecord = WindowRecord> {
  private through = 0;

  constructor(through = 0) {
    if (!Number.isSafeInteger(through) || through < 0) throw new TypeError('SessionWindow needs a non-negative sequence');
    this.through = through;
  }

  /** Highest sequence this view has applied; 0 before the first snapshot. */
  get loadedThrough(): number {
    return this.through;
  }

  /** Start a new snapshot: everything at or below `through` is already shown. */
  reset(through: number): void {
    if (!Number.isSafeInteger(through) || through < 0) throw new TypeError('SessionWindow needs a non-negative sequence');
    this.through = through;
  }

  /** Records without a usable sequence number cannot be ordered; show them as they arrive. */
  incoming(record: T): Incoming {
    const seq = seqOf(record);
    if (seq === undefined) return { apply: true };
    if (seq <= this.through) return { apply: false, reason: 'duplicate' };
    if (seq === this.through + 1) {
      this.through = seq;
      return { apply: true };
    }
    return { apply: false, reason: 'gap', missingFrom: this.through + 1, missingTo: seq - 1 };
  }

  /**
   * Mark fetched records as applied and return the ones this view did not hold.
   *
   * The batch has to continue at `loadedThrough + 1`; the first record beyond a
   * gap stops the adoption, so the caller can fetch the older page and try
   * again instead of silently skipping records.
   */
  adopt(records: readonly T[]): T[] {
    const fresh: T[] = [];
    for (const record of records) {
      const seq = seqOf(record);
      if (seq === undefined) { fresh.push(record); continue; }
      if (seq <= this.through) continue;
      if (seq !== this.through + 1) break;
      this.through = seq;
      fresh.push(record);
    }
    return fresh;
  }
}
