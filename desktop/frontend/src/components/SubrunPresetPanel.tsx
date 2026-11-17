import { useCallback, useEffect, useRef, useState } from 'react';
import { code, type Client } from '../protocol';
import { useText } from '../locale';
import { subrunBranchOf, type SubrunBranch } from '../subrun-branches';

type Preset = { readonly id: string; readonly layer?: string; readonly description?: string; readonly errorCode?: string };
type Preview = {
  readonly presetId: string;
  readonly layer: string;
  readonly digest: string;
  readonly description: string;
  readonly instruction: string;
  readonly executable: boolean;
  readonly mode: { readonly name: string; readonly tools: readonly string[] | '*'; readonly prompt: readonly string[] | '*' };
  readonly permission: { readonly profile: string; readonly network: string };
  readonly generation: { readonly outputTokens: number | null; readonly thinkingEffort: string | null };
  readonly limits: { readonly loopIterations: number; readonly modelCalls: number };
  readonly outputSchemaDigest?: string;
  readonly requiredChecks: readonly string[];
  readonly narrowedFields: readonly string[];
};
type PreviewState = { readonly sessionId: string; readonly parentRunId: string | null; readonly presetId: string;
  readonly runStatusKnown: boolean; readonly value: Preview };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function presetPage(value: unknown): { readonly presets: Preset[]; readonly nextCursor?: string } {
  if (!isRecord(value) || !Array.isArray(value.presets)) throw new Error('preset_list_response_invalid');
  const presets = value.presets.flatMap((item): Preset[] => {
    if (!isRecord(item) || typeof item.id !== 'string' || item.id === '') return [];
    return [{ id: item.id,
      ...(typeof item.layer === 'string' ? { layer: item.layer } : {}),
      ...(typeof item.description === 'string' ? { description: item.description } : {}),
      ...(typeof item.errorCode === 'string' ? { errorCode: item.errorCode } : {}),
    }];
  });
  if (value.nextCursor !== undefined && typeof value.nextCursor !== 'string') throw new Error('preset_list_response_invalid');
  return { presets, ...(typeof value.nextCursor === 'string' ? { nextCursor: value.nextCursor } : {}) };
}

function presetPreview(value: unknown): Preview {
  if (!isRecord(value) || typeof value.presetId !== 'string' || typeof value.layer !== 'string'
    || typeof value.digest !== 'string' || typeof value.description !== 'string' || typeof value.instruction !== 'string'
    || typeof value.executable !== 'boolean' || !isRecord(value.mode) || typeof value.mode.name !== 'string'
    || !(value.mode.tools === '*' || Array.isArray(value.mode.tools)) || !(value.mode.prompt === '*' || Array.isArray(value.mode.prompt))
    || !isRecord(value.permission) || typeof value.permission.profile !== 'string' || typeof value.permission.network !== 'string'
    || !isRecord(value.generation) || !(value.generation.outputTokens === null || typeof value.generation.outputTokens === 'number')
    || !(value.generation.thinkingEffort === null || typeof value.generation.thinkingEffort === 'string')
    || !isRecord(value.limits) || typeof value.limits.loopIterations !== 'number' || typeof value.limits.modelCalls !== 'number'
    || !Array.isArray(value.requiredChecks) || !Array.isArray(value.narrowedFields)) {
    throw new Error('preset_preview_response_invalid');
  }
  return value as unknown as Preview;
}

function errorCode(error: unknown, fallback: string): string {
  const value = code(error);
  return /^[a-z][a-z0-9_]{0,79}$/u.test(value) ? value : fallback;
}

export function SubrunPresetPanel({ client, sessionId, activeRunId, runStatusKnown, onStarted }: {
  client: Client;
  sessionId: string | null;
  activeRunId: string | null;
  runStatusKnown: boolean;
  onStarted: (branch: SubrunBranch) => void;
}) {
  const t = useText();
  const listGeneration = useRef(0);
  const previewGeneration = useRef(0);
  const taskRevision = useRef(0);
  const current = useRef({ sessionId, activeRunId, runStatusKnown, presetId: '' });
  const [presets, setPresets] = useState<Preset[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState('');
  const [task, setTask] = useState('');
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<'preview' | 'start' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<'subrun_started' | 'subrun_started_refresh_failed' | null>(null);
  const [startAccepted, setStartAccepted] = useState(false);
  current.current = { sessionId, activeRunId, runStatusKnown, presetId: selectedPresetId };

  useEffect(() => {
    const generation = ++listGeneration.current;
    previewGeneration.current += 1;
    setPresets([]);
    setSelectedPresetId('');
    setTask('');
    taskRevision.current += 1;
    setPreview(null);
    setError(null);
    setNotice(null);
    setBusy(null);
    setLoading(false);
    setStartAccepted(false);
    if (sessionId === null) return () => undefined;
    setLoading(true);
    void (async () => {
      try {
        const collected: Preset[] = [];
        let cursor: string | undefined;
        const cursors = new Set<string>();
        for (let pageNumber = 0; pageNumber < 6; pageNumber += 1) {
          const response = presetPage(await client.call('preset.list', {
            sessionId, limit: 64, ...(cursor === undefined ? {} : { cursor }),
          }));
          collected.push(...response.presets);
          cursor = response.nextCursor;
          if (cursor === undefined) break;
          if (cursors.has(cursor)) throw new Error('preset_list_cursor_repeated');
          cursors.add(cursor);
          if (pageNumber === 5) throw new Error('agent_preset_list_truncated');
        }
        if (listGeneration.current !== generation || current.current.sessionId !== sessionId) return;
        setPresets(collected);
        setSelectedPresetId((previous) => previous !== '' && collected.some(item => item.id === previous)
          ? previous : collected.find(item => item.errorCode === undefined)?.id ?? collected[0]?.id ?? '');
      } catch (cause) {
        if (listGeneration.current === generation && current.current.sessionId === sessionId) {
          setError(errorCode(cause, 'preset_list_failed'));
        }
      } finally {
        if (listGeneration.current === generation && current.current.sessionId === sessionId) setLoading(false);
      }
    })();
    return () => { listGeneration.current += 1; };
  }, [client, sessionId]);

  useEffect(() => {
    previewGeneration.current += 1;
    setPreview(null);
    setBusy(null);
    setError(null);
    setNotice(null);
    setStartAccepted(false);
  }, [sessionId, activeRunId, runStatusKnown]);

  const selectedPreset = presets.find(item => item.id === selectedPresetId) ?? null;
  const previewMatches = preview !== null && preview.sessionId === sessionId
    && preview.parentRunId === activeRunId && preview.presetId === selectedPresetId
    && preview.runStatusKnown === runStatusKnown;

  const changePreset = useCallback((presetId: string) => {
    previewGeneration.current += 1;
    setSelectedPresetId(presetId);
    setPreview(null);
    setError(null);
    setNotice(null);
    setStartAccepted(false);
  }, []);

  const previewSelected = useCallback(async () => {
    if (sessionId === null || !runStatusKnown || selectedPreset === null || selectedPreset.errorCode !== undefined) return;
    const generation = ++previewGeneration.current;
    const targetSessionId = sessionId;
    const targetRunId = activeRunId;
    const targetPresetId = selectedPreset.id;
    setBusy('preview');
    setPreview(null);
    setError(null);
    setNotice(null);
    try {
      const value = presetPreview(await client.call('preset.preview', {
        sessionId: targetSessionId,
        presetId: targetPresetId,
        ...(targetRunId === null ? {} : { parentRunId: targetRunId }),
      }));
      if (previewGeneration.current !== generation || current.current.sessionId !== targetSessionId
        || current.current.activeRunId !== targetRunId || !current.current.runStatusKnown
        || current.current.presetId !== targetPresetId) return;
      setPreview({ sessionId: targetSessionId, parentRunId: targetRunId, presetId: targetPresetId, runStatusKnown, value });
    } catch (cause) {
      if (previewGeneration.current === generation && current.current.sessionId === targetSessionId
        && current.current.activeRunId === targetRunId && current.current.runStatusKnown
        && current.current.presetId === targetPresetId) {
        setError(errorCode(cause, 'preset_preview_failed'));
      }
    } finally {
      if (previewGeneration.current === generation && current.current.sessionId === targetSessionId
        && current.current.activeRunId === targetRunId && current.current.runStatusKnown) setBusy(null);
    }
  }, [activeRunId, client, runStatusKnown, selectedPreset, sessionId]);

  const startSelected = useCallback(async () => {
    if (sessionId === null || !runStatusKnown || activeRunId === null || selectedPreset === null || preview === null || !previewMatches
      || preview.value.executable !== true || selectedPreset.errorCode !== undefined || task.trim() === '') return;
    const targetSessionId = sessionId;
    const targetRunId = activeRunId;
    const targetPresetId = selectedPreset.id;
    const submittedTask = task.trim();
    const submittedRevision = taskRevision.current;
    const generation = ++previewGeneration.current;
    let startedReference: { readonly subrunId: string; readonly sessionId: string; readonly runId: string } | null = null;
    setBusy('start');
    setError(null);
    setNotice(null);
    try {
      const started = await client.call('subrun.start', {
        sessionId: targetSessionId,
        parentRunId: targetRunId,
        task: submittedTask,
        presetId: targetPresetId,
      }) as { subrunId?: unknown; sessionId?: unknown; runId?: unknown };
      if (typeof started.subrunId !== 'string' || typeof started.sessionId !== 'string' || typeof started.runId !== 'string') {
        throw new Error('subrun_start_reference_invalid');
      }
      startedReference = { subrunId: started.subrunId, sessionId: started.sessionId, runId: started.runId };
      setStartAccepted(true);
      const record = await client.call('session.read', { sessionId: targetSessionId, fullResults: true }) as { events?: unknown };
      const events = Array.isArray(record.events) ? record.events : [];
      const branch = events.map(event => isRecord(event) ? subrunBranchOf(event) : null)
        .find((item): item is SubrunBranch => item !== null && item.id === started.sessionId
          && item.reference?.parentRunId === targetRunId && item.reference.runId === started.runId);
      if (branch === undefined) throw new Error('subrun_activity_record_missing');
      if (previewGeneration.current !== generation || current.current.sessionId !== targetSessionId
        || current.current.activeRunId !== targetRunId || !current.current.runStatusKnown
        || current.current.presetId !== targetPresetId) return;
      onStarted(branch);
      if (taskRevision.current === submittedRevision) {
        taskRevision.current += 1;
        setTask('');
      }
      setNotice('subrun_started');
    } catch (cause) {
      if (previewGeneration.current === generation && current.current.sessionId === targetSessionId
        && current.current.activeRunId === targetRunId && current.current.runStatusKnown
        && current.current.presetId === targetPresetId) {
        if (startedReference !== null) {
          setNotice('subrun_started_refresh_failed');
          setError(errorCode(cause, 'subrun_started_but_reload_failed'));
        } else {
          setError(errorCode(cause, 'subrun_start_failed'));
        }
      }
    } finally {
      if (previewGeneration.current === generation && current.current.sessionId === targetSessionId
        && current.current.activeRunId === targetRunId && current.current.runStatusKnown) setBusy(null);
    }
  }, [activeRunId, client, onStarted, preview, previewMatches, runStatusKnown, selectedPreset, sessionId, task]);

  const previewValue = previewMatches ? preview.value : null;
  const layerLabel = (layer: string | undefined) => layer === 'project' ? t('项目', 'Project')
    : layer === 'user' ? t('用户', 'User') : layer === 'shipped' ? t('内置', 'Built in') : layer ?? '';
  const list = (value: readonly string[] | '*') => value === '*' ? t('全部', 'All') : value.join('、');
  const permissionLabel = (value: string) => value === 'read-only' ? t('只读', 'read-only')
    : value === 'workspace-write' ? t('工作区可写', 'workspace write')
      : value === 'full-access' ? t('完整访问', 'full access') : value;
  const networkLabel = (value: string) => value === 'policy' ? t('按策略', 'policy')
    : value === 'disabled' ? t('关闭', 'disabled') : value === 'unrestricted' ? t('不限制', 'unrestricted') : value;

  return <section aria-label={t('任务预设控制', 'Task preset controls')}>
    <h3>{t('任务预设', 'Task presets')}</h3>
    {loading && <p className="stub">{t('正在读取预设…', 'Loading presets…')}</p>}
    {presets.length > 0 && <>
      <label>
        {t('任务预设', 'Task preset')}
        <select aria-label={t('任务预设', 'Task preset')} value={selectedPresetId} onChange={event => changePreset(event.currentTarget.value)}>
          {presets.map(item => <option key={`${item.layer ?? ''}:${item.id}`} value={item.id} disabled={item.errorCode !== undefined}>
            {item.id}{item.layer === undefined ? '' : ` · ${layerLabel(item.layer)}`}
            {item.errorCode === undefined ? '' : ` · ${t(`无效 ${item.errorCode}`, `invalid ${item.errorCode}`)}`}
          </option>)}
        </select>
      </label>
      {selectedPreset?.description && <p className="muted">{selectedPreset.description}</p>}
      <button type="button" disabled={!runStatusKnown || busy !== null || selectedPreset === null || selectedPreset.errorCode !== undefined}
        onClick={() => void previewSelected()}>{t('预览配置', 'Preview configuration')}</button>
      {!runStatusKnown && <p className="stub">{t('正在确认父任务状态…', 'Checking parent Run status…')}</p>}
      {runStatusKnown && activeRunId === null && <p className="stub">{t('当前没有运行中的父任务，只能查看预设。', 'No parent Run is active; presets can be previewed only.')}</p>}
      {previewValue !== null && <div role="region" aria-label={t('预设配置预览', 'Preset configuration preview')}>
        <h4>{previewValue.description}</h4>
        <dl>
          <dt>{t('可启动', 'Executable')}</dt><dd>{previewValue.executable ? t('是', 'Yes') : t('否', 'No')}</dd>
          <dt>{t('来源', 'Layer')}</dt><dd>{layerLabel(previewValue.layer)}</dd>
          <dt>{t('模式与工具', 'Mode and tools')}</dt><dd>{previewValue.mode.name} · {list(previewValue.mode.tools)}</dd>
          <dt>{t('提示片段', 'Prompt fragments')}</dt><dd>{list(previewValue.mode.prompt)}</dd>
          <dt>{t('权限与网络', 'Permission and network')}</dt><dd>
            {permissionLabel(previewValue.permission.profile)} · {networkLabel(previewValue.permission.network)}
          </dd>
          <dt>{t('输出上限与思考档', 'Output limit and thinking')}</dt><dd>
            {previewValue.generation.outputTokens ?? t('未指定', 'unspecified')} · {previewValue.generation.thinkingEffort ?? t('未指定', 'unspecified')}
          </dd>
          <dt>{t('任务上限', 'Task limits')}</dt><dd>
            {previewValue.limits.loopIterations} {t('轮', 'iterations')} · {previewValue.limits.modelCalls} {t('次模型调用', 'model calls')}
          </dd>
          <dt>{t('必需检查', 'Required checks')}</dt><dd>{previewValue.requiredChecks.length === 0 ? t('无', 'None') : previewValue.requiredChecks.join('、')}</dd>
          {previewValue.outputSchemaDigest !== undefined && <><dt>{t('输出格式摘要', 'Output schema digest')}</dt><dd>{previewValue.outputSchemaDigest}</dd></>}
          <dt>{t('预设版本摘要', 'Preset digest')}</dt><dd>{previewValue.digest}</dd>
          {previewValue.narrowedFields.length > 0 && <><dt>{t('被收窄设置', 'Narrowed settings')}</dt><dd>{previewValue.narrowedFields.join('、')}</dd></>}
        </dl>
        <details><summary>{t('查看预设指令', 'View preset instructions')}</summary><pre>{previewValue.instruction}</pre></details>
        {previewValue.executable === false && activeRunId !== null
          && <p className="stub">{t('Host 当前判定此预设不可启动。', 'The Host currently marks this preset as not executable.')}</p>}
      </div>}
      <label>
        {t('任务内容', 'Task')}
        <textarea aria-label={t('任务内容', 'Task')} value={task} onChange={event => {
          taskRevision.current += 1;
          setTask(event.currentTarget.value);
          setStartAccepted(false);
          setNotice(null);
          setError(null);
        }} />
      </label>
      <button type="button" disabled={busy !== null || activeRunId === null || selectedPreset === null
        || selectedPreset.errorCode !== undefined || !previewMatches || previewValue?.executable !== true || task.trim() === '' || startAccepted}
        onClick={() => void startSelected()}>{busy === 'start' ? t('正在启动…', 'Starting…') : t('启动子任务', 'Start subtask')}</button>
    </>}
    {!loading && presets.length === 0 && error === null && <p className="stub">{t('没有可用的任务预设。', 'No task presets are available.')}</p>}
    {error !== null && <p className="stub" role="alert">{t(`预设操作失败：${error}`, `Preset operation failed: ${error}`)}</p>}
    {notice === 'subrun_started' && <p className="stub">{t('子任务已启动。', 'Subtask started.')}</p>}
    {notice === 'subrun_started_refresh_failed' && <p className="stub" role="alert">
      {t('子任务已经启动，但面板没能读取它的记录。重新打开面板查看，避免重复启动。',
        'The subtask started, but the panel could not read its record. Reopen the panel to check before starting another.')}
    </p>}
  </section>;
}
