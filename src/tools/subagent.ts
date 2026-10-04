// `subagent`：把一块活交给一个派生执行体（D71，实现顺序第 31 步）。
//
// 派生体是同进程里的另一个循环：一份新内核、一份新的会话记录、同一份提供方与配置。三条不能让步的地方写在
// D71 里：判定档位继承父会话那一条链（派生体不能比父会话更松）、只允许一层（派生体的登记表里没有 `subagent`
// 自己）、记录各一份（那一段要能单独重建，I5）。
//
// 这一件工具是内核之外的一方插件：内核自己不提供任何能力（I1）。它也不并发：第一版一次只跑一个派生体（D29 的
// 并发字段没动）。
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
        description: 'Delegate one piece of work to a derived agent that runs with this run\'s decision level and its own session record.',
        parameters: {
          type: 'object',
          properties: {
            task: { type: 'string', description: 'What the derived agent should do, as one instruction.' },
            mode: { type: 'string', description: 'Optional named mode for the derived agent; the current one by default.' },
          },
          required: ['task'],
        },
        async run(args: { task?: string; mode?: string }, { signal }: { signal?: AbortSignal }) {
          if (typeof args.task !== 'string' || args.task.trim() === '') {
            throw new KernelError('subagent_task_required', { detail: 'the derived agent needs a task to work on' });
          }
          if (args.mode !== undefined && deps.modePaths === undefined) {
            throw new KernelError('subagent_mode_paths_required', { detail: 'this run has no mode directories to look a name up in' });
          }
          counter += 1;
          const id = `${deps.sessionId}.sub-${counter}`;
          const session = createSessionLog({ directory: deps.directory, id });
          const child = createKernel({
            config: deps.config,
            // 判定链是父会话那一条实例：拒绝计数与降到逐次询问这件事跟着共用，换一份链就等于给派生体另起一档（D71）。
            policy: deps.chain,
            session,
            logger: deps.logger,
          });
          // 派生体的工具来自父会话那一套插件，里面没有 `subagent` 自己：一层是「谁在跑」读得出来的下界。
          const assembly = loadAssembly(child, deps.plugins);
          const prompt = createPromptAssembly({ static: deps.prompt.staticPrefix });
          try {
            const file = args.mode === undefined
              ? deps.modeFile?.()
              : await loadMode(args.mode, deps.modePaths as NonNullable<Parameters<typeof loadMode>[1]>);
            if (file !== undefined) applyMode(child, file);
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
          }
        },
      });
    },
  };
}
