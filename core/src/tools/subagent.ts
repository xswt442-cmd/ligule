// `subagent` 将任务交给独立的派生执行；一个父轮次最多并行运行三个子任务。
//
// 派生执行在同一进程中运行独立循环，使用新的 Kernel 和会话记录，并继承父会话的提供方与配置。
// 它沿用父会话的权限判定、不能递归启动其他子 Agent，且拥有独立记录以便恢复。
//
// 该工具通过插件注册，不属于 Kernel 内置能力。每个父会话最多同时运行三个派生任务。
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { createKernel } from '../kernel/kernel.js';
import { createLoop, DEFAULT_LOOP_LIMITS } from '../kernel/loop.js';
import { createPromptAssembly } from '../kernel/prompt.js';
import { createSessionLog } from '../session/session.js';
import { completedRunResult } from '../delegation.js';
import {
  applyModeToPrompt, resolveModeSelection,
  type ModeDirectories, type ModeFile, type ModePromptFragment, type RequestedModeSelection,
} from '../kernel/modes.js';
import { createConfig } from '../kernel/config.js';
import { createDecisionChain } from '../kernel/policy.js';
import { createLogger } from '../kernel/log.js';
import { loadAssembly } from '../kernel/assembly.js';
import { KernelError } from '../kernel/error.js';
import type { PermissionContext } from '../kernel/permission.js';

type LoopOptions = Parameters<typeof createLoop>[0];
const MAX_CONCURRENT_SUBAGENTS = 3;

export interface SubagentDeps {
  config: ReturnType<typeof createConfig>;
  provider: LoopOptions['provider'];
  chain: ReturnType<typeof createDecisionChain>;
  prompt: { staticPrefix: string };
  directory: string;
  sessionId: string;
  logger?: Parameters<typeof createLogger>[0];
  plugins: Parameters<typeof loadAssembly>[1];
  modePaths?: ModeDirectories;
  modeFile?: () => ModeFile | undefined;
  promptFragments?: () => readonly ModePromptFragment[];
  promptFragmentBytes?: number;
  loopLimits?: LoopOptions['limits'];
}

export function createSubagentPlugin(deps: SubagentDeps) {
  let counter = 0;
  let active = 0;

  async function nextSessionId(): Promise<string> {
    let entries;
    try { entries = await readdir(deps.directory, { withFileTypes: true }); }
    catch (cause) { throw new KernelError('subagent_session_directory_read_failed', { cause }); }
    const prefix = `${deps.sessionId}.sub-`;
    let highest = counter;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith('.jsonl')) continue;
      const suffix = entry.name.slice(prefix.length, -'.jsonl'.length);
      if (!/^\d+$/u.test(suffix)) continue;
      const number = Number(suffix);
      if (Number.isSafeInteger(number)) highest = Math.max(highest, number);
    }
    counter = highest + 1;
    return `${deps.sessionId}.sub-${counter}`;
  }

  return {
    name: 'ligule-subagent',
    setup(kernel: { register(tool: unknown): () => void }) {
      return kernel.register({
        name: 'subagent',
        access: 'inherit',
        execution: 'parallel',
        description: 'Delegate independent work to child runs with the parent policy and separate session records. Up to three children can run at once; children cannot create more children.',
        parameters: {
          type: 'object',
          properties: {
            task: { type: 'string', description: 'What the derived agent should do, as one instruction.' },
            mode: {
              anyOf: [
                { type: 'string', minLength: 1, maxLength: 64 },
                { type: 'object', properties: {
                  type: { type: 'string', enum: ['named'] }, name: { type: 'string', minLength: 1, maxLength: 64 },
                }, required: ['type', 'name'], additionalProperties: false },
                { type: 'object', properties: {
                  type: { type: 'string', enum: ['inline'] },
                  tools: { anyOf: [
                    { type: 'string', enum: ['*'] },
                    { type: 'array', items: { type: 'string', minLength: 1, maxLength: 128 } },
                  ] },
                  prompt: { anyOf: [
                    { type: 'string', enum: ['*'] },
                    { type: 'array', items: { type: 'string', minLength: 1, maxLength: 128 } },
                  ] },
                }, required: ['type', 'tools', 'prompt'], additionalProperties: false },
              ],
              description: 'Optional named or inline mode for the derived agent; the current mode is inherited by default.',
            },
          },
          required: ['task'],
        },
        async run(args: { task?: string; mode?: RequestedModeSelection }, { signal, permission }: { signal?: AbortSignal; permission: PermissionContext }) {
          if (typeof args.task !== 'string' || args.task.trim() === '') {
            throw new KernelError('subagent_task_required', { detail: 'the derived agent needs a task to work on' });
          }
          const namedMode = typeof args.mode === 'string' || (typeof args.mode === 'object' && args.mode?.type === 'named');
          if (namedMode && deps.modePaths === undefined) {
            throw new KernelError('subagent_mode_paths_required', { detail: 'this run has no mode directories to look a name up in' });
          }
          if (active >= MAX_CONCURRENT_SUBAGENTS) {
            throw new KernelError('subagent_concurrency_limit', { detail: `at most ${MAX_CONCURRENT_SUBAGENTS} derived runs can be active for this parent` });
          }
          active += 1;
          try {
            const id = await nextSessionId();
            // 首行在首次写入时生成；模式选择确定后再补入模式身份。
            let modeIdentity: {
              name: string;
              layer: string;
              source?: 'named' | 'inline';
              digest?: string;
              fileDigest?: string;
              tools?: string[];
              prompt?: string[];
            } | undefined;
            const session = createSessionLog({
              directory: deps.directory,
              id,
              meta: () => ({
                projectRoot: typeof deps.config.workspaceRoot === 'string'
                  ? deps.config.workspaceRoot
                  : typeof deps.config.boundary === 'string' ? deps.config.boundary : undefined,
                mode: modeIdentity,
              }),
            });
            let disposeAssembly: (() => void) | undefined;
            let undoMode = () => {};
            try {
              const child = createKernel({
                config: deps.config,
                // 派生执行复用父会话的权限判定实例，包括拒绝次数与强制审批状态。
                policy: deps.chain,
                session,
                logger: deps.logger,
                permission,
              });
              // 派生执行继承父会话的插件工具，但不注册 `subagent`，从而禁止递归派生。
              const assembly = loadAssembly(child, deps.plugins);
              disposeAssembly = () => assembly.dispose();
              const prompt = createPromptAssembly({ static: deps.prompt.staticPrefix });
              const resolvedMode = await resolveModeSelection(args.mode, deps.modePaths, deps.modeFile?.());
              if (resolvedMode !== undefined) {
                const applied = applyModeToPrompt({
                  file: resolvedMode.application,
                  kernel: child,
                  prompt,
                  fragments: deps.promptFragments?.() ?? [],
                  maxBytes: deps.promptFragmentBytes ?? 8192,
                });
                undoMode = applied.undo;
                modeIdentity = {
                  name: resolvedMode.name,
                  layer: resolvedMode.layer,
                  source: resolvedMode.source,
                  digest: applied.digest,
                  ...(resolvedMode.fileDigest === undefined ? {} : { fileDigest: resolvedMode.fileDigest }),
                  tools: applied.tools,
                  prompt: applied.prompt,
                };
              }
              const loop = createLoop({
                kernel: child,
                provider: deps.provider,
                prompt,
                session,
                limits: deps.loopLimits ?? DEFAULT_LOOP_LIMITS,
              });
              const result = await loop.run(args.task, { signal });
              return {
                text: result.text,
                sessionId: id,
                path: session.path,
                iterations: result.iterations,
                modelCalls: result.modelCalls,
                mode: resolvedMode?.name ?? null,
                modeDigest: modeIdentity?.digest ?? null,
                result: completedRunResult(randomUUID(), id, result),
              };
            } finally {
              try { undoMode(); }
              finally {
                try { disposeAssembly?.(); }
                finally { await session.close(); }
              }
            }
          } finally {
            active -= 1;
          }
        },
      });
    },
  };
}
