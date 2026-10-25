// 本次运行使用的插件由显式清单决定。
// 此模块按清单顺序加载插件，并在关闭时按逆序卸载。
// Kernel 本身不提供工具；工具由插件注册。
import { KernelError } from './error.js';

export interface Plugin<TKernel> {
  readonly name: string;
  setup(kernel: TKernel): unknown;
}

export interface Assembly {
  list(): string[];
  dispose(): void;
}

export function loadAssembly<TKernel>(kernel: TKernel, manifest: readonly Plugin<TKernel>[]): Assembly {
  if (!Array.isArray(manifest)) throw new KernelError('assembly_manifest_must_be_array');
  const installed: { name: string; dispose: () => void }[] = [];
  const names = new Set<string>();

  // 按加载顺序逆序卸载插件。
  function unwind() {
    const errors: unknown[] = [];
    while (installed.length > 0) {
      try {
        installed.pop()?.dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  }

  try {
    for (const plugin of manifest) {
      if (!plugin || typeof plugin.name !== 'string' || plugin.name === '') {
        throw new KernelError('plugin_name_required');
      }
      if (typeof plugin.setup !== 'function') {
        throw new KernelError('plugin_setup_required');
      }
      // 拒绝重复插件名称，确保登记与实际加载结果一致。
      if (names.has(plugin.name)) throw new KernelError('plugin_name_duplicate');
      // 每个插件必须提供卸载函数，确保关闭时清除其注册内容。
      const dispose = plugin.setup(kernel);
      if (typeof dispose !== 'function') throw new KernelError('plugin_dispose_required');
      names.add(plugin.name);
      installed.push({ name: plugin.name, dispose });
    }
  } catch (error) {
    // 加载失败时卸载已成功加载的插件，再抛出原始错误。
    const cleanupErrors = unwind();
    if (cleanupErrors.length > 0) throw new AggregateError([error, ...cleanupErrors], 'assembly setup and cleanup failed');
    throw error;
  }

  return {
    // 返回本次运行已加载的插件名称。
    list() {
      return installed.map((entry) => entry.name);
    },
    dispose() {
      const errors = unwind();
      if (errors.length > 0) throw new AggregateError(errors, 'assembly cleanup failed');
    },
  };
}
