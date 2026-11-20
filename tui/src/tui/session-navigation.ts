export interface SessionNavigationLease {
  readonly token: number;
  readonly owner: string;
}

export interface SessionNavigationEnvironment {
  /** True while the view can still update; a dead view never owns a switch. */
  readonly alive: () => boolean;
  /** The session the view currently shows, or null before the first one opens. */
  readonly activeSession: () => string | null;
}

export interface SessionNavigation {
  /** The lease that owns the current switch, or 0 when none is running. */
  readonly activeToken: number;
  /** True once the view has entered its first session; later entries bump. */
  entered(): boolean;
  /** Invalidates every outstanding lease, for example after leaving a session. */
  invalidate(): void;
  /** Claims the navigation slot, or returns undefined while another switch runs. */
  begin(owner: string): SessionNavigationLease | undefined;
  /** True only for the lease that still owns the view and its session. */
  isCurrent(lease: SessionNavigationLease): boolean;
  /** Releases the slot; returns false when a newer lease already replaced it. */
  finish(lease: SessionNavigationLease): boolean;
}

/**
 * Tracks which asynchronous session switch may still write to the view.
 * Each begin bumps the generation, so an older lease stops being current even
 * when it never calls finish.
 */
export function createSessionNavigation(environment: SessionNavigationEnvironment): SessionNavigation {
  let generation = 0;
  let activeToken = 0;
  let mounted = false;

  return {
    get activeToken() {
      return activeToken;
    },
    entered() {
      if (!mounted) {
        mounted = true;
        return false;
      }
      generation += 1;
      return true;
    },
    invalidate() {
      generation += 1;
    },
    begin(owner: string) {
      if (activeToken !== 0) return undefined;
      const token = ++generation;
      activeToken = token;
      return { token, owner };
    },
    isCurrent(lease: SessionNavigationLease) {
      return environment.alive() && activeToken === lease.token && generation === lease.token
        && environment.activeSession() === lease.owner;
    },
    finish(lease: SessionNavigationLease) {
      if (activeToken !== lease.token) return false;
      activeToken = 0;
      return true;
    },
  };
}
