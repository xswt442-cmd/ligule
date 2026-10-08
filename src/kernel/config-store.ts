// 宿主持有的那两格配置读写口（方案 7.2 与 7.1）：层名到文件的对应关系在这里，界面上的说法只到层名。
// 可写的只有两层：使用者默认那一份，与当前项目的本机覆盖那一份。项目共享的 `config.toml` 不在这一批里，
// 那个文件跟着仓库走，改它等于替别人改（7.2 表里那一格写的是本机覆盖）。命令行与管理端那两层是只读的。
// 只读那一层还管着一件事：值本来就是它写的话，改文件盖不过它（D8 的次序、方案 7.1 的「不能声称改低层文件即可生效」）。
import { configPaths } from './config-file.js';
import {
  EDITABLE,
  editableField,
  readConfigRules,
  readConfigVersion,
  writeConfigField,
  type PolicyRule,
  type WriteRequest,
} from './config-edit.js';
import { KernelError } from './error.js';

const LAYERS = ['user', 'projectLocal'];
// 从最高优先级往下找那一个键落在哪一层：命令行盖过本机覆盖，本机覆盖盖过项目共享，项目共享盖过使用者默认（D8）。
const PRECEDENCE = ['flag', 'local', 'project', 'user'] as const;
type Source = typeof PRECEDENCE[number] | 'none';

/** 装载那一次读到的四层对象；写成功之后这一份跟着改，来源才不会停在启动那一刻。 */
export type LoadedLayers = Partial<Record<(typeof PRECEDENCE)[number], Record<string, unknown>>>;

const inLayer = (layer: Record<string, unknown> | undefined, path: readonly string[]): boolean => {
  let node: unknown = layer;
  for (const part of path) {
    if (typeof node !== 'object' || node === null || !(part in node)) return false;
    node = (node as Record<string, unknown>)[part];
  }
  return true;
};

// 规则表里的一条在画面上排第几，说的是那一张数组表的顺序：界面上「第 3 条」与文件里第三个 `[[policy.rules]]` 是同一件事。
const RULES_FIELD = 'policy.rules';

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
  // 折完那一张规则表：数组整份替换（D8 的合并语义），所以生效的那一份出自最高的那一层。
  const effectiveRules = (): PolicyRule[] => {
    for (const layer of PRECEDENCE) {
      const rules = (layers[layer]?.policy as Record<string, unknown> | undefined)?.rules;
      if (Array.isArray(rules)) return rules as PolicyRule[];
    }
    return [];
  };
  return {
    // 每一层现在那一份文件的版本：界面读回来带着它，写的时候交回来核对。文件不在时版本是空串。
    // 规则表那一格只有写着它的那一层才交回，别的层没有这一张表就是没有，不交回一份空数组让人以为被盖住了。
    async list() {
      return Promise.all(
        LAYERS.map(async (layer) => {
          const version = await readConfigVersion(pathOf(layer));
          const written = inLayer(layers[keyOfLayer(layer)], ['policy', 'rules']);
          return { layer, version, exists: version !== '', ...(written ? { rules: await readConfigRules(pathOf(layer)) } : {}) };
        }),
      );
    },
    // 白名单里每一条现在由哪一层写着（方案 7.1 的来源那一格）。`flag` 是命令行 `--config` 写的那一层，只读。
    sources() {
      return Object.fromEntries(Object.keys(EDITABLE).map((field) => [field, sourceOf(field)]));
    },
    // 现在生效的那一张规则表与它出自哪一层（方案 7.1 的三种读数）：界面上列规则、改规则都读这一份。
    rules() {
      return { rules: effectiveRules(), rulesSource: sourceOf(RULES_FIELD) };
    },
    write(request: WriteRequest & { layer: string }) {
      const definition = editableField(request.field);
      const file = pathOf(request.layer);
      // 规则表整份替换（D8 的合并语义），所以在哪一层写就只可能是写着生效那一份的那一层：
      // 往另一层加一条，交回的是「只有这一条」的表，改一条也指不到生效那一份里的第几条。
      if (definition.kind === 'rules') {
        const source = sourceOf(RULES_FIELD);
        const holder = keyOfLayer(request.layer);
        if (source !== 'none' && source !== holder) {
          throw new KernelError('config_rules_elsewhere', { detail: `the rule table in effect is written by the ${source} layer, not ${request.layer}` });
        }
      }
      return writeConfigField(file, request).then(async (written) => {
        const holder = layers[keyOfLayer(request.layer)] ?? {};
        const table = (holder[definition.path[0]] ?? {}) as Record<string, unknown>;
        if (definition.kind === 'rules') {
          // 读回来那一份才是事实：这一格存的是整张表，写哪一种动作之后表里有什么，按文件里现在的那些项记。
          table[definition.path[1]] = written.rules ?? await readConfigRules(file);
        } else {
          table[definition.path[1]] = request.value;
        }
        holder[definition.path[0]] = table;
        layers[keyOfLayer(request.layer)] = holder;
        return {
          ...written,
          // 那一个字段落在提供方配置的哪一格上：宿主按这一格重算提供方，不必知道白名单的全表（方案 7.3）。
          key: definition.path[1],
          // 值本来就是只读那一层写的话，这一笔改了也盖不过它——宿主因此不动正在跑的提供方，界面另说一句。
          shadowed: sourceOf(request.field) === 'flag',
        };
      });
    },
  };
}
