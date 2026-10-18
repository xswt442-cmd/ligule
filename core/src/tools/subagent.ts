// `subagent` 将任务交给独立的派生执行。
//
// 派生执行在同一进程中运行独立循环，使用新的 Kernel 和会话记录，并继承父会话的提供方与配置。
// 它沿用父会话的权限判定、不能递归启动其他子 Agent，且拥有独立记录以便恢复。
//
// 该工具通过插件注册，不属于 Kernel 内置能力。当前每个父会话一次只运行一个派生任务。
import { createKernel } from '../kernel/kernel.js';
import { createLoop, DEFAULT_LOOP_LIMITS } from '../kernel/loop.js';
import { createPromptAssembly } from '../kernel/prompt.js';
import { createSessionLog } from '../session/session.js';
import { applyMode, loadMode } from '../kernel/modes.js';
import { createConfig } from '../kernel/config.js';
import { createDecisionChain } from '../kernel/policy.js';
import { createLogger } from '../kernel/log.js';
import { loadAssembly } from '../kernel/assembly.js';
import { KernelError } from '../kernel/error.js';
import type { PermissionContext } from '../kernel/permission.js';

type LoopOptions = Parameters<typeof createLoop>[0];

export interface SubagentDeps {
  config: ReturnType<typeof createConfig>;
  provider: LoopOptions['provider'];
  chain: ReturnType<typeof createDecisionChain>;
  prompt: { staticPrefix: string };
  directory: string;
  sessionId: string;
  logger?: Parameters<typeof createLogger>[0];
  plugins: Parameters<typeof loadAssembly>[1];
  modePaths?: NonNullable<Parameters<typeof loadMode>[1]>;
  modeFile?: () => Parameters<typeof applyMode>[1] | undefined;
  loopLimits?: LoopOptions['limits'];
}

export function createSubagentPlugin(deps: SubagentDeps) {
  let counter = 0;

  return {
    name: 'ligule-subagent',
    setup(kernel: { register(tool: unknown): () => void }) {
      return kernel.register({
        name: 'subagent',
        access: 'inherit',
        description: 'Delegate one piece of work to a derived agent that runs with this run\'s decision level and its own session record.',
        parameters: {
          type: 'object',
          properties: {
            task: { type: 'string', description: 'What the derived agent should do, as one instruction.' },
            mode: { type: 'string', description: 'Optional named mode for the derived agent; the current one by default.' },
          },
          required: ['task'],
        },
        async run(args: { task?: string; mode?: string }, { signal, permission }: { signal?: AbortSignal; permission: PermissionContext }) {
          if (typeof args.task !== 'string' || args.task.trim() === '') {
            throw new KernelError('subagent_task_required', { detail: 'the derived agent needs a task to work on' });
          }
          if (args.mode !== undefined && deps.modePaths === undefined) {
            throw new KernelError('subagent_mode_paths_required', { detail: 'this run has no mode directories to look a name up in' });
          }
          counter += 1;
          const id = `${deps.sessionId}.sub-${counter}`;
            // 首行在首次写入时生成；模式选择确定后再补入模式身份。
          let modeIdentity: { name: string; layer: string } | undefined;
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
          const child = createKernel({
            config: deps.config,
            // 派生执行复用父会话的权限判定实例，包括拒绝计数和强制审批状态。
            policy: deps.chain,
            session,
            logger: deps.logger,
            permission,
          });
          // 派生执行继承父会话的插件工具，但不注册 `subagent`，从而禁止递归派生。
          const assembly = loadAssembly(child, deps.plugins);
          const prompt = createPromptAssembly({ static: deps.prompt.staticPrefix });
          try {
            const file = args.mode === undefined
              ? deps.modeFile?.()
              : await loadMode(args.mode, deps.modePaths as NonNullable<Parameters<typeof loadMode>[1]>);
            if (file !== undefined) {
              modeIdentity = { name: file.name, layer: file.layer };
              applyMode(child, file);
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
              mode: file === undefined ? null : file.name,
            };
          } finally {
            assembly.dispose();
            await session.close();
          }
        },
      });
    },
  };
}
