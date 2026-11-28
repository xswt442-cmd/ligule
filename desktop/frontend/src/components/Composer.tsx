import type { KeyboardEvent, RefObject } from 'react';
import { Popover } from 'radix-ui';
import { Icon } from './Icon';
import { ModelPicker } from './ModelPicker';
import { PolicyPicker } from './PolicyPicker';
import { PermissionPicker } from './PermissionPicker';
import { ScreenCaptureControl } from './ScreenCaptureControl';
import { SessionMenu } from './SessionMenu';
import { WorkspacePicker } from './WorkspacePicker';
import type { MentionState } from '../mentions';
import { CURRENT, formatKeys } from '../hotkeys';
import type { ModelSelection } from '../model-catalog';
import { useText } from '../locale';

type PolicyValue = 'always' | 'ask' | 'auto' | 'never';
import type { Client } from '../protocol';
import type { Status } from '../status';
import type { Settings } from '../settings';
import type { PermissionConfirmations, PermissionTarget } from '../permission-control';

export type MessageQueue = { items: string[]; paused: boolean };

export type ComposerInput = {
  value: string;
  ref: RefObject<HTMLTextAreaElement | null>;
  onChange: (draft: string) => void;
  onCaretChange: (caret: number) => void;
  onWalkChange: (walk: number) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
};

export type ComposerQueue = {
  value: MessageQueue;
  onToggle: () => void;
  onRecover: (index: number, all: boolean) => void;
  onSend: () => void;
  onSteer: () => void;
  onStop: () => void;
};

export type ComposerMode = {
  menuOpen: boolean;
  initialMode: string | null;
  initialPolicy: PolicyValue | null;
  initialPermission: PermissionTarget;
  initialPermissionConfirmations: PermissionConfirmations;
  newSessionSettingsRevision: number;
  modelCatalogRevision: number;
  onMenuChange: (open: boolean) => void;
  onSetMode: (name: string | null) => void;
  onSetPolicy: (mode: PolicyValue | null) => Promise<void>;
  onInitialPermissionChange: (target: PermissionTarget, confirmations: PermissionConfirmations) => void;
  onPermissionStatus: (status: Status) => void;
  onOpenSecurity: () => void;
  onSelectModel: (selection: ModelSelection) => Promise<void>;
  onSetThinking: (effort: string | null) => Promise<void>;
  onManageModel: () => void;
};

export type ComposerMention = {
  state: MentionState | null;
  onPick: (path: string) => void;
};

export function Composer({ client, sessionId, projectRoot, status, settings, settingsReady, closing, reading, starting, running, inputOwner,
  othersRunning, workspaceRevision, onSelectWorkspace, input, queue, mode, mention,
}: {
  client: Client;
  sessionId: string | null;
  projectRoot: string;
  status: Status | null;
  settings: Settings;
  settingsReady: boolean;
  closing: boolean;
  reading: boolean;
  starting: boolean;
  running: boolean;
  inputOwner: string | null;
  othersRunning: number;
  workspaceRevision: number;
  onSelectWorkspace: (root: string) => Promise<void>;
  input: ComposerInput;
  queue: ComposerQueue;
  mode: ComposerMode;
  mention: ComposerMention;
}) {
  const t = useText();
  const draft = input.value;
  const queueState = queue.value;
  const mentionState = mention.state;
  const disabled = closing || reading || starting || !settingsReady || (sessionId !== null && inputOwner !== sessionId);
  const selection = status?.selectedModel
    ? { provider: status.pendingServiceId ?? status.serviceId, model: status.pendingModel ?? status.selectedModel }
    : settings.newSelections[projectRoot] ?? null;

  return <>
    <footer className="composer">
      {sessionId === null && <WorkspacePicker client={client} directory={projectRoot} revision={workspaceRevision}
        disabled={disabled}
        onSelect={onSelectWorkspace} />}
      {queueState.items.length === 0 ? null : <div className="queue">
        <div className="queue-head">
          <span className="mini">{t(`${queueState.items.length} 条待发送`, `${queueState.items.length} queued`)} · {queueState.paused
            ? t('已暂停；本轮剩余消息不会自动发送', 'Paused; remaining messages will not send automatically')
            : running
              ? t('本轮结束后按顺序发送', 'Send in order after this turn')
              : t('会话空闲；收回消息后再发送', 'Conversation is idle; recover messages to send them')}</span>
          <button type="button" className="mini chip" title={queueState.paused ? t('继续发送队列', 'Resume queue') : t('暂停发送队列', 'Pause queue')} onClick={queue.onToggle}>
            {queueState.paused ? t('继续发送', 'Resume') : t('暂停发送', 'Pause')}
          </button>
          <button type="button" className="mini chip" disabled={draft !== ''}
            title={draft === '' ? t('将队列消息移回草稿', 'Move queued messages back to the draft') : t('请先发送或排入当前草稿', 'Send or queue the current draft first')}
            onClick={() => queue.onRecover(0, true)}>{t('全部收回', 'Recover all')}</button>
        </div>
        {queueState.items.map((item, index) => <div className="queue-item" key={`${index}:${item}`}>
          <span className="queue-text">{item}</span>
          <button type="button" className="mini chip" disabled={draft !== ''}
            title={draft === '' ? t('将此消息移回草稿', 'Move this message back to the draft') : t('请先发送或排入当前草稿', 'Send or queue the current draft first')}
            onClick={() => queue.onRecover(index, false)}>{t('收回', 'Recover')}</button>
        </div>)}
      </div>}
      {mentionState === null ? null : <div className="queue" role="listbox" aria-label={t('项目文件', 'Project files')}>
        <span className="mini">{t('项目', 'Project')} {mentionState.root === '' ? t('无法读取目录', 'directory unavailable') : mentionState.root} · {t(`文件名包含“${mentionState.text}”`, `File names containing “${mentionState.text}”`)}</span>
        {mentionState.paths.length === 0
          ? <span className="mini">{mentionState.stopped === 'error'
            ? t(`无法列出项目文件：${mentionState.failed}`, `Could not list project files: ${mentionState.failed}`)
            : mentionState.stopped === 'pending'
              ? t('正在列出项目文件…', 'Listing project files…')
              : mentionState.stopped === 'budget'
                ? t(`已查过的文件中没有“${mentionState.text}”匹配项；可以缩小搜索范围。`, `No match for “${mentionState.text}” in the files checked. Narrow the search.`)
                : t(`没有文件名包含“${mentionState.text}”的项目文件。`, `No project file name contains “${mentionState.text}”.`)}</span>
          : mentionState.paths.map((path, index) => <div className="queue-item" key={path} role="option" aria-selected={index === mentionState.chosen}>
            <span className="queue-text">{path}</span>
            <button type="button" className="mini chip" onClick={() => mention.onPick(path)}>{t('插入', 'Insert')}</button>
          </div>)}
        {mentionState.paths.length > 0 && mentionState.stopped === 'budget' && <span className="mini">{t('已达到搜索范围上限；请缩小搜索范围。', 'Search limit reached. Narrow the search.')}</span>}
        {mentionState.paths.length > 0 && mentionState.stopped === 'unreadable' && <span className="mini">{t('部分目录无法读取，结果可能不完整。', 'Some directories could not be read; results may be incomplete.')}</span>}
        {mentionState.paths.length > 0 && <span className="mini">{t(
          `${formatKeys(CURRENT['pick-candidate'])} 或 ${formatKeys(CURRENT['complete-candidate'])} 选择 · ${formatKeys(CURRENT['candidate-older'])}/${formatKeys(CURRENT['candidate-newer'])} 切换 · ${formatKeys(CURRENT['hide-candidate'])} 关闭`,
          `${formatKeys(CURRENT['pick-candidate'])} or ${formatKeys(CURRENT['complete-candidate'])} to select · ${formatKeys(CURRENT['candidate-older'])}/${formatKeys(CURRENT['candidate-newer'])} to move · ${formatKeys(CURRENT['hide-candidate'])} to close`,
        )}</span>}
      </div>}
      {/* 切换会话期间锁住输入，避免把草稿保存到另一具会话。 */}
      <textarea
        className="composer-input"
        ref={input.ref}
        rows={2}
        value={draft}
        readOnly={closing || reading || starting || inputOwner !== sessionId || !settingsReady}
        placeholder={t('描述任务，使用 @ 引用文件', 'Describe a task, use @ to reference a file')}
        onChange={(event) => {
          input.onChange(event.target.value);
          input.onCaretChange(event.target.selectionStart ?? event.target.value.length);
          input.onWalkChange(-1);
        }}
        onSelect={(event) => input.onCaretChange(event.currentTarget.selectionStart ?? 0)}
        onKeyDown={input.onKeyDown}
      />
      <div className="composer-bar">
        <ModelPicker key={`${projectRoot}:${mode.modelCatalogRevision}`} client={client} projectRoot={projectRoot}
          disabled={disabled} pending={status?.pendingModel !== undefined && status.pendingModel !== null}
          selection={selection}
          thinking={sessionId === null ? null : status?.thinking ?? null}
          onSelect={mode.onSelectModel} onThinking={mode.onSetThinking} onManage={mode.onManageModel} />
        <Popover.Root open={mode.menuOpen} onOpenChange={mode.onMenuChange}>
          <Popover.Trigger asChild><button type="button" className="composer-choice" disabled={disabled} title={t('工具模式', 'Tool mode')}><span>{sessionId === null
            ? mode.initialMode ?? t('默认工具', 'Default mode')
            : status?.mode ?? t('工具模式', 'Tool mode')}</span><Icon name="fold" size={12} /></button></Popover.Trigger>
          <SessionMenu key={`${sessionId ?? '$new'}:${mode.newSessionSettingsRevision}`} status={status} selectedMode={mode.initialMode} onSetMode={mode.onSetMode} />
        </Popover.Root>
        <PermissionPicker key={`permission:${sessionId ?? '$new'}:${mode.newSessionSettingsRevision}`} client={client} sessionId={sessionId} status={status} projectRoot={projectRoot}
          initialPermission={mode.initialPermission} initialConfirmations={mode.initialPermissionConfirmations}
          disabled={disabled || closing || reading || starting} running={running}
          onInitialChange={mode.onInitialPermissionChange} onStatus={mode.onPermissionStatus} onOpenSecurity={mode.onOpenSecurity} />
        <PolicyPicker key={`${sessionId ?? '$new'}:${mode.newSessionSettingsRevision}`} client={client} projectRoot={projectRoot} status={status} initialPolicy={mode.initialPolicy} disabled={disabled || closing || reading || starting} onSelect={mode.onSetPolicy} />
        <span className="bar-spacer" />
        <ScreenCaptureControl key={`screen:${sessionId ?? '$new'}`} client={client} sessionId={sessionId} status={status}
          disabled={disabled} running={running} onStatus={mode.onPermissionStatus} />
        {running && draft.trim() !== '' && <button className="steer-button" type="button" title={t('加入当前运行', 'Add to active run')}
          disabled={disabled} onClick={queue.onSteer}>{t('当前运行', 'Active run')}</button>}
        {running && <button className="icon-button stop-button" type="button" title={t('停止本轮', 'Stop this turn')} aria-label={t('停止本轮', 'Stop this turn')} onClick={queue.onStop}><Icon name="stop" size={15} /></button>}
        <button className="send" type="button" title={running ? t('加入队列', 'Add to queue') : t('发送', 'Send')} aria-label={t('发送', 'Send')} disabled={disabled || draft.trim() === ''} onClick={queue.onSend}><Icon name="send" size={19} /></button>
      </div>
    </footer>
    <div className="composer-hint"><span>{formatKeys(CURRENT.send)} {t('发送', 'to send')} · {formatKeys(CURRENT.newline)} {t('换行', 'for a new line')}</span>{othersRunning > 0 && <span>{othersRunning} {t('个后台任务', 'background tasks')}</span>}</div>
  </>;
}
