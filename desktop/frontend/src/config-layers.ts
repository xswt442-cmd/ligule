// 配置那几层在界面上的说法：两栏设置共用这一份，不在各自文件里各写一张表。
// 层名到文件的对应关系由宿主持有，界面只说得出层名与它的约定位置；密钥的值从来不进配置（D13）。

/** 可写的两层，以及那两层各自落在哪一个约定位置（方案 7.2 那张表）。
 *  项目共享的那一份 `config.toml` 不在这里：它跟着仓库走，改它等于替别人改。 */
export const WRITABLE_LAYERS: [string, string][] = [
  ['user', '使用者默认那一层（~/.ligule/config.toml）'],
  ['projectLocal', '当前项目的本机覆盖（.ligule/config.local.toml）'],
];

export const layerName = (layer: string): string => WRITABLE_LAYERS.find(([id]) => id === layer)?.[1] ?? layer;

/** 「来源」那一格说的是四层里哪一层写着这一条（方案 7.1、D8 的次序）：`flag` 与 `project` 是只读的，改文件盖不过它们。 */
const SOURCE_NAMES: Record<string, string> = {
  flag: '命令行 `--config`（只读）',
  local: '当前项目的本机覆盖',
  project: '项目共享那一份（只读）',
  user: '使用者默认',
  none: '四层里都没写',
};

const sourceName = (source: string | undefined): string => SOURCE_NAMES[source ?? 'none'] ?? SOURCE_NAMES.none;

/** 「来源」那一句的完整形状：命令行那一层写着的那一条要额外说出改文件盖不过它（方案 7.1）。 */
export const sourceLine = (source: string | undefined): string =>
  `${sourceName(source)}${source === 'flag' ? '，改文件盖不过它' : ''}`;
