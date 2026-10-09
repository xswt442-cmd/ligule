// 界面一侧的设置：都存本机 WebView（D90）。草稿、字号、主题、侧栏宽度与收起、面板停靠都不进记录也不进配置文件。
// 那一份 JSON 是这台机器上留下的旧内容，读坏了就用默认，不猜它想表达什么。
import type { Verbosity } from './components/types';

// 六套具名配色：墨青（默认，深色）、羊皮纸（暖米色）、蓝天（冷白蓝）、石墨（中性深色）、森林（深绿）、黄昏（暖深琥珀）。
// 取值在 `styles.css` 的 `data-palette` 变量块里；这里只认名字。
export const PALETTES = ['ink', 'parchment', 'sky', 'graphite', 'forest', 'dusk'] as const;
export type Palette = (typeof PALETTES)[number];

export type Settings = {
  // 配色方案：六套具名方案选一枚，落在根元素的 `data-palette` 上。存本机界面偏好，不进记录、不进配置（D90）。
  palette: Palette;
  font: 'small' | 'medium' | 'large';
  sidebar: number;
  dock: 'right' | 'left';
  verbosity: Verbosity;
  collapsed: boolean;
  // 草稿与排着的几句都按「哪一项目录下的哪一份会话」放：两份会话不共用一格草稿，退出再打开还在（方案 5.1）。
  drafts: Record<string, Record<string, string>>;
  queued: Record<string, Record<string, string[]>>;
  // 个人键位：动作名 → 那一串键的写法。它属于本机的界面偏好，不进记录、不进模型上下文、也不进项目的业务配置（方案 6.1）。
  keys: Record<string, string>;
  // 这一扇窗口另外看着哪几项目录（方案 3.2 的第二、第三个项目）：只是界面这边的清单，
  // 落笔与生效都在宿主那一边按每一份会话自己的项目环境算。
  projects: string[];
};

const KEY = 'ligule.ui';
const VERBOSITY: Verbosity[] = ['brief', 'standard', 'detailed', 'full'];
// 一格草稿留 4000 字，一份会话最多排 20 句：这台机器上的存储不是给整段文件当缓存用的。
const DRAFT_LIMIT = 4000;
const QUEUE_LIMIT = 20;

export const defaultSettings: Settings = {
  palette: 'ink',
  font: 'medium',
  sidebar: 280,
  dock: 'right',
  verbosity: 'standard',
  collapsed: false,
  drafts: {},
  queued: {},
  keys: {},
  projects: [],
};

const oneOf = <T extends string>(value: unknown, allowed: T[], fallback: T): T =>
  allowed.includes(value as T) ? value as T : fallback;
const clamped = (value: unknown, low: number, high: number, fallback: number): number =>
  typeof value === 'number' && value >= low && value <= high ? Math.round(value) : fallback;
// 键位那一张表只认「名字 → 一串键的写法」这一种形状；那串写法读不读得开归键位那一层判，这里不重复一份判断。
const stringMap = (value: unknown): Record<string, string> => {
  if (typeof value !== 'object' || value === null) return {};
  const out: Record<string, string> = {};
  for (const [name, text] of Object.entries(value)) if (typeof text === 'string') out[name] = text;
  return out;
};

// 另外看着哪几项目录：只留写得出来的那几条并去重（方案 3.2）。这一份清单不再按「最近八条」截断：
// 它只是这一扇窗口想看着的那几份，登记在应用数据根里的那一份才是持久的（D110、方案 5.5.1），
// 退掉一条只改这一栏画什么，记录、归属与历史都不动。
const rootList = (value: unknown): string[] =>
  Array.isArray(value) ? [...new Set(value.filter((each): each is string => typeof each === 'string' && each !== ''))] : [];

// 那两张表只认写得出来的形状：一格草稿是串，一排是串数组，别的一律丢掉，不猜它想表达什么。
const draftTable = (value: unknown): Record<string, Record<string, string>> => {
  if (typeof value !== 'object' || value === null) return {};
  const out: Record<string, Record<string, string>> = {};
  for (const [project, sessions] of Object.entries(value)) {
    if (typeof sessions !== 'object' || sessions === null) continue;
    const kept: Record<string, string> = {};
    for (const [session, text] of Object.entries(sessions)) {
      if (typeof text === 'string' && text !== '') kept[session] = text.slice(0, DRAFT_LIMIT);
    }
    if (Object.keys(kept).length > 0) out[project] = kept;
  }
  return out;
};
const queueTable = (value: unknown): Record<string, Record<string, string[]>> => {
  if (typeof value !== 'object' || value === null) return {};
  const out: Record<string, Record<string, string[]>> = {};
  for (const [project, sessions] of Object.entries(value)) {
    if (typeof sessions !== 'object' || sessions === null) continue;
    const kept: Record<string, string[]> = {};
    for (const [session, items] of Object.entries(sessions)) {
      if (!Array.isArray(items)) continue;
      const sentences = items.filter((each): each is string => typeof each === 'string' && each !== '').slice(0, QUEUE_LIMIT);
      if (sentences.length > 0) kept[session] = sentences;
    }
    if (Object.keys(kept).length > 0) out[project] = kept;
  }
  return out;
};

export function readSettings(): Settings {
  let raw: unknown;
  try {
    raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
  } catch {
    return defaultSettings;
  }
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<Settings>;
  return {
    palette: oneOf(value.palette, [...PALETTES], 'ink'),
    font: oneOf(value.font, ['small', 'medium', 'large'], 'medium'),
    sidebar: clamped(value.sidebar, 264, 420, defaultSettings.sidebar),
    dock: oneOf(value.dock, ['right', 'left'], 'right'),
    verbosity: oneOf(value.verbosity, VERBOSITY, 'standard'),
    collapsed: value.collapsed === true,
    drafts: draftTable(value.drafts),
    queued: queueTable(value.queued),
    keys: stringMap(value.keys),
    projects: rootList(value.projects),
  };
}

// 写不进去要说得出来：那一句还留在屏幕上，但不能让人以为它已经存住了。
export function writeSettings(settings: Settings): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}

// 重连之后这一份会话排着的几句交回草稿：按先后拼在草稿后面，原来那一句留在最前，界面不自动发其中任何一句。
// 人为取消那一路不走这一处（那一条由输入坞留着队列并暂停，另有收回的把手）。
export function mergeQueueIntoDraft(draft: string, items: string[]): string {
  return [draft, ...items].filter((text) => text !== '').join('\n\n');
}
