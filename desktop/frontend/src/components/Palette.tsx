import { useMemo, useState } from 'react';
import { Modal } from './ui';

// 命令面板：只做入口，不做语义（D92）。每一条落下去的是界面或协议本来就有的那一个动作。
export type Command = { id: string; title: string; note: string; run: () => void };

export function Palette({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const [filter, setFilter] = useState('');
  const [index, setIndex] = useState(0);
  const matched = useMemo(() => {
    const text = filter.trim().toLowerCase();
    if (text === '') return commands;
    return commands.filter((item) => `${item.title} ${item.note}`.toLowerCase().includes(text));
  }, [commands, filter]);

  const pick = (item: Command | undefined) => {
    if (item === undefined) return;
    onClose();
    item.run();
  };

  // 焦点限制、焦点返回与 Esc 收起在 `Modal` 那一层（方案 4.2），这一处只接挑选命令的三记按键。
  return <Modal title="命令面板" className="palette" onClose={onClose}>
    <input
      autoFocus
      value={filter}
      placeholder="挑一条命令（↑↓ 选，Enter 执行，Esc 收起）"
      aria-label="命令过滤"
      onChange={(event) => {
        setFilter(event.target.value);
        setIndex(0);
      }}
      onKeyDown={(event) => {
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
    <ul role="listbox" aria-label="命令清单">
      {matched.length === 0 && <li className="palette-empty">没有对得上的命令</li>}
      {matched.map((item, at) => <li key={item.id} role="option" aria-selected={at === index}>
        <button type="button" onClick={() => pick(item)} onMouseEnter={() => setIndex(at)}>
          <span>{item.title}</span>
          <span className="palette-note">{item.note}</span>
        </button>
      </li>)}
    </ul>
  </Modal>;
}
