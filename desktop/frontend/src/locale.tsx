import { createContext, useCallback, useContext, useEffect, type ReactNode } from 'react';

export type Language = 'auto' | 'zh' | 'en';
export type Locale = 'zh' | 'en';

export function localeOf(language: Language): Locale {
  return language === 'auto' ? (navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en') : language;
}

const LocaleContext = createContext<Locale>('zh');

export function LocaleProvider({ language, children }: { language: Language; children: ReactNode }) {
  const locale = localeOf(language);
  useEffect(() => { document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en'; }, [locale]);
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

// 两种文字必须同时提供；模型正文、路径与工具原始输出不经翻译。
export function useText(): (chinese: string, english: string) => string {
  const locale = useContext(LocaleContext);
  return useCallback((chinese, english) => locale === 'zh' ? chinese : english, [locale]);
}

export function useLocale(): Locale {
  return useContext(LocaleContext);
}
