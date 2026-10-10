// Host 把界面设置存在数据根；`ligule.ui` 缓存首屏，只在数据根版本为空时迁移。
// 读取失败时不写磁盘；草稿和队列保留完整内容，由 Host 检查文档大小。
import type { Verbosity } from './components/types';
import type { Client } from './protocol';
import type { Language } from './locale';

// 六套具名配色：墨青（默认，深色）、羊皮纸（暖米色）、蓝天（冷白蓝）、石墨（中性深色）、森林（深绿）、黄昏（暖深琥珀）。
// 取值在 `styles.css` 的 `data-palette` 变量块里；这里只认名字。
export const PALETTES = ['ink', 'parchment', 'sky', 'graphite', 'forest', 'dusk'] as const;
export type Palette = (typeof PALETTES)[number];

export type Settings = {
  language: Language;
  lastSession: { id: string; projectRoot: string } | null;
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
  hiddenProjects: string[];
};

const KEY = 'ligule.ui';
const VERBOSITY: Verbosity[] = ['brief', 'standard', 'detailed', 'full'];

export const defaultSettings: Settings = {
  language: 'auto',
  lastSession: null,
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
  hiddenProjects: [],
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
      if (typeof text === 'string' && text !== '') kept[session] = text;
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
      const sentences = items.filter((each): each is string => typeof each === 'string' && each !== '');
      if (sentences.length > 0) kept[session] = sentences;
    }
    if (Object.keys(kept).length > 0) out[project] = kept;
  }
  return out;
};

// 从已解析的那一份值收出一份认得的设置：数据根里读回来的与缓存里读回来的都过这一处。
export function settingsFrom(raw: unknown): Settings {
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<Settings>;
  return {
    language: oneOf(value.language, ['auto', 'zh', 'en'], 'auto'),
    lastSession: typeof value.lastSession?.id === 'string' && typeof value.lastSession?.projectRoot === 'string'
      ? { id: value.lastSession.id, projectRoot: value.lastSession.projectRoot } : null,
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
    hiddenProjects: rootList(value.hiddenProjects),
  };
}

export function readSettings(): Settings {
  let raw: unknown;
  try {
    raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
  } catch {
    return defaultSettings;
  }
  return settingsFrom(raw);
}

/** 读取本地缓存原文；只有 Host 报告空版本时才考虑迁移。 */
export function cachedSettingsJson(): string {
  try {
    return localStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}

// 缓存写不进去只影响第一屏快几毫秒，不影响可恢复性，所以不上报（上报的是数据根那一份写不进去）。
export function cacheSettings(settings: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // 缓存是尽力而为的那一份。
  }
}

type ClientSettingsState = {
  version: string;
  writable: boolean;
  tail: Promise<void>;
  loading?: Promise<Settings>;
};

const clientSettings = new WeakMap<Client, ClientSettingsState>();

function errorWithCode(error: unknown, fallback: string): Error {
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    if (typeof code === 'string' && code !== '') return error;
    return Object.assign(error, { code: fallback });
  }
  return Object.assign(new Error(String(error)), { code: fallback });
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function cachedLegacySettings(): Settings | undefined {
  const json = cachedSettingsJson();
  if (json === '') return undefined;
  try {
    const raw: unknown = JSON.parse(json);
    if (objectValue(raw) === undefined) return undefined;
    return settingsFrom(raw);
  } catch {
    return undefined;
  }
}

function writeSettings(client: Client, state: ClientSettingsState, settings: Settings, version?: string): Promise<void> {
  const pending = state.tail.then(async () => {
    if (!state.writable) throw Object.assign(new Error('prefs_reload_required'), { code: 'prefs_reload_required' });
    const result = await client.call('prefs.write', {
      json: JSON.stringify(settings),
      version: version ?? state.version,
    }, 15_000);
    const updated = objectValue(result);
    if (typeof updated?.version !== 'string') {
      throw Object.assign(new Error('prefs_write_version_invalid'), { code: 'prefs_write_version_invalid' });
    }
    state.version = updated.version;
  });
  state.tail = pending.then(
    () => undefined,
    () => { state.writable = false; },
  );
  return pending.catch((error: unknown) => {
    state.writable = false;
    throw errorWithCode(error, 'prefs_write_failed');
  });
}

/** 从 Host 读取设置版本；只有成功读取后，该 Client 才能保存。 */
export function loadSettings(client: Client): Promise<Settings> {
  let state = clientSettings.get(client);
  if (state === undefined) {
    state = { version: '', writable: false, tail: Promise.resolve() };
    clientSettings.set(client, state);
  }
  if (state.loading !== undefined) return state.loading;
  state.writable = false;

  const loading = (async () => {
    await state.tail;
    try {
      const result = objectValue(await client.call('prefs.read', {}, 15_000));
      if (result === undefined || typeof result.version !== 'string') {
        throw Object.assign(new Error('prefs_read_version_invalid'), { code: 'prefs_read_version_invalid' });
      }
      state.version = result.version;
      state.writable = true;
      const settings = settingsFrom(result.settings);
      if (state.version !== '') {
        cacheSettings(settings);
        return settings;
      }

      const legacy = cachedLegacySettings();
      if (legacy !== undefined) {
        await writeSettings(client, state, legacy, '');
        cacheSettings(legacy);
        return legacy;
      }
      cacheSettings(settings);
      return settings;
    } catch (error) {
      state.writable = false;
      throw errorWithCode(error, 'prefs_read_failed');
    }
  })();
  state.loading = loading;
  void loading.then(
    () => { if (state.loading === loading) state.loading = undefined; },
    () => { if (state.loading === loading) state.loading = undefined; },
  );
  return loading;
}

/** 缓存保留首屏状态；正式写入必须使用最近一次成功读取的版本。 */
export async function saveSettings(client: Client, settings: Settings): Promise<void> {
  cacheSettings(settings);
  const state = clientSettings.get(client);
  if (state === undefined || !state.writable) {
    throw Object.assign(new Error('prefs_reload_required'), { code: 'prefs_reload_required' });
  }
  await writeSettings(client, state, settings);
}

// 重连之后这一份会话排着的几句交回草稿：按先后拼在草稿后面，原来那一句留在最前，界面不自动发其中任何一句。
// 人为取消那一路不走这一处（那一条由输入坞留着队列并暂停，另有收回的把手）。
export function mergeQueueIntoDraft(draft: string, items: string[]): string {
  return [draft, ...items].filter((text) => text !== '').join('\n\n');
}
