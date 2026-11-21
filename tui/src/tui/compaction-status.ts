// 压缩收尾的运行状态判定：迟到的 status.get 响应或读取失败不能覆盖更新的轮次状态。
export type CompactionStatus = { readonly apply: boolean; readonly running?: boolean };

export function applyCompactionStatus(
  requestGeneration: number,
  currentGeneration: number,
  latest: { readonly running?: boolean } | null,
): CompactionStatus {
  if (latest === null || requestGeneration !== currentGeneration) return { apply: false };
  return { apply: true, running: latest.running === true };
}

// 压缩占用会话时，队列必须暂停消费；消息留在队列里，压缩结束后再按顺序发送。
export function queueShouldSend(state: { readonly running: boolean; readonly compacting: boolean; readonly paused: boolean; readonly pending: number }): boolean {
  return !state.running && !state.compacting && !state.paused && state.pending > 0;
}

// 压缩进行中再次执行 /compact 会被 Host 拒绝，并且其状态刷新可能污染运行标记；先在本地拒绝。
export function compactionStartAllowed(compacting: boolean): boolean {
  return !compacting;
}
