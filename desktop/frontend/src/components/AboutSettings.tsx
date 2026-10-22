import { useEffect, useState } from 'react';
import type { DesktopAppInfo } from '../../../electron/api';
import { readDesktopAppInfo } from '../bridge';
import { diagnosticSummary } from '../diagnostics';
import { readSettingsCatalog } from '../settings-catalog';
import type { Client } from '../protocol';
import { useText } from '../locale';
import type { Status } from '../status';
import { DiagnosticsPanel } from './DiagnosticsPanel';
import { HelpPanel } from './HelpPanel';
import { Group, Row } from './ui';

export function AboutSettings({ client, projectRoot, sessionId, status, counts, waiting, link, logs, onReconnect }: {
  client: Client;
  projectRoot: string;
  sessionId: string | null;
  status: Status | null;
  counts: { sent: number; received: number };
  waiting: number;
  link: string | null;
  logs: string[];
  onReconnect: () => void;
}) {
  const t = useText();
  const [info, setInfo] = useState<DesktopAppInfo | null>(null);
  const [hostNodeVersion, setHostNodeVersion] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [copyState, setCopyState] = useState('');
  const unknown = t('未知', 'Unknown');

  useEffect(() => {
    let active = true;
    void readDesktopAppInfo()
      .then((value) => { if (active) setInfo(value); })
      .catch(() => { if (active) setInfo(null); })
      .finally(() => { if (active) setLoaded(true); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    void readSettingsCatalog(client, projectRoot, sessionId)
      .then((catalog) => { if (active) setHostNodeVersion(catalog.hostNodeVersion); })
      .catch(() => { if (active) setHostNodeVersion(null); });
    return () => { active = false; };
  }, [client, projectRoot, sessionId]);

  const buildId = info?.build?.id ?? unknown;
  const buildDate = info?.build?.date ?? unknown;
  const copyDiagnostics = async () => {
    try {
      await navigator.clipboard.writeText(diagnosticSummary({ info, hostNodeVersion, status, connected: link === null, counts, waiting, logCount: logs.length }));
      setCopyState(t('诊断摘要已复制；不含路径、会话 ID、转录或原始日志。', 'Diagnostic summary copied; it contains no paths, session IDs, transcript, or raw logs.'));
    } catch {
      setCopyState(t('无法写入剪贴板。', 'Could not write to the clipboard.'));
    }
  };
  return <div className="about-settings">
    <Group title={t('Ligule', 'Ligule')}>
      <Row label={t('应用版本', 'Application version')}><span>{loaded ? info?.version ?? unknown : t('正在读取…', 'Loading…')}</span></Row>
      <Row label={t('运行环境', 'Runtime')}><span>{info === null ? unknown : `${info.platform} · ${info.architecture}`}</span></Row>
      <Row label={t('Electron', 'Electron')}><span>{info?.electronVersion ?? unknown}</span></Row>
      <Row label={t('Host Node.js', 'Host Node.js')}><span>{hostNodeVersion ?? unknown}</span></Row>
      <Row label={t('构建编号', 'Build ID')}><span>{buildId}</span></Row>
      <Row label={t('构建日期', 'Build date')}><span>{buildDate}</span></Row>
      <Row label={t('应用状态', 'Application')}><span>{info === null ? unknown : info.packaged ? t('已安装版本', 'Installed package') : t('开发运行', 'Development build')}</span></Row>
    </Group>
    <Group title={t('项目链接与许可', 'Project links and licenses')}>
      <Row label={t('项目主页', 'Project')}>
        <a href="https://github.com/xswt442-cmd/ligule" target="_blank" rel="noreferrer">GitHub</a>
      </Row>
      <Row label={t('Ligule 许可', 'Ligule license')}>
        <a href="https://github.com/xswt442-cmd/ligule/blob/main/LICENSE" target="_blank" rel="noreferrer">MIT License</a>
      </Row>
      <Row label={t('依赖关系', 'Dependencies')}>
        <a href="https://github.com/xswt442-cmd/ligule/network/dependencies" target="_blank" rel="noreferrer">{t('查看依赖图', 'View dependency graph')}</a>
      </Row>
    </Group>
    <Group title={t('诊断摘要', 'Diagnostic summary')}>
      <Row label={t('支持信息', 'Support information')}>
        <button type="button" onClick={() => void copyDiagnostics()}>{t('复制脱敏摘要', 'Copy redacted summary')}</button>
        {copyState !== '' && <span role="status">{copyState}</span>}
      </Row>
      <p className="sheet-note">{t('摘要包含应用和 Host 版本、连接与能力状态、事件及日志行数；不含路径、会话编号、转录内容或原始日志。', 'The summary includes application and Host versions, connection and capability status, and event/log counts. It excludes paths, session IDs, transcript content, and raw logs.')}</p>
    </Group>
    <details className="about-fold">
      <summary>{t('使用手册', 'User guide')}</summary>
      <HelpPanel />
    </details>
    <details className="about-fold">
      <summary>{t('系统与 Host 诊断', 'System and Host diagnostics')}</summary>
      <DiagnosticsPanel status={status} counts={counts} waiting={waiting} link={link} logs={logs} onReconnect={onReconnect} />
    </details>
  </div>;
}
