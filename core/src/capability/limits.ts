// 文件边界和工具上限来自配置快照；工具本身不读取其他配置来源。
// 默认值由项目维护，配置层可以逐字段覆盖。
import { KernelError } from '../kernel/error.js';
import { resolve } from 'node:path';
// 以下为各工具默认上限，配置层可以逐字段覆盖。
export const DEFAULT_LIMITS = Object.freeze({
  readBytes: 64_000,
  resultCount: 200,
  scanBytes: 2_000_000,
  scanFiles: 5_000,
  execBytes: 32_000,
  execTimeoutMs: 120_000,
  trashDirectory: '.ligule-trash',
  // 技能搜索、正文和文件读取分别设有上限；总工具结果上限仍会进一步约束注入模型的内容。
  skillSearchBytes: 8_000,
  skillBodyBytes: 24_000,
  skillFileBytes: 64_000,
  // 网络读取的响应字节数、超时时间和重定向次数上限。
  fetchBytes: 64_000,
  fetchTimeoutMs: 15_000,
  fetchRedirects: 5,
  documentBytes: 20 * 1024 * 1024,
  documentOutputBytes: 24_000,
  documentTimeoutMs: 15_000,
  // 扩展提示词片段的字节预算；模型输入的总量上限仍然适用。
  promptFragmentBytes: 8_000,
  // 上下文压缩的压力阈值和保留预算比例。
  // 上下文窗口由模型声明，不设置全局默认值；Host 无法确定窗口时不启用压缩。
  compactThresholdRatio: 0.8,
  compactRetainRatio: 0.16,
});

export type CapabilityLimits = Partial<typeof DEFAULT_LIMITS> & {
  contextTokens?: number;
  resultBytes?: number;
};

export type CapabilityConfig = {
  boundary?: string;
  workspaceRoot?: string;
  limits?: CapabilityLimits;
};

// 文件搜索默认跳过依赖和版本控制目录，避免扫描大量无关文件。
const SKIPPED_DIRECTORIES: readonly string[] = ['node_modules', '.git'];

// 搜索也会跳过配置指定的回收目录，避免再次返回已删除文件。
// 目录名称可以配置，所有搜索后端都从此函数读取。
export function skippedDirectories(config: CapabilityConfig): string[] {
  return [...SKIPPED_DIRECTORIES, limitsOf(config).trashDirectory];
}

export function boundaryOf(config: CapabilityConfig): string {
  const boundary = typeof config.workspaceRoot === 'string' && config.workspaceRoot !== ''
    ? resolve(config.workspaceRoot, config.boundary ?? '.')
    : config.boundary;
  if (typeof boundary !== 'string' || boundary === '') {
    throw new KernelError('boundary_required', { detail: 'the host configured no workspace boundary, so file tools have nowhere to work' });
  }
  return boundary;
}

export function workingDirectoryOf(config: CapabilityConfig): string {
  return config.workspaceRoot ?? boundaryOf(config);
}

export function limitsOf(config: CapabilityConfig): typeof DEFAULT_LIMITS & { contextTokens?: number; resultBytes?: number } {
  return { ...DEFAULT_LIMITS, ...config.limits };
}
