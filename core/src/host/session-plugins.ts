import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { DEFAULT_INSTRUCTION_BYTES, loadInstructions } from '../capability/instructions.js';
import { managedProcessPlugin, type ManagedProcessRegistry } from '../capability/managed-process.js';
import type { MediaStore } from '../capability/media.js';
import { loadAssembly, type Plugin } from '../kernel/assembly.js';
import { KernelError } from '../kernel/error.js';
import { currentKernelExecutionContext, withKernelExecutionContext } from '../kernel/execution-context.js';
import { loadExtensions } from '../kernel/extensions.js';
import type { Kernel, ToolDefinition } from '../kernel/kernel.js';
import type { LoggerBackend } from '../kernel/log.js';
import type { PermissionContext } from '../kernel/permission.js';
import type { PromptAssembly } from '../kernel/prompt.js';
import { formatSkillCatalog, SKILL_METADATA_BUDGET_BYTES, type SkillRegistry } from '../kernel/skills.js';
import type { SessionEvent } from '../session/event-types.js';
import type { SessionLog } from '../session/session.js';
import { isRecord } from '../shared/guards.js';
import { createAskUserPlugin } from '../tools/ask-user.js';
import { createCompactPlugin } from '../tools/compact.js';
import { createPresentPlugin } from '../tools/present.js';
import { createReadDocumentPlugin } from '../tools/read-document.js';
import { createReadImagePlugin } from '../tools/read-image.js';
import { createScreenshotPlugin } from '../tools/screenshot.js';
import { createTodoWritePlugin } from '../tools/todo-write.js';
import type { HostConfigSnapshot, HostSessionBase, ProjectEnvironment } from './types.js';

export interface ExtensionPromptFragment {
  readonly name: string;
  readonly text: string;
  readonly source: string;
}

interface SessionPluginContext {
  readonly kernel: Kernel;
  readonly base: readonly Plugin<Kernel>[];
  readonly mcp: Plugin<Kernel>;
  readonly customTool?: Plugin<Kernel>;
  readonly subagents: Plugin<Kernel>;
  readonly session: SessionLog;
  readonly id: string;
  readonly directory: string;
  readonly projectRoot: string;
  readonly media: MediaStore;
  readonly managedProcesses: ManagedProcessRegistry;
  readonly ask?: Parameters<typeof createAskUserPlugin>[0]['ask'];
  readonly requestView?: NonNullable<Parameters<typeof createPresentPlugin>[0]>['requestView'];
  supportsImages(): boolean;
  authorizeScreenCapture(): Promise<AbortSignal>;
  compaction(): NonNullable<HostSessionBase['compaction']> | null;
}

export function assembleSessionPlugins({
  kernel, base, mcp, customTool, subagents, session, id, directory, projectRoot,
  media, managedProcesses, ask, requestView, supportsImages, authorizeScreenCapture, compaction,
}: SessionPluginContext) {
  return loadAssembly(kernel, [
    ...base, mcp, createTodoWritePlugin({ session }),
    createReadImagePlugin({ media, supportsImages }), createReadDocumentPlugin({ media, supportsImages }),
    createPresentPlugin({ sessionId: id, workspaceRoot: projectRoot, session, ...(requestView === undefined ? {} : { requestView }) }),
    createScreenshotPlugin({ media, supportsImages, authorize: authorizeScreenCapture }),
    managedProcessPlugin(managedProcesses),
    ...(ask === undefined ? [] : [createAskUserPlugin({ ask })]),
    createCompactPlugin({ compaction, session, directory, id }),
    ...(customTool === undefined ? [] : [customTool]),
    subagents,
  ]);
}

export async function installSessionPrompt(
  prompt: PromptAssembly, projectRoot: string, config: HostConfigSnapshot['instructions'], skills: SkillRegistry,
): Promise<void> {
  const instructions = await loadInstructions({ ...config, boundary: projectRoot, current: resolve(projectRoot, config?.current ?? '.') });
  prompt.fragment({ name: 'instructions', anchor: 0, text: instructions.text, maxBytes: config?.maxBytes ?? DEFAULT_INSTRUCTION_BYTES });
  if (skills.skills.length > 0) {
    prompt.fragment({ name: 'skills', anchor: 1, text: formatSkillCatalog(skills), maxBytes: SKILL_METADATA_BUDGET_BYTES });
  }
}

function isToolDefinition(value: unknown): value is ToolDefinition {
  return isRecord(value) && typeof value.name === 'string' && typeof value.description === 'string'
    && isRecord(value.parameters) && typeof value.run === 'function';
}

function checkedToolDefinition(value: unknown): ToolDefinition {
  if (!isRecord(value) || typeof value.name !== 'string' || value.name === '') throw new KernelError('tool_name_required');
  if (typeof value.description !== 'string' || value.description === '') throw new KernelError('tool_description_required');
  if (typeof value.run !== 'function') throw new KernelError('tool_run_required');
  if (!isRecord(value.parameters)) throw new KernelError('tool_parameters_must_be_object');
  if (value.parameters.type !== 'object') throw new KernelError('tool_parameters_type_not_object');
  if (!isToolDefinition(value)) throw new KernelError('tool_name_required');
  return value;
}

export async function installSessionExtensions(
  kernel: Kernel,
  extensions: ProjectEnvironment['extensions'],
  permission: PermissionContext,
  fragments: ExtensionPromptFragment[],
  listeners: ((event: SessionEvent) => void)[],
  logger?: Pick<LoggerBackend, 'log'>,
) {
  const enabled = permission.profile === 'full-access' && permission.network === 'unrestricted';
  const diagnostics = enabled ? extensions.ignored : [
    ...extensions.ignored,
    ...extensions.paths.map(path => ({
      code: 'extension_requires_full_access', path,
      detail: 'extensions run inside the Host process and require full-access with unrestricted network permission',
    })),
  ];
  for (const diagnostic of diagnostics) {
    logger?.log?.('extension source is not loaded', { code: diagnostic.code, path: diagnostic.path, reason: diagnostic.detail });
  }
  return await loadExtensions(enabled ? extensions.paths : [], {
    registerTool: tool => kernel.register(checkedToolDefinition(tool)),
    registerFragment(fragment) {
      if (fragments.some(entry => entry.name === fragment.name)) throw new KernelError('extension_fragment_duplicate', { detail: fragment.name });
      fragments.push(fragment);
      return () => {
        const index = fragments.indexOf(fragment);
        if (index >= 0) fragments.splice(index, 1);
      };
    },
    addEventListener(handler) {
      listeners.push(handler);
      return () => {
        const index = listeners.indexOf(handler);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
    async request(tool, args) {
      const parent = currentKernelExecutionContext();
      if (parent === undefined || !parent.scope.active) throw new KernelError('extension_request_context_unavailable');
      if (parent.signal.aborted) {
        const reason = parent.signal.reason;
        throw reason instanceof KernelError ? reason : new KernelError('loop_cancelled', { cause: reason });
      }
      if (parent.extensionHookPhase === 'beforeTool' || parent.extensionHookPhase === 'afterTool') {
        throw new KernelError('extension_hook_request_unavailable');
      }
      if (parent.extensionHookPhase === 'prepareRequest' || parent.extensionHookPhase === 'completeRun') {
        if (parent.extensionRequest === undefined) throw new KernelError('extension_request_context_unavailable');
        return await parent.extensionRequest(tool, args);
      }
      const callId = randomUUID();
      const child = { ...parent, callId, parentCallId: parent.callId, scope: { active: true } };
      try {
        return await withKernelExecutionContext(child, () => kernel.call(tool, args, {
          signal: parent.signal, callId, parentCallId: parent.callId,
          ...(parent.sessionId === undefined ? {} : { sessionId: parent.sessionId }),
          ...(parent.runId === undefined ? {} : { runId: parent.runId }),
          ...(parent.executionId === undefined ? {} : { executionId: parent.executionId }),
          ...(parent.userSeq === undefined ? {} : { userSeq: parent.userSeq }),
          ...(parent.parentRunId === undefined ? {} : { parentRunId: parent.parentRunId }),
          ...(parent.parentExecutionId === undefined ? {} : { parentExecutionId: parent.parentExecutionId }),
        }));
      } finally {
        child.scope.active = false;
      }
    },
  });
}
