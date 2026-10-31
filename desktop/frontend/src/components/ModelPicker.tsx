import { useCallback, useEffect, useRef, useState } from 'react';
import { DropdownMenu } from 'radix-ui';
import { code, type Client } from '../protocol';
import { legacyService, modelName, thinkingChoices, type ModelCatalog, type ModelSelection, type ThinkingView } from '../model-catalog';
import { useText } from '../locale';
import { Icon } from './Icon';
import { keepEscape } from './ui';

// 档位名与 Host 上报的 effort 一一对应；未知档位原样显示。
function effortLabel(effort: string, t: ReturnType<typeof useText>): string {
  if (effort === 'none') return t('无', 'None');
  if (effort === 'low') return t('低', 'Low');
  if (effort === 'high') return t('高', 'High');
  if (effort === 'max') return t('最高', 'Max');
  return effort;
}

export function ModelPicker({ client, projectRoot, selection, thinking, onSelect, onThinking, onManage, disabled = false, pending = false }: {
  client: Client;
  projectRoot: string;
  selection: ModelSelection | null;
  thinking: ThinkingView | null;
  onSelect: (selection: ModelSelection) => Promise<void>;
  onThinking: (effort: string | null) => Promise<void>;
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
  const currentService = services.find(service => service.id === current?.provider);
  const select = async (next: ModelSelection) => {
    if (busy) return;
    setBusy(true); setFailure('');
    try { await onSelect(next); setOpen(false); }
    catch (error) { setFailure(code(error)); }
    finally { setBusy(false); }
  };
  // 思考档只在当前模型声明能力时出现；'默认' 清除会话覆盖（resetThinking）。
  const efforts = thinking === null ? [] : thinkingChoices(thinking.available);
  const currentEffort = thinking === null ? 'default' : thinking.pending ?? thinking.effective;
  const chooseThinking = async (effort: string | null) => {
    if (busy) return;
    setBusy(true); setFailure('');
    try { await onThinking(effort); setOpen(false); }
    catch (error) { setFailure(code(error)); }
    finally { setBusy(false); }
  };
  return <DropdownMenu.Root open={open} onOpenChange={setOpen}>
    <DropdownMenu.Trigger asChild><button type="button" className="composer-choice" disabled={disabled} title={t('选择模型', 'Choose model')}><Icon name="spark" size={14} /><span>{current === null ? t('选择模型', 'Choose model') : currentService === undefined ? current.model : modelName(currentService, current.model)}</span>{pending && <small>{t('下轮', 'next turn')}</small>}<Icon name="fold" size={12} /></button></DropdownMenu.Trigger>
    <DropdownMenu.Portal><DropdownMenu.Content className="menu model-picker" align="start" side="top" sideOffset={10} onEscapeKeyDown={keepEscape}>
      {failure && <div className="model-picker-error" role="alert"><span>{t('无法选择模型', 'Could not select model')}</span><code>{failure}</code></div>}
      {services.map(service => <DropdownMenu.Group key={service.id}>
        <DropdownMenu.Label className="model-group-name">{service.name}</DropdownMenu.Label>
        {service.models.map(model => <DropdownMenu.Item key={model} title={model} disabled={busy} className="model-option" onSelect={(event) => { event.preventDefault(); void select({ provider: service.id, model }); }}><span>{modelName(service, model)}</span>{current?.provider === service.id && current.model === model && <Icon name="check" size={14} />}</DropdownMenu.Item>)}
      </DropdownMenu.Group>)}
      {services.length === 0 && <p className="rail-empty">{t('尚未配置模型服务', 'No model services configured')}</p>}
      {efforts.length > 0 && <>
        <DropdownMenu.Separator className="menu-separator" />
        <DropdownMenu.Group>
          <DropdownMenu.Label className="model-group-name">{t('思考', 'Thinking')}</DropdownMenu.Label>
          <DropdownMenu.Item title={t('继承模型默认', 'Model default')} disabled={busy} className="model-option" onSelect={(event) => { event.preventDefault(); void chooseThinking(null); }}><span>{t('默认', 'Default')}</span>{currentEffort === 'default' && <Icon name="check" size={14} />}</DropdownMenu.Item>
          {efforts.map(effort => <DropdownMenu.Item key={effort} title={effort} disabled={busy} className="model-option" onSelect={(event) => { event.preventDefault(); void chooseThinking(effort); }}><span>{effortLabel(effort, t)}</span>{currentEffort === effort && <Icon name="check" size={14} />}</DropdownMenu.Item>)}
        </DropdownMenu.Group>
      </>}
      <DropdownMenu.Separator className="menu-separator" />
      <DropdownMenu.Item onSelect={onManage}><Icon name="gear" size={14} /> {t('管理模型服务', 'Manage model services')}</DropdownMenu.Item>
    </DropdownMenu.Content></DropdownMenu.Portal>
  </DropdownMenu.Root>;
}
