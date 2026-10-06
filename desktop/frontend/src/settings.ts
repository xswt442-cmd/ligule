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
  draft: string;
};

const KEY = 'ligule.ui';
const VERBOSITY: Verbosity[] = ['brief', 'standard', 'detailed', 'full'];

export const defaultSettings: Settings = {
  theme: 'system',
  font: 'medium',
  sidebar: 280,
  dock: 'right',
  verbosity: 'standard',
  collapsed: false,
  draft: '',
};

const oneOf = <T extends string>(value: unknown, allowed: T[], fallback: T): T =>
  allowed.includes(value as T) ? value as T : fallback;
const clamped = (value: unknown, low: number, high: number, fallback: number): number =>
  typeof value === 'number' && value >= low && value <= high ? Math.round(value) : fallback;

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
    draft: typeof value.draft === 'string' ? value.draft.slice(0, 4000) : '',
  };
}

export function writeSettings(settings: Settings): void {
  localStorage.setItem(KEY, JSON.stringify(settings));
}
