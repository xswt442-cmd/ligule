import { Fragment, useEffect, useState } from 'react';
import { CURRENT, KEYMAP, conflictsIn, formatKeys, parseSpec, setCapturing, specOf, type KeyAction, type KeyView } from '../../hotkeys';
import type { Settings } from '../../settings';
import { useText } from '../../locale';
import { Group, Row } from '../ui';

const KEY_LABELS: Record<KeyAction, [string, string]> = {
  palette: ['打开命令面板', 'Open command palette'],
  sidebar: ['收起或展开侧栏', 'Show or hide the sidebar'],
  'copy-answer': ['复制最后一条回答', 'Copy the latest answer'],
  interrupt: ['关闭浮层或停止本轮', 'Close overlay or stop turn'],
  send: ['发送或加入队列', 'Send or queue a message'],
  'send-alt': ['发送', 'Send'],
  newline: ['换行', 'Insert a new line'],
  'history-older': ['向上翻输入历史', 'Move back in input history'],
  'history-newer': ['向下翻输入历史', 'Move forward in input history'],
  'pick-candidate': ['选择文件候选', 'Select a file suggestion'],
  'complete-candidate': ['选择文件候选', 'Select a file suggestion'],
  'candidate-older': ['选择上一条候选', 'Select the previous suggestion'],
  'candidate-newer': ['选择下一条候选', 'Select the next suggestion'],
  'hide-candidate': ['收起文件候选', 'Hide file suggestions'],
};

const KEY_VIEWS: Record<KeyView, [string, string]> = {
  '窗口': ['窗口', 'Window'],
  '输入坞': ['输入框', 'Composer'],
  '候选清单': ['文件候选', 'File suggestions'],
};

export function KeyboardSettings({ settings, patch, notice }: { settings: Settings; patch: (part: Partial<Settings>) => void; notice: string }) {
  const t = useText();
  const [listening, setListening] = useState<KeyAction | null>(null);
  const [refused, setRefused] = useState('');
  useEffect(() => {
    if (listening === null) return;
    setCapturing(true);
    const stop = () => {
      setCapturing(false);
      setListening(null);
    };
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      // 录制时消费按键，避免同一按键同时触发窗口级快捷操作。
      event.stopImmediatePropagation();
      if (event.key === 'Escape') {
        stop();
        return;
      }
      const spec = specOf(event);
      if (spec === null) return;
      const binding = KEYMAP[listening];
      // 同一作用范围内已有动作使用该按键时拒绝保存。
      const clash = conflictsIn(binding.view, { ...CURRENT, [listening]: spec });
      if (clash.length > 0) {
        const [first, second] = clash[0];
        setRefused(t(
          `${formatKeys(spec)} 在${KEY_VIEWS[binding.view][0]}里已经用于“${t(...KEY_LABELS[first])}”和“${t(...KEY_LABELS[second])}”。一个范围内不能重复使用同一按键。`,
          `${formatKeys(spec)} is already used for “${t(...KEY_LABELS[first])}” and “${t(...KEY_LABELS[second])}” in the ${KEY_VIEWS[binding.view][1]}. A key can have only one action in each area.`,
        ));
        stop();
        return;
      }
      setRefused('');
      patch({ keys: { ...settings.keys, [listening]: spec } });
      stop();
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      setCapturing(false);
    };
  }, [listening, patch, settings.keys]);

  const restore = (action: string) => {
    const next = { ...settings.keys };
    delete next[action];
    patch({ keys: next });
  };
  const views = [...new Set(Object.values(KEYMAP).map((binding) => binding.view))] as KeyView[];
  return <div className="shortcut-settings">
    {notice === '' ? null : <p className="stub">{notice}</p>}
    {refused === '' ? null : <p className="session-note" data-tone="bad">{refused}</p>}
    {views.map((view) => <Fragment key={view}>
      <Group title={t(...KEY_VIEWS[view])}>
        {(Object.entries(KEYMAP) as [KeyAction, (typeof KEYMAP)[KeyAction]][])
          .filter(([, binding]) => binding.view === view)
          .map(([action]) => <Row key={action} label={t(...KEY_LABELS[action])}>
            <code>{formatKeys(parseSpec(settings.keys[action] ?? '') ?? KEYMAP[action].spec)}</code>
            <button type="button" aria-label={t(`更改快捷键：${KEY_LABELS[action][0]}`, `Change shortcut: ${KEY_LABELS[action][1]}`)} onClick={() => { setRefused(''); setListening(listening === action ? null : action); }}>
              {listening === action ? t('按下新键（Esc 取消）', 'Press a new key (Esc to cancel)') : t('更改', 'Change')}
            </button>
            {settings.keys[action] === undefined ? null : <button type="button" onClick={() => restore(action)}>{t('恢复默认', 'Reset')}</button>}
          </Row>)}
      </Group>
    </Fragment>)}
    <Row label={t('恢复所有默认键位', 'Reset all keyboard shortcuts')} note={t('清除这台设备上的个人键位。', 'Clear custom shortcuts on this device.')}>
      <button type="button" onClick={() => { setRefused(''); patch({ keys: {} }); }}>{t('恢复默认', 'Reset')}</button>
    </Row>
  </div>;
}
