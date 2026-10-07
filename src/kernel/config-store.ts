// 宿主持有的那两格配置读写口（方案 7.2 与 7.1）：层名到文件的对应关系在这里，界面上的说法只到层名。
// 可写的只有两层：使用者默认那一份，与当前项目的本机覆盖那一份。项目共享的 `config.toml` 不在这一批里，
// 那个文件跟着仓库走，改它等于替别人改（7.2 表里那一格写的是本机覆盖）。命令行与管理端那两层是只读的。
// 只读那一层还管着一件事：值本来就是它写的话，改文件盖不过它（D8 的次序、方案 7.1 的「不能声称改低层文件即可生效」）。
import { configPaths } from './config-file.js';
import { EDITABLE, editableField, readConfigVersion, writeConfigField } from './config-edit.js';
import { KernelError } from './error.js';

const LAYERS = ['user', 'projectLocal'];
// 从最高优先级往下找那一个键落在哪一层：命令行盖过本机覆盖，本机覆盖盖过项目共享，项目共享盖过使用者默认（D8）。
const PRECEDENCE = ['flag', 'local', 'project', 'user'] as const;
type Source = typeof PRECEDENCE[number] | 'none';

/** 装载那一次读到的四层对象；写成功之后这一份跟着改，来源才不会停在启动那一刻。 */
export type LoadedLayers = Partial<Record<typeof PRECEDENCE[number], Record<string, unknown>>>;

const inLayer = (layer: Record<string, unknown> | undefined, path: readonly string[]): boolean => {
  let node: unknown = layer;
  for (const part of path) {
    if (typeof node !== 'object' || node === null || !(part in node)) return false;
    node = (node as Record<string, unknown>)[part];
  }
  return true;
};

export function createConfigStore({ projectRoot, userHome, layers = {} }: { projectRoot: string; userHome?: string; layers?: LoadedLayers }) {
  const files = configPaths(projectRoot, userHome);
  const pathOf = (layer: string): string => {
    if (layer === 'user') return files.user;
    if (layer === 'projectLocal') return files.local;
    throw new KernelError('config_layer_unknown', { detail: `writable layers: ${LAYERS.join(', ')}` });
  };
  // 界面上那一个层名与装载侧那一份键的对应：`projectLocal` 写的就是 `local` 那一层。
  const keyOfLayer = (layer: string) => (layer === 'user' ? 'user' : 'local');
  const sourceOf = (field: string): Source => {
    const path = editableField(field).path;
    return PRECEDENCE.find((layer) => inLayer(layers[layer], path)) ?? 'none';
  };
  return {
    // 每一层现在那一份文件的版本：界面读回来带着它，写的时候交回来核对。文件不在时版本是空串。
    async list() {
      return Promise.all(LAYERS.map(async (layer) => {
        const version = await readConfigVersion(pathOf(layer));
        return { layer, version, exists: version !== '' };
      }));
    },
    // 白名单里每一条现在由哪一层写着（方案 7.1 的来源那一格）。`flag` 是命令行 `--config` 写的那一层，只读。
    sources() {
      return Object.fromEntries(Object.keys(EDITABLE).map((field) => [field, sourceOf(field)]));
    },
    write({ layer, field, value, version }: { layer: string; field: string; value: string; version: string }) {
      const definition = editableField(field);
      return writeConfigField(pathOf(layer), field, value, version).then((written) => {
        const holder = layers[keyOfLayer(layer)] ?? {};
        const table = (holder[definition.path[0]] ?? {}) as Record<string, unknown>;
        table[definition.path[1]] = value;
        holder[definition.path[0]] = table;
        layers[keyOfLayer(layer)] = holder;
        return {
          ...written,
          // 那一个字段落在提供方配置的哪一格上：宿主按这一格重算提供方，不必知道白名单的全表（方案 7.3）。
          key: definition.path[1],
          // 值本来就是只读那一层写的话，这一笔改了也盖不过它——宿主因此不动正在跑的提供方，界面另说一句。
          shadowed: sourceOf(field) === 'flag',
        };
      });
    },
  };
}
