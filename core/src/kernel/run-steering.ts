import { randomUUID } from 'node:crypto';
import { KernelError } from './error.js';
import type { SessionLog } from '../session/session.js';

const MAX_PENDING_INPUTS = 16;
const MAX_INPUT_LENGTH = 65_536;

export interface RunSteeringInput {
  readonly inputId: string;
  readonly runId: string;
  readonly source: 'human' | 'controller';
  readonly text: string;
  readonly acceptedAt: string;
}

export interface RunSteeringInbox {
  activate(): void;
  accept(source: RunSteeringInput['source'], text: string, onAccepted?: () => void): Promise<{
    readonly inputId: string;
    readonly runId: string;
    readonly state: 'accepted';
    readonly source: RunSteeringInput['source'];
    readonly pendingCount: number;
  }>;
  applyPending(): Promise<readonly RunSteeringInput[]>;
  startWork<TResult>(start: () => TResult): Promise<{ readonly started: true; readonly value: TResult } | { readonly started: false }>;
  startToolGroup<TResult>(start: () => TResult): Promise<{ readonly started: true; readonly value: TResult } | { readonly started: false }>;
  finishIfIdle(): Promise<boolean>;
  close(state: 'cancelled' | 'invalidated'): Promise<void>;
}

export function createRunSteeringInbox(session: SessionLog, runId: string): RunSteeringInbox {
  let active = false;
  let accepting = true;
  let closed = false;
  const pending: RunSteeringInput[] = [];
  let writes: Promise<unknown> = Promise.resolve();

  function serialize<TResult>(action: () => Promise<TResult> | TResult): Promise<TResult> {
    const result = writes.then(action, action);
    writes = result.then(() => undefined, () => undefined);
    return result;
  }

  async function applyPending(): Promise<RunSteeringInput[]> {
    const applied: RunSteeringInput[] = [];
    while (pending.length > 0) {
      const input = pending[0];
      await session.append({
        kind: 'runInput', mode: 'steer', state: 'applied', inputId: input.inputId, runId,
        appliedAt: new Date().toISOString(),
      });
      pending.shift();
      applied.push(input);
    }
    return applied;
  }

  return {
    activate() {
      if (closed) throw new KernelError('run_steer_not_ready');
      active = true;
    },
    accept(source, text, onAccepted) {
      if (typeof text !== 'string' || text.trim() === '' || text.length > MAX_INPUT_LENGTH) {
        return Promise.reject(new KernelError('run_steer_input_invalid'));
      }
      return serialize(async () => {
        if (closed || !accepting) throw new KernelError('run_not_running');
        if (!active) throw new KernelError('run_steer_not_ready');
        if (pending.length >= MAX_PENDING_INPUTS) throw new KernelError('run_steer_limit_exceeded');
        const input: RunSteeringInput = {
          inputId: randomUUID(), runId, source, text, acceptedAt: new Date().toISOString(),
        };
        await session.append({
          kind: 'runInput', mode: 'steer', state: 'accepted', inputId: input.inputId, runId,
          source, text, acceptedAt: input.acceptedAt,
        });
        pending.push(input);
        onAccepted?.();
        return { inputId: input.inputId, runId, state: 'accepted', source, pendingCount: pending.length };
      });
    },
    applyPending: () => serialize(applyPending),
    startWork: (start) => serialize(async () => {
      if (closed || !accepting || !active) throw new KernelError('run_not_running');
      if (pending.length > 0) {
        await applyPending();
        return { started: false as const };
      }
      return { started: true as const, value: start() };
    }),
    startToolGroup: (start) => serialize(() => {
      if (closed || !accepting || !active) throw new KernelError('run_not_running');
      if (pending.length > 0) return { started: false as const };
      return { started: true as const, value: start() };
    }),
    finishIfIdle: () => serialize(() => {
      if (pending.length > 0) return false;
      accepting = false;
      closed = true;
      return true;
    }),
    close: (state) => serialize(async () => {
      if (closed) return;
      accepting = false;
      while (pending.length > 0) {
        const input = pending[0];
        await session.append({
          kind: 'runInput', mode: 'steer', state, inputId: input.inputId, runId,
          [`${state}At`]: new Date().toISOString(),
        });
        pending.shift();
      }
      closed = true;
    }),
  };
}
