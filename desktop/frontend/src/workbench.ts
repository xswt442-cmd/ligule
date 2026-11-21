import { object } from './guards.ts';

export type WorkbenchResource =
  | { readonly kind: 'file'; readonly projectRoot: string; readonly path: string; readonly line?: number; readonly version?: string }
  | { readonly kind: 'directory'; readonly projectRoot: string; readonly path: string }
  | { readonly kind: 'git'; readonly projectRoot: string; readonly path?: string; readonly version?: string }
  | { readonly kind: 'diff'; readonly projectRoot: string; readonly path: string; readonly beforeVersion: string; readonly afterVersion: string }
  | { readonly kind: 'execution'; readonly sessionId: string; readonly runId: string; readonly executionId: string }
  | { readonly kind: 'subrun'; readonly sessionId: string; readonly parentRunId: string; readonly subrunId: string; readonly childSessionId: string; readonly childRunId: string }
  | { readonly kind: 'artifact'; readonly projectRoot: string; readonly sessionId: string; readonly artifactKey: string }
  | { readonly kind: 'check'; readonly projectRoot?: string; readonly sessionId: string; readonly runId: string; readonly eventSeq: number }
  | { readonly kind: 'diagnostics'; readonly sessionId: string }
  | { readonly kind: 'side-session'; readonly projectRoot?: string; readonly sessionId: string; readonly originSessionId: string }
  | { readonly kind: 'panel'; readonly panelId: 'panel.delivery' | 'panel.branch' | 'panel.diagnostics' | 'panel.export' | 'panel.help'; readonly projectRoot?: string; readonly sessionId?: string };

export type WorkbenchTab = {
  readonly key: string;
  readonly title: string;
  readonly resource: WorkbenchResource;
  readonly pinned: boolean;
  readonly fileDraft?: WorkbenchFileDraft;
};

export type WorkbenchCommandReference = {
  readonly sourceSessionId: string;
  readonly operationSessionId: string;
  readonly operationId: string;
  readonly executionId: string;
};

export type WorkbenchFileDraft = { readonly version: string; readonly text: string };

export type WorkbenchState = {
  readonly version: 1;
  readonly rightOpen: boolean;
  readonly bottomOpen: boolean;
  readonly rightWidth: number;
  readonly bottomHeight: number;
  readonly tabs: readonly WorkbenchTab[];
  readonly activeKey: string | null;
  readonly commandTabs: readonly WorkbenchCommandReference[];
  readonly activeCommandKey: string | null;
};

export const MAX_WORKBENCH_TABS = 24;
export const MAX_WORKBENCH_COMMANDS = 24;
export const MAX_WORKBENCH_FILE_DRAFT_BYTES = 256 * 1024;
export const MAX_WORKBENCH_DRAFT_BYTES = 768 * 1024;
const MAX_TITLE_LENGTH = 160;
const MAX_ID_LENGTH = 160;
const MAX_PATH_LENGTH = 4096;

export const DEFAULT_WORKBENCH_STATE: WorkbenchState = {
  version: 1,
  rightOpen: false,
  bottomOpen: false,
  rightWidth: 420,
  bottomHeight: 220,
  tabs: [],
  activeKey: null,
  commandTabs: [],
  activeCommandKey: null,
};

function safeString(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    && !/[\u0000-\u001f\u007f]/u.test(value) ? value : undefined;
}

function absoluteRoot(value: unknown): string | undefined {
  const root = safeString(value, MAX_PATH_LENGTH);
  if (root === undefined) return undefined;
  let normalized = root.replaceAll('\\', '/').replace(/\/+$/u, '');
  if (normalized === '') normalized = '/';
  else if (/^[a-z]:$/iu.test(normalized)) normalized += '/';
  if (!(normalized.startsWith('/') || /^[a-z]:\//iu.test(normalized) || normalized.startsWith('//'))) return undefined;
  if (normalized.split('/').includes('..')) return undefined;
  return normalized;
}

function relativePath(value: unknown): string | undefined {
  const path = safeString(value, MAX_PATH_LENGTH);
  if (path === undefined || path.startsWith('/') || path.startsWith('\\') || /^[a-z]:/iu.test(path)) return undefined;
  const parts = path.replaceAll('\\', '/').split('/').filter(part => part !== '' && part !== '.');
  if (parts.length === 0 || parts.some(part => part === '..')) return undefined;
  return parts.join('/');
}

function identifier(value: unknown): string | undefined {
  return safeString(value, MAX_ID_LENGTH);
}

export function commandReferenceKey(reference: WorkbenchCommandReference): string {
  return JSON.stringify(['command', reference.sourceSessionId, reference.operationSessionId,
    reference.operationId, reference.executionId]);
}

function commandReferenceFrom(value: unknown): WorkbenchCommandReference | undefined {
  if (!object(value) || Object.keys(value).some(key => !['sourceSessionId', 'operationSessionId', 'operationId', 'executionId'].includes(key))) {
    return undefined;
  }
  const sourceSessionId = identifier(value.sourceSessionId);
  const operationSessionId = identifier(value.operationSessionId);
  const operationId = identifier(value.operationId);
  const executionId = identifier(value.executionId);
  return sourceSessionId === undefined || operationSessionId === undefined || operationId === undefined || executionId === undefined
    ? undefined : { sourceSessionId, operationSessionId, operationId, executionId };
}

function hash(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-f0-9]{64}$/iu.test(value) ? value.toLowerCase() : undefined;
}

function fileVersion(value: unknown): string | undefined {
  return typeof value === 'string' && /^(?:[a-f0-9]{16}|[a-f0-9]{64})$/iu.test(value) ? value.toLowerCase() : undefined;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function fileDraftFrom(value: unknown): WorkbenchFileDraft | undefined {
  if (!object(value) || Object.keys(value).some(key => key !== 'version' && key !== 'text')) return undefined;
  const version = fileVersion(value.version);
  if (version === undefined || typeof value.text !== 'string' || value.text.includes('\u0000')
    || byteLength(value.text) > MAX_WORKBENCH_FILE_DRAFT_BYTES) return undefined;
  return { version, text: value.text };
}

function resourceFrom(value: unknown): WorkbenchResource | undefined {
  if (!object(value)) return undefined;
  switch (value.kind) {
    case 'file': {
      const projectRoot = absoluteRoot(value.projectRoot);
      const path = relativePath(value.path);
      const version = value.version === undefined ? undefined : fileVersion(value.version);
      if (projectRoot === undefined || path === undefined || value.version !== undefined && version === undefined
        || value.line !== undefined && (!Number.isSafeInteger(value.line) || (value.line as number) < 1)) return undefined;
      return { kind: 'file', projectRoot, path,
        ...(value.line === undefined ? {} : { line: value.line as number }),
        ...(version === undefined ? {} : { version }) };
    }
    case 'directory': {
      const projectRoot = absoluteRoot(value.projectRoot);
      const path = value.path === '.' ? '.' : relativePath(value.path);
      if (projectRoot === undefined || path === undefined) return undefined;
      return { kind: 'directory', projectRoot, path };
    }
    case 'git': {
      const projectRoot = absoluteRoot(value.projectRoot);
      const path = value.path === undefined ? undefined : relativePath(value.path);
      const version = value.version === undefined ? undefined : hash(value.version);
      if (projectRoot === undefined || value.path !== undefined && path === undefined
        || value.version !== undefined && (version === undefined || path === undefined)) return undefined;
      return { kind: 'git', projectRoot, ...(path === undefined ? {} : { path }), ...(version === undefined ? {} : { version }) };
    }
    case 'diff': {
      const projectRoot = absoluteRoot(value.projectRoot);
      const path = relativePath(value.path);
      const beforeVersion = fileVersion(value.beforeVersion);
      const afterVersion = fileVersion(value.afterVersion);
      if (projectRoot === undefined || path === undefined || beforeVersion === undefined || afterVersion === undefined) return undefined;
      return { kind: 'diff', projectRoot, path, beforeVersion, afterVersion };
    }
    case 'execution': {
      const sessionId = identifier(value.sessionId);
      const runId = identifier(value.runId);
      const executionId = identifier(value.executionId);
      return sessionId === undefined || runId === undefined || executionId === undefined
        ? undefined : { kind: 'execution', sessionId, runId, executionId };
    }
    case 'subrun': {
      const sessionId = identifier(value.sessionId);
      const parentRunId = identifier(value.parentRunId);
      const subrunId = identifier(value.subrunId);
      const childSessionId = identifier(value.childSessionId);
      const childRunId = identifier(value.childRunId);
      return sessionId === undefined || parentRunId === undefined || subrunId === undefined
        || childSessionId === undefined || childRunId === undefined
        ? undefined : { kind: 'subrun', sessionId, parentRunId, subrunId, childSessionId, childRunId };
    }
    case 'artifact': {
      const projectRoot = absoluteRoot(value.projectRoot);
      const sessionId = identifier(value.sessionId);
      const artifactKey = hash(value.artifactKey);
      return projectRoot === undefined || sessionId === undefined || artifactKey === undefined
        ? undefined : { kind: 'artifact', projectRoot, sessionId, artifactKey };
    }
    case 'check': {
      const projectRoot = value.projectRoot === undefined ? undefined : absoluteRoot(value.projectRoot);
      const sessionId = identifier(value.sessionId);
      const runId = identifier(value.runId);
      return sessionId === undefined || runId === undefined || value.projectRoot !== undefined && projectRoot === undefined
        || !Number.isSafeInteger(value.eventSeq)
        || (value.eventSeq as number) < 0
        ? undefined : { kind: 'check', ...(projectRoot === undefined ? {} : { projectRoot }), sessionId, runId, eventSeq: value.eventSeq as number };
    }
    case 'diagnostics': {
      const sessionId = identifier(value.sessionId);
      return sessionId === undefined ? undefined : { kind: 'diagnostics', sessionId };
    }
    case 'side-session': {
      const projectRoot = value.projectRoot === undefined ? undefined : absoluteRoot(value.projectRoot);
      const sessionId = identifier(value.sessionId);
      const originSessionId = identifier(value.originSessionId);
      return sessionId === undefined || originSessionId === undefined || value.projectRoot !== undefined && projectRoot === undefined
        ? undefined : { kind: 'side-session', ...(projectRoot === undefined ? {} : { projectRoot }), sessionId, originSessionId };
    }
    case 'panel': {
      const panelIds = ['panel.delivery', 'panel.branch', 'panel.diagnostics', 'panel.export', 'panel.help'] as const;
      const panelId = panelIds.find(candidate => candidate === value.panelId);
      const projectRoot = value.projectRoot === undefined ? undefined : absoluteRoot(value.projectRoot);
      const sessionId = value.sessionId === undefined ? undefined : identifier(value.sessionId);
      if (panelId === undefined || value.projectRoot !== undefined && projectRoot === undefined
        || value.sessionId !== undefined && sessionId === undefined) return undefined;
      return { kind: 'panel', panelId,
        ...(projectRoot === undefined ? {} : { projectRoot }),
        ...(sessionId === undefined ? {} : { sessionId }) };
    }
    default: return undefined;
  }
}

function rootIdentity(root: string): string {
  const normalized = root.replaceAll('\\', '/').replace(/\/+$/u, '');
  return /^[a-z]:\//iu.test(normalized) || normalized.startsWith('//') ? normalized.toLowerCase() : normalized;
}

function pathIdentity(root: string, path: string): string {
  return /^[a-z]:\//iu.test(root) || root.startsWith('//') ? path.toLowerCase() : path;
}

function resourceKey(resource: WorkbenchResource): string {
  switch (resource.kind) {
    case 'file': return JSON.stringify(['file', rootIdentity(resource.projectRoot), pathIdentity(resource.projectRoot, resource.path)]);
    case 'directory': return JSON.stringify(['directory', rootIdentity(resource.projectRoot), pathIdentity(resource.projectRoot, resource.path)]);
    case 'git': return resource.path === undefined
      ? JSON.stringify(['git', rootIdentity(resource.projectRoot)])
      : JSON.stringify(['git', rootIdentity(resource.projectRoot), pathIdentity(resource.projectRoot, resource.path), resource.version ?? null]);
    case 'diff': return JSON.stringify(['diff', rootIdentity(resource.projectRoot), pathIdentity(resource.projectRoot, resource.path),
      resource.beforeVersion, resource.afterVersion]);
    case 'execution': return JSON.stringify(['execution', resource.sessionId, resource.runId, resource.executionId]);
    case 'subrun': return JSON.stringify(['subrun', resource.sessionId, resource.parentRunId,
      resource.subrunId, resource.childSessionId, resource.childRunId]);
    case 'artifact': return JSON.stringify(['artifact', rootIdentity(resource.projectRoot), resource.sessionId, resource.artifactKey]);
    case 'check': return JSON.stringify(['check', resource.projectRoot === undefined ? '' : rootIdentity(resource.projectRoot),
      resource.sessionId, resource.runId, resource.eventSeq]);
    case 'diagnostics': return JSON.stringify(['diagnostics', resource.sessionId]);
    case 'side-session': return JSON.stringify(['side-session', resource.projectRoot === undefined ? '' : rootIdentity(resource.projectRoot),
      resource.sessionId, resource.originSessionId]);
    case 'panel': return JSON.stringify(['panel', resource.panelId,
      resource.projectRoot === undefined ? '' : rootIdentity(resource.projectRoot), resource.sessionId ?? '']);
  }
}

function titleOf(value: unknown): string | undefined {
  return safeString(value, MAX_TITLE_LENGTH)?.trim() || undefined;
}

function tabFrom(value: unknown): WorkbenchTab | undefined {
  if (!object(value)) return undefined;
  const resource = resourceFrom(value.resource);
  const title = titleOf(value.title);
  if (resource === undefined || title === undefined) return undefined;
  const fileDraft = value.fileDraft === undefined ? undefined : fileDraftFrom(value.fileDraft);
  if (value.fileDraft !== undefined && (resource.kind !== 'file' || fileDraft === undefined)) return undefined;
  return { key: resourceKey(resource), title, resource, pinned: value.pinned === true,
    ...(fileDraft === undefined ? {} : { fileDraft }) };
}

function size(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? Math.round(value) : fallback;
}

export function workbenchStateFrom(value: unknown): WorkbenchState {
  if (!object(value) || value.version !== 1) return DEFAULT_WORKBENCH_STATE;
  const candidates = Array.isArray(value.tabs) ? value.tabs.slice(-MAX_WORKBENCH_TABS) : [];
  const tabs: WorkbenchTab[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const tab = tabFrom(candidate);
    if (tab === undefined || seen.has(tab.key)) continue;
    seen.add(tab.key);
    tabs.push(tab);
  }
  const requestedActive = value.activeKey === null ? null : typeof value.activeKey === 'string' ? value.activeKey : undefined;
  const activeKey = requestedActive === null ? null
    : requestedActive !== undefined && seen.has(requestedActive) ? requestedActive : tabs.at(-1)?.key ?? null;
  const commandCandidates = Array.isArray(value.commandTabs) ? value.commandTabs.slice(-MAX_WORKBENCH_COMMANDS) : [];
  const commandTabs: WorkbenchCommandReference[] = [];
  const commandKeys = new Set<string>();
  for (const candidate of commandCandidates) {
    const reference = commandReferenceFrom(candidate);
    if (reference === undefined) continue;
    const key = commandReferenceKey(reference);
    if (commandKeys.has(key)) continue;
    commandKeys.add(key);
    commandTabs.push(reference);
  }
  const requestedCommand = typeof value.activeCommandKey === 'string' ? value.activeCommandKey : value.activeCommandKey === null ? null : undefined;
  const activeCommandKey = requestedCommand === null ? null
    : requestedCommand !== undefined && commandKeys.has(requestedCommand) ? requestedCommand
      : commandTabs.at(-1) === undefined ? null : commandReferenceKey(commandTabs.at(-1)!);
  return {
    version: 1,
    rightOpen: value.rightOpen === true,
    bottomOpen: value.bottomOpen === true,
    rightWidth: size(value.rightWidth, 320, 900, DEFAULT_WORKBENCH_STATE.rightWidth),
    bottomHeight: size(value.bottomHeight, 160, 680, DEFAULT_WORKBENCH_STATE.bottomHeight),
    tabs,
    activeKey,
    commandTabs,
    activeCommandKey,
  };
}

function checkedState(value: WorkbenchState): WorkbenchState {
  if (value.version !== 1 || !Array.isArray(value.tabs) || value.tabs.length > MAX_WORKBENCH_TABS
    || !Array.isArray(value.commandTabs) || value.commandTabs.length > MAX_WORKBENCH_COMMANDS) {
    throw Object.assign(new Error('workbench_state_invalid'), { code: 'workbench_state_invalid' });
  }
  const current = workbenchStateFrom(value);
  const draftBytes = current.tabs.reduce((total, tab) => total + (tab.fileDraft === undefined ? 0 : byteLength(tab.fileDraft.text)), 0);
  if (draftBytes > MAX_WORKBENCH_DRAFT_BYTES) {
    throw Object.assign(new Error('workbench_file_draft_limit'), { code: 'workbench_file_draft_limit' });
  }
  return current;
}

export function addWorkbenchCommand(state: WorkbenchState, input: WorkbenchCommandReference): WorkbenchState {
  const current = checkedState(state);
  const reference = commandReferenceFrom(input);
  if (reference === undefined) throw Object.assign(new Error('workbench_command_reference_invalid'), { code: 'workbench_command_reference_invalid' });
  const key = commandReferenceKey(reference);
  if (current.commandTabs.some(candidate => commandReferenceKey(candidate) === key)) {
    return { ...current, bottomOpen: true, activeCommandKey: key };
  }
  if (current.commandTabs.length >= MAX_WORKBENCH_COMMANDS) {
    throw Object.assign(new Error('workbench_command_limit'), { code: 'workbench_command_limit' });
  }
  return { ...current, bottomOpen: true, commandTabs: [...current.commandTabs, reference], activeCommandKey: key };
}

// 命令已在 Host 启动但视图代次已失效时使用：只登记引用这一事实，
// 不打开工作台，也不改变当前会话的选中项。
export function registerWorkbenchCommand(state: WorkbenchState, input: WorkbenchCommandReference): WorkbenchState {
  const current = checkedState(state);
  const reference = commandReferenceFrom(input);
  if (reference === undefined) throw Object.assign(new Error('workbench_command_reference_invalid'), { code: 'workbench_command_reference_invalid' });
  const key = commandReferenceKey(reference);
  if (current.commandTabs.some(candidate => commandReferenceKey(candidate) === key)) return current;
  if (current.commandTabs.length >= MAX_WORKBENCH_COMMANDS) {
    throw Object.assign(new Error('workbench_command_limit'), { code: 'workbench_command_limit' });
  }
  return { ...current, commandTabs: [...current.commandTabs, reference] };
}

export function selectWorkbenchCommand(state: WorkbenchState, key: string): WorkbenchState {
  const current = checkedState(state);
  return current.commandTabs.some(reference => commandReferenceKey(reference) === key)
    ? { ...current, bottomOpen: true, activeCommandKey: key } : current;
}

export function closeWorkbenchCommand(state: WorkbenchState, key: string): WorkbenchState {
  const current = checkedState(state);
  if (!current.commandTabs.some(reference => commandReferenceKey(reference) === key)) return current;
  const commandTabs = current.commandTabs.filter(reference => commandReferenceKey(reference) !== key);
  const activeCommandKey = current.activeCommandKey === key
    ? commandTabs.at(-1) === undefined ? null : commandReferenceKey(commandTabs.at(-1)!)
    : current.activeCommandKey;
  return { ...current, commandTabs, activeCommandKey, bottomOpen: commandTabs.length > 0 && current.bottomOpen };
}

export function updateWorkbenchFileDraft(state: WorkbenchState, key: string, value: WorkbenchFileDraft | undefined): WorkbenchState {
  const current = checkedState(state);
  const index = current.tabs.findIndex(tab => tab.key === key);
  const tab = current.tabs[index];
  if (tab === undefined || tab.resource.kind !== 'file') {
    throw Object.assign(new Error('workbench_file_resource_required'), { code: 'workbench_file_resource_required' });
  }
  const fileDraft = value === undefined ? undefined : fileDraftFrom(value);
  if (value !== undefined && fileDraft === undefined) {
    throw Object.assign(new Error('workbench_file_draft_too_large'), { code: 'workbench_file_draft_too_large' });
  }
  const nextTab: WorkbenchTab = { key: tab.key, title: tab.title, resource: tab.resource, pinned: tab.pinned,
    ...(fileDraft === undefined ? {} : { fileDraft }) };
  const tabs = [...current.tabs];
  tabs[index] = nextTab;
  return checkedState({ ...current, tabs });
}

export function registerWorkbenchResource(state: WorkbenchState, input: WorkbenchResource, rawTitle: string): WorkbenchState {
  // 只登记 tab：保留调用前的 rightOpen 与 activeKey（含显式 null），不把新资源切到前台。
  const current = checkedState(state);
  const opened = openWorkbenchResource(current, input, rawTitle);
  return { ...opened, rightOpen: current.rightOpen, activeKey: current.activeKey };
}

export function openWorkbenchResource(state: WorkbenchState, input: WorkbenchResource, rawTitle: string): WorkbenchState {
  const current = checkedState(state);
  const resource = resourceFrom(input);
  const title = titleOf(rawTitle);
  if (resource === undefined || title === undefined) {
    throw Object.assign(new Error('workbench_resource_invalid'), { code: 'workbench_resource_invalid' });
  }
  const key = resourceKey(resource);
  const index = current.tabs.findIndex(tab => tab.key === key);
  const tabs = [...current.tabs];
  if (index >= 0) tabs[index] = { ...tabs[index]!, title, resource };
  else {
    if (tabs.length >= MAX_WORKBENCH_TABS) {
      throw Object.assign(new Error('workbench_tab_limit'), { code: 'workbench_tab_limit' });
    }
    tabs.push({ key, title, resource, pinned: false });
  }
  return { ...current, rightOpen: true, tabs, activeKey: key };
}

export function selectWorkbenchTab(state: WorkbenchState, key: string): WorkbenchState {
  const current = checkedState(state);
  return current.tabs.some(tab => tab.key === key) ? { ...current, rightOpen: true, activeKey: key } : current;
}

export function closeWorkbenchTab(state: WorkbenchState, key: string): WorkbenchState {
  const current = checkedState(state);
  if (!current.tabs.some(tab => tab.key === key)) return current;
  const tabs = current.tabs.filter(tab => tab.key !== key);
  const activeKey = current.activeKey === key ? tabs.at(-1)?.key ?? null : current.activeKey;
  return { ...current, tabs, activeKey, rightOpen: tabs.length > 0 && current.rightOpen };
}
