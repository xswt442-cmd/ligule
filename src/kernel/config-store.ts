// 宿主持有的那两格配置读写口（方案 7.2）：层名到文件的对应关系在这里，界面上的说法只到层名。
// 可写的只有两层：使用者默认那一份，与当前项目的本机覆盖那一份。项目共享的 `config.toml` 不在这一批里，
// 那个文件跟着仓库走，改它等于替别人改（7.2 表里那一格写的是本机覆盖）。命令行与管理端那两层是只读的。
import { configPaths } from './config-file.js';
import { KernelError } from './error.js';
import { readConfigVersion, writeConfigField } from './config-edit.js';

const LAYERS = ['user', 'projectLocal'];

export function createConfigStore({ projectRoot, userHome }: { projectRoot: string; userHome?: string }) {
  const files = configPaths(projectRoot, userHome);
  const pathOf = (layer: string): string => {
    if (layer === 'user') return files.user;
    if (layer === 'projectLocal') return files.local;
    throw new KernelError('config_layer_unknown', { detail: `writable layers: ${LAYERS.join(', ')}` });
  };
  return {
    // 每一层现在那一份文件的版本：界面读回来带着它，写的时候交回来核对。文件不在时版本是空串。
    async list() {
      return Promise.all(LAYERS.map(async (layer) => {
        const version = await readConfigVersion(pathOf(layer));
        return { layer, version, exists: version !== '' };
      }));
    },
    write({ layer, field, value, version }: { layer: string; field: string; value: string; version: string }) {
      return writeConfigField(pathOf(layer), field, value, version);
    },
  };
}
