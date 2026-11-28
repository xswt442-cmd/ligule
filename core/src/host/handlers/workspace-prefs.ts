import { resolve } from 'node:path';
import { parsePrefsJson, prefsPathOf, readPrefs, savePrefs } from '../../kernel/desktop-prefs.js';
import { KernelError } from '../../kernel/error.js';
import { historyPathOf, loadHistory, rememberHistory } from '../../kernel/input-history.js';
import { readRegistry, setDefaultWorkspace, unregisterWorkspace, workspaceIdentity } from '../../kernel/workspace.js';
import type { HostMethodParams } from '../protocol.js';

interface WorkspacePrefsContext {
  classifyProjectRoot(directory: string): Promise<void>;
  isWorkspaceRunning(identity: string): boolean;
}

export function createWorkspacePrefsHandlers({ classifyProjectRoot, isWorkspaceRunning }: WorkspacePrefsContext) {
  return {
    'workspaces.list': () => readRegistry(),
    async 'workspace.default.set'(params: HostMethodParams) {
      const directory = String(params.directory).trim();
      if (directory === '') return await setDefaultWorkspace(null);
      await classifyProjectRoot(resolve(directory));
      return await setDefaultWorkspace(directory, { name: params.name });
    },
    async 'workspace.remove'({ directory }: HostMethodParams) {
      if (typeof directory !== 'string' || directory.trim() === '') throw new KernelError('workspace_directory_required');
      if (isWorkspaceRunning(workspaceIdentity(directory))) throw new KernelError('workspace_in_use', { detail: directory });
      return await unregisterWorkspace(directory);
    },
    async 'history.read'() {
      return { entries: await loadHistory() };
    },
    async 'history.append'({ text }: HostMethodParams) {
      return { entries: await rememberHistory(historyPathOf(), [String(text)]) };
    },
    'prefs.read': () => readPrefs(),
    async 'prefs.write'({ json, version }: HostMethodParams) {
      const value = parsePrefsJson(String(json));
      if (typeof version !== 'string') throw new KernelError('protocol_args_invalid', { detail: 'version must be a string' });
      return await savePrefs(prefsPathOf(), value, { version });
    },
  } satisfies Record<string, (params: HostMethodParams) => Promise<unknown>>;
}
