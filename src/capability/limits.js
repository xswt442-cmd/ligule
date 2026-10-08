// 边界与上限：工具能看见多少、能到哪里，都由配置快照说了算，工具自己不读别处（D8）。
// 起点值由本项目自定，配置层可以逐键覆盖；分页单位与标记措辞没有外部来源。
import { KernelError } from '../kernel/error.js';
// 起点值由本项目自定，配置层可以逐键覆盖；分页单位与标记措辞没有外部来源。
export const DEFAULT_LIMITS = Object.freeze({
  readBytes: 64_000,
  resultCount: 200,
  scanBytes: 2_000_000,
  scanFiles: 5_000,
  execBytes: 32_000,
  trashDirectory: '.ligule-trash',
  // 技能那三个动作各自的结果上限，数值记在 D55；注入那一层的总量上限（resultBytes）仍然压在这三条之上。
  skillSearchBytes: 8_000,
  skillBodyBytes: 24_000,
  skillFileBytes: 64_000,
  // 取回一件的三条（D58）：响应字节上限、超时与最多跟几跳。
  fetchBytes: 64_000,
  fetchTimeoutMs: 15_000,
  fetchRedirects: 5,
  // 扩展登记的一段提示词片段的预算（D69）：与技能元数据那一条同一档，注入那一层的总量上限仍然压在它上面。
  promptFragmentBytes: 8_000,
  // 压缩的两条比例（D75）：这是策略参数，给缺省，从 0.8 与 0.16 起步（U43）。
  // 窗口大小不给缺省：那是模型事实，猜小了白压、猜大了连摘要请求自己都会超窗，
  // 所以 `limits.contextTokens` 没写时两条触发都不启用，正常聊天照跑（D75 修订，2026-10-05 定）。
  compactThresholdRatio: 0.8,
  compactRetainRatio: 0.16,
});

// 遍历跳过这些目录：它们的内容不是要找的东西，扫过去只会把上限用光。
const SKIPPED_DIRECTORIES = ['node_modules', '.git'];

// 回收站那个目录也在跳过之列：隐藏目录现在搜得到，删掉的东西不该再以第二次命中出现。
// 名字可以由配置改，所以两条后端都得从配置取，不能写死。
export function skippedDirectories(config) {
  return [...SKIPPED_DIRECTORIES, limitsOf(config).trashDirectory];
}

export function boundaryOf(config) {
  if (typeof config.boundary !== 'string' || config.boundary === '') {
    throw new KernelError('boundary_required', { detail: 'the host configured no workspace boundary, so file tools have nowhere to work' });
  }
  return config.boundary;
}

export function limitsOf(config) {
  return { ...DEFAULT_LIMITS, ...config.limits };
}
