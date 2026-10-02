// 一次运行装哪些插件，由这一处显式清单决定（I2、D7 里有状态那一层的装配职责）。
// 清单是代码里的数组：读配置文件属于装载侧后面的步骤，这里只管按顺序装与按顺序撤。
// 内核自己不提供任何工具（I1），能力全部由清单里的每一项 setup 时登记进来。
import { KernelError } from './error.js';

export function loadAssembly(kernel, manifest) {
  if (!Array.isArray(manifest)) throw new KernelError('assembly_manifest_must_be_array');
  const installed = [];
  const names = new Set();

  // 逆序撤：最后装上的最先撤，插件自己的反注册动作决定它留下什么。
  function unwind() {
    while (installed.length > 0) installed.pop().dispose();
  }

  try {
    for (const plugin of manifest) {
      if (!plugin || typeof plugin.name !== 'string' || plugin.name === '') {
        throw new KernelError('plugin_name_required');
      }
      if (typeof plugin.setup !== 'function') {
        throw new KernelError('plugin_setup_required');
      }
      // 同名两项会让清单读出来的与实际装上的不是同一回事。
      if (names.has(plugin.name)) throw new KernelError('plugin_name_duplicate');
      // 每一项必须交出反注册动作，否则卸载时它会悄悄留下东西。
      const dispose = plugin.setup(kernel);
      if (typeof dispose !== 'function') throw new KernelError('plugin_dispose_required');
      names.add(plugin.name);
      installed.push({ name: plugin.name, dispose });
    }
  } catch (error) {
    // 装载中途失败不留半装的表：已经装上的全部撤掉，再把原错误交出去。
    unwind();
    throw error;
  }

  return {
    // 本次运行装了哪些插件，从这一处读出（I2）。
    list() {
      return installed.map((entry) => entry.name);
    },
    dispose() {
      unwind();
    },
  };
}
