// 关闭流程不能无限等待一个卡住的轮次；给等待加上限，超时后继续释放进程与记录锁。
export const SETTLE_GRACE_MS = 10_000;

// 返回 `false` 表示等待超时，调用方据此记录诊断后继续收尾；被等待的 Promise 自身失败也视为已结束。
export async function settleWithin(
  promise: Promise<unknown> | undefined,
  graceMs: number = SETTLE_GRACE_MS,
  onTimeout?: () => void,
): Promise<boolean> {
  if (promise === undefined) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => { onTimeout?.(); resolve(false); }, graceMs);
    timer.unref?.();
  });
  const settled = promise.then(() => true, () => true);
  try {
    return await Promise.race([settled, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // 超时后轮到被等待的 Promise 结束时不产生未处理的拒绝。
    void settled.catch(() => undefined);
  }
}
