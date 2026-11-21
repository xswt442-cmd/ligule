// 快捷键绑定命令：查看、修改、恢复默认与解决冲突。
// 动作名称保持稳定；显示文本和实际按键行为共用同一份配置，冲突在保存前拒绝。
import { useCallback } from 'react';
import { CURRENT, ENGLISH_LABELS, ENGLISH_VIEWS, KEYMAP, conflictsIn, defaultSpecs, formatKeys, parseSpec } from '../keymap.js';
import type { TerminalAction } from '../keymap.js';
import type { Locale } from '@ligule/core/tui.js';
import type { TranscriptItem } from '../transcript.js';

export type KeybindCommandDeps = {
  readonly keys: { write(overrides: Record<string, string>): Promise<void> } | undefined;
  readonly keyOverrides: Record<string, string>;
  readonly setKeyOverrides: (next: Record<string, string>) => void;
  readonly locale: Locale;
  readonly push: (...items: TranscriptItem[]) => void;
  readonly t: (zh: string, en: string) => string;
};

function isTerminalAction(value: string): value is TerminalAction {
  return Object.hasOwn(KEYMAP, value);
}

export function useKeybindCommands(deps: KeybindCommandDeps): { handle: (name: string, argument: string) => boolean } {
  const { keys, keyOverrides, setKeyOverrides, locale, push, t } = deps;

  const handle = useCallback((name: string, argument: string): boolean => {
    if (name !== 'bind') return false;
    // 只修改动作对应的按键，动作名称保持稳定；显示文本和实际按键行为共用同一配置。
    const parts = argument.trim().split(/\s+/).filter((part) => part !== '');
    const save = (next: Record<string, string>) => {
      if (keys === undefined) {
        push({ kind: 'meta', text: t('快捷键仅在本次运行生效：未配置存储', 'Shortcuts apply to this run only: storage is unavailable') });
        return;
      }
      void keys.write(next).catch(() => push({ kind: 'error', text: t('无法保存快捷键', 'Could not save shortcuts') }));
    };
    if (parts.length === 0) {
      push({ kind: 'meta', text: [
        t(`快捷键（${Object.keys(keyOverrides).length} 项自定义）。修改：/bind <动作> <按键>；恢复：/bind reset <动作> 或 /bind default。`, `Shortcuts (${Object.keys(keyOverrides).length} customized). Set: /bind <action> <key>; reset: /bind reset <action> or /bind default.`),
        ...Object.entries(KEYMAP).flatMap(([name, binding]) => {
          if (!isTerminalAction(name)) return [];
          return [`${name} = ${formatKeys(CURRENT[name])} (${locale === 'en' ? ENGLISH_VIEWS[binding.view] : binding.view})`];
        }),
      ].join('\n') });
      return true;
    }
    if (parts[0] === 'default') {
      for (const [action, spec] of Object.entries(defaultSpecs())) {
        if (isTerminalAction(action)) CURRENT[action] = spec;
      }
      setKeyOverrides({});
      save({});
      push({ kind: 'meta', text: t('已恢复默认快捷键', 'Default shortcuts restored') });
      return true;
    }
    if (parts[0] === 'reset') {
      const action = parts[1];
      if (action === undefined || !isTerminalAction(action) || KEYMAP[action] === undefined) {
        push({ kind: 'error', text: t(`未知动作：${action ?? ''}。用 /bind 查看`, `Unknown action: ${action ?? ''}. Use /bind to browse`) });
        return true;
      }
      CURRENT[action] = KEYMAP[action].spec;
      const next = { ...keyOverrides };
      delete next[action];
      setKeyOverrides(next);
      save(next);
      push({ kind: 'meta', text: t(`${action} 已恢复为 ${formatKeys(KEYMAP[action].spec)}`, `${action} reset to ${formatKeys(KEYMAP[action].spec)}`) });
      return true;
    }
    const [action, text] = parts;
    if (action === undefined || !isTerminalAction(action)) {
      push({ kind: 'error', text: t(`未知动作：${action}。用 /bind 查看`, `Unknown action: ${action}. Use /bind to browse`) });
      return true;
    }
    const binding = KEYMAP[action];
    const spec = parseSpec(text ?? '');
    if (spec === null) {
      push({ kind: 'error', text: t(`无效按键：${text ?? ''}。例如 Ctrl+Shift+K、enter、pageup`, `Invalid key: ${text ?? ''}. Examples: Ctrl+Shift+K, enter, pageup`) });
      return true;
    }
    // 保存前校验按键绑定，拒绝同一作用范围内的冲突。
    const clash = conflictsIn(binding.view, { ...CURRENT, [action]: spec });
    if (clash.length > 0) {
      push({ kind: 'error', text: t(`${formatKeys(spec)} 在${binding.view}中冲突：${clash[0].join(' / ')}`, `${formatKeys(spec)} conflicts in ${ENGLISH_VIEWS[binding.view]}: ${clash[0].join(' / ')}`) });
      return true;
    }
    CURRENT[action] = spec;
    const next = { ...keyOverrides, [action]: spec };
    setKeyOverrides(next);
    save(next);
    push({ kind: 'meta', text: `${action} = ${formatKeys(spec)} · ${locale === 'en' ? ENGLISH_LABELS[action] : binding.label}` });
    return true;
  }, [keyOverrides, keys, locale, push, setKeyOverrides, t]);

  return { handle };
}
