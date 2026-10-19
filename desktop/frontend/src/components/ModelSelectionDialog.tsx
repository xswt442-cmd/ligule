import { useState } from 'react';
import { useText } from '../locale';
import { Icon } from './Icon';
import { Modal } from './ui';

export function ModelSelectionDialog({ models, existingModels, onCancel, onAdd }: {
  models: string[];
  existingModels: string[];
  onCancel: () => void;
  onAdd: (models: string[]) => void;
}) {
  const t = useText();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const existing = new Set(existingModels.map(model => model.trim()));
  const availableSlots = Math.max(0, 128 - existing.size);
  const needle = query.trim().toLowerCase();
  const visible = models.filter(model => model.toLowerCase().includes(needle));
  const addable = visible.filter(model => !existing.has(model.trim()));
  const allSelected = addable.length > 0 && addable.every(model => selected.has(model));

  const toggleAll = () => setSelected(current => {
    const next = new Set(current);
    for (const model of addable) {
      if (allSelected) next.delete(model);
      else if (next.size < availableSlots) next.add(model);
    }
    return next;
  });

  return <Modal title={t('选择要添加的模型', 'Choose models to add')} className="model-selection" onClose={onCancel}>
    <header className="model-selection-head">
      <h2>{t('选择要添加的模型', 'Choose models to add')}</h2>
      <button type="button" className="icon-button" aria-label={t('关闭', 'Close')} onClick={onCancel}><Icon name="close" size={15} /></button>
    </header>
    <p className="model-selection-description">{t('以下是服务提供的可用模型，勾选要添加到目录的模型。', 'Choose which available models from this service to add to the catalog.')}</p>
    <div className="model-selection-controls">
      <input type="search" aria-label={t('搜索模型', 'Search models')} value={query} onChange={event => setQuery(event.target.value)} placeholder={t('搜索模型', 'Search models')} />
      <button type="button" disabled={availableSlots === 0 || addable.length === 0} aria-pressed={allSelected} onClick={toggleAll}>{t('全选', 'Select all')}</button>
    </div>
    <div className="model-selection-list" role="group" aria-label={t('可用模型', 'Available models')}>
      {visible.map(model => {
        const alreadyAdded = existing.has(model.trim());
        return <label key={model} className="model-selection-item">
          <input type="checkbox" checked={alreadyAdded || selected.has(model)} disabled={alreadyAdded || (!selected.has(model) && selected.size >= availableSlots)} onChange={event => setSelected(current => {
            const next = new Set(current);
            if (event.target.checked) next.add(model);
            else next.delete(model);
            return next;
          })} />
          <span>{model}</span>
          {alreadyAdded && <small>{t('已在目录中', 'Already added')}</small>}
        </label>;
      })}
      {visible.length === 0 && <p className="model-selection-empty">{t('没有匹配的模型。', 'No matching models.')}</p>}
    </div>
    <footer className="model-selection-actions">
      <span>{availableSlots === 0
        ? t('目录已达 128 个模型上限，请先移除条目。', 'The 128-model limit is reached. Remove entries before adding more.')
        : selected.size >= availableSlots
          ? t(`已选择 ${selected.size} 个模型，达到目录上限。`, `${selected.size} models selected; the catalog limit is reached.`)
          : t(`已选择 ${selected.size} 个模型`, `${selected.size} models selected`)}</span>
      <div>
        <button type="button" onClick={onCancel}>{t('取消', 'Cancel')}</button>
        <button type="button" className="primary-button" disabled={selected.size === 0} onClick={() => onAdd(models.filter(model => selected.has(model)))}>{t('添加所选', 'Add selected')}</button>
      </div>
    </footer>
  </Modal>;
}
