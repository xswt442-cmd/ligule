// 本地界面命令：退出与帮助面板。两者只改动当前界面状态，不触发 Host 请求。
import { useCallback } from 'react';

export type ShellCommandDeps = {
  readonly exitTui: (savedDraft?: string) => void;
  readonly setPanel: (next: 'help') => void;
  readonly setDetail: (next: null) => void;
  readonly setSessionPicker: (next: null) => void;
  readonly setSearch: (next: null) => void;
  readonly setMention: (next: null) => void;
};

export function useShellCommands(deps: ShellCommandDeps): { handle: (name: string) => boolean } {
  const { exitTui, setPanel, setDetail, setSessionPicker, setSearch, setMention } = deps;

  const handle = useCallback((name: string): boolean => {
    if (name === 'quit') {
      exitTui('');
      return true;
    }
    if (name === 'help') {
      setDetail(null);
      setSessionPicker(null);
      setSearch(null);
      setMention(null);
      setPanel('help');
      return true;
    }
    return false;
  }, [exitTui, setDetail, setMention, setPanel, setSearch, setSessionPicker]);

  return { handle };
}
