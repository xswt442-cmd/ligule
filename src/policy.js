// 判定链（D15、D17）：顺序固定为「按工具名的策略表 → 内容级检查 → 档位放行 → 询问用户」。
// 整条链单调：任何一步的拒绝都不会被后一步改成放行，守卫没有「放行」这一种返回值；
// 被前两步拦下的调用不去询问用户。
// 命令文本的匹配第一版只按前缀与通配（D15）。自动档不放过以脚本解释器开头的命令（D17 第三条）：
// 那条命令实际会执行任意代码，规则表写没写过它都一样，所以按命令本身判而不是按规则形态判。
import { KernelError } from './error.js';
import { matches } from './match.js';

// 阈值与档位由配置层给出；这里的默认值是本项目自定的起点，出处记在 ligule-set/decisions.md D17。
export const DEFAULT_THRESHOLDS = Object.freeze({ consecutive: 3, total: 20 });

// 自动档里不能直接放行的脚本解释器：一次调用能跑任意代码，内容级检查管不到参数。
const INTERPRETERS = [
  'bash', 'sh', 'zsh', 'dash', 'fish', 'pwsh', 'powershell', 'cmd',
  'python', 'python3', 'node', 'deno', 'bun', 'perl', 'ruby', 'php',
];

function commandOf(input) {
  return typeof input === 'object' && input !== null && typeof input.command === 'string' ? input.command : undefined;
}

// 命令文本能不能走自动放行：第一个词是脚本解释器时不能；没有命令文本的调用（读文件一类）不受这条影响。
function canAutoApprove(command) {
  if (command === undefined) return true;
  const first = command.trim().split(/[\s;|&]+/)[0];
  return !INTERPRETERS.includes(first);
}

// ask 是宿主交进来的询问通道，与适配器无关（内核对外接口）。没有这条通道时，需要询问的调用按拒绝处理。
export function createDecisionChain({ mode = 'ask', rules = [], thresholds = DEFAULT_THRESHOLDS, ask } = {}) {
  if (mode !== 'ask' && mode !== 'auto') throw new KernelError('policy_mode_unknown');
  if (!(thresholds.consecutive >= 1) || !(thresholds.total >= 1)) throw new KernelError('policy_thresholds_required');

  let current = mode;
  let forcedToAsk = false;
  let consecutive = 0;
  let total = 0;
  const guards = new Set();

  function record(denied) {
    if (denied) {
      consecutive += 1;
      total += 1;
      // 达到阈值就回落到逐次询问，这是整条链上唯一一处档位变化，而且只往更严的方向走。
      if (consecutive >= thresholds.consecutive || total >= thresholds.total) forcedToAsk = true;
    } else {
      consecutive = 0;
    }
  }

  function deny(code, reason) {
    record(true);
    return { decision: 'deny', code, reason };
  }

  return {
    // 守卫返回一段拒绝理由或者什么都不返回（I4）：没有 allow 这个返回值，后一个守卫撤销不了前一个的拒绝。
    guard(check) {
      if (typeof check !== 'function') throw new KernelError('guard_check_required');
      guards.add(check);
      return () => guards.delete(check);
    },

    get mode() {
      return forcedToAsk ? 'ask' : current;
    },

    denials() {
      return { consecutive, total };
    },

    async evaluate({ tool, input }) {
      if (typeof tool !== 'string' || tool === '') throw new KernelError('policy_call_tool_required');
      const command = commandOf(input);
      const effective = forcedToAsk ? 'ask' : current;
      // 命中的规则里只要有拒绝就拒绝：链只能收紧，写在拒绝规则前面的放行规则不能把它压掉（I4）。
      const matching = rules.filter((item) => item.tool === tool && matches(command, item.match));
      const denied = matching.find((item) => item.decision === 'deny');
      if (denied) {
        return deny('policy_denied', denied.reason ?? `${tool} is denied by policy`);
      }
      const allowed = matching.find((item) => item.decision === 'allow');

      for (const check of guards) {
        const reason = check({ tool, input, command });
        if (typeof reason === 'string') return deny('guard_denied', reason);
      }

      if (effective === 'auto' && canAutoApprove(command)) {
        record(false);
        return { decision: 'allow' };
      }
      if (effective === 'ask' && allowed) {
        record(false);
        return { decision: 'allow' };
      }

      if (typeof ask !== 'function') return deny('ask_unavailable', 'no ask channel is installed');
      if (await ask({ tool, input, command }) !== true) return deny('ask_declined', 'the user declined');
      record(false);
      return { decision: 'allow' };
    },
  };
}
