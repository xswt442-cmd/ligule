// 两个设置页面共用同一份配置层显示定义。
// Host 管理层名和文件路径；界面只显示层名及约定位置，密钥不会写入配置。

/** 两个可写层及其约定位置。项目共享的 `config.toml` 随仓库共享，不属于可写层。 */
export const WRITABLE_LAYERS: [string, string][] = [
  ['user', '使用者默认那一层（~/.ligule/config.toml）'],
  ['projectLocal', '当前项目的本机覆盖（.ligule/config.local.toml）'],
];

export const layerName = (layer: string): string => WRITABLE_LAYERS.find(([id]) => id === layer)?.[1] ?? layer;

/** 配置值的来源层。`flag` 和 `project` 是只读层，修改低优先级文件不会覆盖它们。 */
const SOURCE_NAMES: Record<string, string> = {
  flag: '命令行 `--config`（只读）',
  local: '当前项目的本机覆盖',
  project: '项目共享那一份（只读）',
  user: '使用者默认',
  none: '四层里都没写',
};

export const sourceName = (source: string | undefined): string => SOURCE_NAMES[source ?? 'none'] ?? SOURCE_NAMES.none;

/** 来源层显示文字；当命令行层提供值时，说明文件修改不会改变该值。 */
export const sourceLine = (source: string | undefined): string =>
  `${sourceName(source)}${source === 'flag' ? '，改文件盖不过它' : ''}`;
