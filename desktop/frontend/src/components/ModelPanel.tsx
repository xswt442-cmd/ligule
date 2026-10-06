import { useCallback, useEffect, useState } from 'react';
import { code, type Client } from '../protocol';
import { Icon } from './Icon';

// 「模型与端点」那一格读的是 `config.get`（实现顺序第 67 步）：宿主只交白名单里那几格，
// 界面要不到别的一格，也读不到密钥本身——凭据只从环境变量读（D13）。
type Shown = {
  model?: { api?: string; baseURL?: string; model?: string; apiKeyEnv?: string };
};

export function ModelPanel({ client }: { client: Client }) {
  const [shown, setShown] = useState<Shown | null>(null);
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    setNote('');
    try {
      setShown(await client.call('config.get', {}, 15_000) as Shown);
    } catch (error) {
      setNote(`配置读不回来：${code(error)}`);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const model = shown?.model ?? {};
  const rows: [string, string | undefined][] = [
    ['线上形状', model.api],
    ['服务地址', model.baseURL],
    ['模型名', model.model],
    ['密钥的环境变量名', model.apiKeyEnv],
  ];

  return <>
    <button type="button" className="rail-refresh" onClick={() => void load()}><Icon name="refresh" size={13} /> 重读一次</button>
    {note !== '' && <p className="session-note">{note}</p>}
    {rows.map(([label, value]) => <div key={label} className="sheet-row">
      <span className="sheet-label">{label}</span>
      <span className="sheet-value">{value ?? '没写这一格'}</span>
    </div>)}
    <p className="sheet-note">
      这几格读的是配置文件那三层（D8），要改就得动文件：协议里只有读配置的这一条，没有写配置的方法。
      密钥的值从来不进配置，也不进这一格，所以这里看不到它。
    </p>
  </>;
}
