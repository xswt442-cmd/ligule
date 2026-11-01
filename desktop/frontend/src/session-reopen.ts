// 重连后需要重新取得会话写入权：上个 Host 可能刚被强杀，锁租约还没过期。
// 这里按固定节奏重试到预算用完，避免直接落到只读观察而让用户以为会话没恢复。
export type ReopenOutcome =
  | { readonly kind: 'opened' }
  | { readonly kind: 'locked'; readonly waitedMs: number }
  | { readonly kind: 'failed'; readonly code: string };

export type ReopenOptions = {
  readonly open: () => Promise<void>;
  readonly code: (error: unknown) => string;
  readonly isLocked: (code: string) => boolean;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly budgetMs: number;
  readonly retryMs?: number;
};

// 锁的租约只有十秒量级，重试间隔取半秒即可覆盖；预算耗尽时把结果交给调用方决定怎么提示。
export async function reopenSessionWriter(options: ReopenOptions): Promise<ReopenOutcome> {
  const retryMs = options.retryMs ?? 500;
  const start = options.now();
  for (;;) {
    try {
      await options.open();
      return { kind: 'opened' };
    } catch (error) {
      const failure = options.code(error);
      if (!options.isLocked(failure)) return { kind: 'failed', code: failure };
      if (options.now() - start >= options.budgetMs) return { kind: 'locked', waitedMs: options.now() - start };
      await options.sleep(retryMs);
    }
  }
}
