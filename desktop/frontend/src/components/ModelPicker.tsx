import { useCallback, useEffect, useRef, useState } from 'react';
import { DropdownMenu } from 'radix-ui';
import { code, type Client } from '../protocol';
import { legacyService, type ModelCatalog, type ModelSelection } from '../model-catalog';
import { useText } from '../locale';
import { Icon } from './Icon';
import { keepEscape } from './ui';

export function ModelPicker({ client, projectRoot, selection, onSelect, onManage, disabled = false, pending = false }: {
  client: Client;
  projectRoot: string;
  selection: ModelSelection | null;
  onSelect: (selection: ModelSelection) => Promise<void>;
  onManage: () => void;
  disabled?: boolean;
  pending?: boolean;
}) {
  const t = useText();
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);
  const readRequest = useRef(0);
  const load = useCallback(async () => {
    const request = ++readRequest.current;
    setFailure('');
    try {
      const result = await client.call('config.get', projectRoot === '' ? {} : { projectRoot }, 15_000) as ModelCatalog;
      if (readRequest.current === request) setCatalog(result);
    } catch (error) { if (readRequest.current === request) setFailure(code(error)); }
  }, [client, projectRoot]);
  useEffect(() => { void load(); return () => { readRequest.current += 1; }; }, [load, open]);
  const legacy = catalog === null ? null : legacyService(catalog);
  const services = [...(legacy === null ? [] : [{ ...legacy, name: t('现有配置', 'Existing configuration') }]), ...(catalog?.services ?? [])];
  const current = selection ?? catalog?.selection ?? (legacy !== null ? { provider: 'legacy', model: legacy.models[0] } : services.length === 0 ? null : { provider: services[0].id, model: services[0].models[0] });
  const select = async (next: ModelSelection) => {
    if (busy) return;
    setBusy(true); setFailure('');
    try { await onSelect(next); setOpen(false); }
    catch (error) { setFailure(code(error)); }
    finally { setBusy(false); }
  };
  return <DropdownMenu.Root open={open} onOpenChange={setOpen}>
    <DropdownMenu.Trigger asChild><button type="button" className="composer-choice" disabled={disabled} title={t('选择模型', 'Choose model')}><Icon name="spark" size={14} /><span>{current?.model ?? t('选择模型', 'Choose model')}</span>{pending && <small>{t('下轮', 'next turn')}</small>}<Icon name="fold" size={12} /></button></DropdownMenu.Trigger>
    <DropdownMenu.Portal><DropdownMenu.Content className="menu model-picker" align="start" side="top" sideOffset={10} onEscapeKeyDown={keepEscape}>
      {failure && <div className="model-picker-error" role="alert"><span>{t('无法选择模型', 'Could not select model')}</span><code>{failure}</code></div>}
      {services.map(service => <DropdownMenu.Group key={service.id}>
        <DropdownMenu.Label className="model-group-name">{service.name}</DropdownMenu.Label>
        {service.models.map(model => <DropdownMenu.Item key={model} disabled={busy} className="model-option" onSelect={(event) => { event.preventDefault(); void select({ provider: service.id, model }); }}><span>{model}</span>{current?.provider === service.id && current.model === model && <Icon name="check" size={14} />}</DropdownMenu.Item>)}
      </DropdownMenu.Group>)}
      {services.length === 0 && <p className="rail-empty">{t('尚未配置模型服务', 'No model services configured')}</p>}
      <DropdownMenu.Separator className="menu-separator" />
      <DropdownMenu.Item onSelect={onManage}><Icon name="gear" size={14} /> {t('管理模型服务', 'Manage model services')}</DropdownMenu.Item>
    </DropdownMenu.Content></DropdownMenu.Portal>
  </DropdownMenu.Root>;
}
