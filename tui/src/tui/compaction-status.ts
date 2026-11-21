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
