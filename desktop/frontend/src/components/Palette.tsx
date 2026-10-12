import { useMemo, useState } from 'react';
import { Modal } from './ui';
import { useText } from '../locale';

export type Command = { id: string; title: string; note?: string; run: () => void };

export function Palette({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const t = useText();
  const [filter, setFilter] = useState('');
  const [index, setIndex] = useState(0);
  const matched = useMemo(() => {
    const text = filter.trim().toLowerCase();
    if (text === '') return commands;
    return commands.filter((item) => `${item.title} ${item.note ?? ''}`.toLowerCase().includes(text));
  }, [commands, filter]);

  const pick = (item: Command | undefined) => {
    if (item === undefined) return;
    onClose();
    item.run();
  };

  return <Modal title={t('命令面板', 'Command palette')} className="palette" onClose={onClose}>
    <input
      autoFocus
      value={filter}
      placeholder={t('搜索命令（↑↓ 选择，Enter 执行）', 'Search commands (↑↓ to select, Enter to run)')}
      aria-label={t('搜索命令', 'Search commands')}
      onChange={(event) => {
        setFilter(event.target.value);
        setIndex(0);
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          setIndex((at) => Math.min(at + 1, matched.length - 1));
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          setIndex((at) => Math.max(at - 1, 0));
        } else if (event.key === 'Enter') {
          event.preventDefault();
          pick(matched[index]);
        }
      }}
    />
    <ul role="listbox" aria-label={t('命令列表', 'Command list')}>
      {matched.length === 0 && <li className="palette-empty">{t('没有匹配的命令', 'No matching commands')}</li>}
      {matched.map((item, at) => <li key={item.id} role="option" aria-selected={at === index}>
        <button type="button" onClick={() => pick(item)} onMouseEnter={() => setIndex(at)}>
          <span>{item.title}</span>
          {item.note && <span className="palette-note">{item.note}</span>}
        </button>
      </li>)}
    </ul>
  </Modal>;
}
