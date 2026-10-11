import { KernelError } from './error.js';

export type Locale = 'zh' | 'en';

/** 选择界面语言；未指定或选择 auto 时按系统语言选择。 */
export function languageOf(value: unknown, systemLocale = Intl.DateTimeFormat().resolvedOptions().locale): Locale {
  if (value === undefined || value === 'auto') return /^zh(?:-|$)/iu.test(systemLocale) ? 'zh' : 'en';
  if (value === 'zh' || value === 'en') return value;
  throw new KernelError('language_invalid');
}

/** 按已选语言返回界面文字。 */
export function textOf(locale: Locale, zh: string, en: string): string {
  return locale === 'zh' ? zh : en;
}
