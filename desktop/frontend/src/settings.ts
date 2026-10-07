// 界面一侧的设置：都存本机 WebView（D90）。草稿、字号、主题、侧栏宽度与收起、面板停靠都不进记录也不进配置文件。
// 那一份 JSON 是这台机器上留下的旧内容，读坏了就用默认，不猜它想表达什么。
import type { Verbosity } from './components/types';

export type Settings = {
  theme: 'system' | 'light' | 'dark';
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
};

const KEY = 'ligule.ui';
const VERBOSITY: Verbosity[] = ['brief', 'standard', 'detailed', 'full'];
// 一格草稿留 4000 字，一份会话最多排 20 句：这台机器上的存储不是给整段文件当缓存用的。
const DRAFT_LIMIT = 4000;
const QUEUE_LIMIT = 20;

export const defaultSettings: Settings = {
  theme: 'system',
  font: 'medium',
  sidebar: 280,
  dock: 'right',
  verbosity: 'standard',
  collapsed: false,
  drafts: {},
  queued: {},
  keys: {},
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
    theme: oneOf(value.theme, ['system', 'light', 'dark'], 'system'),
    font: oneOf(value.font, ['small', 'medium', 'large'], 'medium'),
    sidebar: clamped(value.sidebar, 264, 420, defaultSettings.sidebar),
    dock: oneOf(value.dock, ['right', 'left'], 'right'),
    verbosity: oneOf(value.verbosity, VERBOSITY, 'standard'),
    collapsed: value.collapsed === true,
    drafts: draftTable(value.drafts),
    queued: queueTable(value.queued),
    keys: stringMap(value.keys),
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
