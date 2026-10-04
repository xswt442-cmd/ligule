// 判定链（D15、D17、D59）：顺序固定为「按工具名的策略表 → 内容级检查 → 档位放行 → 询问用户」。
// 整条链单调：任何一步的拒绝都不会被后一步改成放行，守卫没有「放行」这一种返回值；
// 被前两步拦下的调用不去询问用户。
// 命令文本先按 Host 选定的那一种解释器的语法解析成可信的分段，规则表逐段套：任何一段命中拒绝就整条拒绝，
// 任何一段盖不住就去询问。解析不出分段（有子集之外的构造、解析报错、解析器不可用）按无法完整处理对待。
// 自动档不放过以脚本解释器开头的分段（D17 第三条）：那一段实际会执行任意代码，
// 规则表写没写过它都一样，所以按分段本身判而不是按规则形态判；解释器外壳不剥。
import { parseCommand } from '../capability/command.js';
import { KernelError } from './error.js';
import { matches } from './match.js';

// 阈值与档位由配置层给出；这里的默认值是本项目自定的起点，理由记在决定条目 D17。
export const DEFAULT_THRESHOLDS = Object.freeze({ consecutive: 3, total: 20 });

// 判定结果里进记录的那几格（D77）：内核按这一张表抄出去，链子以后多出来的字段不会悄悄进记录。
export const VERDICT_FIELDS = Object.freeze(['capability', 'decision', 'via', 'level', 'forced', 'rule', 'answer']);

// 自动档里不能直接放行的脚本解释器：一次调用能跑任意代码，内容级检查管不到参数。
const INTERPRETERS = [
  'bash', 'sh', 'zsh', 'dash', 'fish', 'pwsh', 'powershell', 'cmd',
  'python', 'python3', 'node', 'deno', 'bun', 'perl', 'ruby', 'php',
];

function commandOf(input) {
  if (typeof input !== 'object' || input === null || typeof input.command !== 'string') return undefined;
  // 全空白的命令没有内容可判，交给工具自己那条校验去报稳定码，不在这一层当成看不透的命令。
  return input.command.trim() === '' ? undefined : input.command;
}

// 命令文本能不能走自动放行：第一个词是脚本解释器时不能；没有命令文本的调用（读文件一类）不受这条影响。
function canAutoApprove(command) {
  if (command === undefined) return true;
  const first = command.trim().split(/[\s;|&]+/)[0];
  return !INTERPRETERS.includes(first);
}

// 要去询问时把原因一起交出去：解析器不可用、命令里有哪种看不透的构造、以及按哪一种语法读的，
// 界面上要说得出来（I8）。
function askReason(parsed, target, shell) {
  const kind = shell?.kind ?? 'bash';
  if (parsed?.kind === 'unavailable') return `the ${kind} command syntax parser is unavailable: ${parsed.detail}`;
  if (parsed?.kind === 'unsupported') return `the ${kind} command is not fully understood: ${parsed.construct}`;
  if (target?.class === 'loopback' || target?.class === 'private') {
    return `the address ${target.addresses.join(', ')} is ${target.class}, so this fetch needs an explicit yes`;
  }
  return undefined;
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

    async evaluate({ tool, input, target, shell, capability }) {
      if (typeof tool !== 'string' || tool === '') throw new KernelError('policy_call_tool_required');
      // 判定看的能力名由工具自己声明（D52）：`mcp.call` 的一次调用真正用的是 `mcp:<服务器>/<工具>`，
      // 规则表、守卫与问出去的那一句都按这个名字走，登记表里的名字只用于找到这件工具。
      const named = capability ?? tool;
      const command = commandOf(input);
      const effective = forcedToAsk ? 'ask' : current;
      // 判定这一格要说清当时生效的是哪一份档位：配置写的是 `current`，被拒绝阈值压下来是另一回事（D77）。
      const judged = (decision, via, extra) => ({
        decision,
        via,
        capability: named,
        level: current,
        ...(forcedToAsk ? { forced: true } : {}),
        ...extra,
      });
      const candidates = rules.filter((item) => item.tool === named);
      // 命令文本先过一次语法解析：能拆成可信的分段就逐段套规则，拆不出来就整条按无法完整处理对待。
      // 读哪一种语法由 Host 的那一份选择决定（D59），判定与执行看的不是同一份东西就没有意义。
      const parsed = command === undefined ? undefined : await parseCommand(command, shell?.kind);
      const segments = parsed?.kind === 'segments' ? parsed.segments : undefined;
      // 没有命令文本的调用（读文件一类）整次调用就是一段：规则表照旧套，只是套在一个空的分段上。
      const parts = command === undefined ? [undefined] : segments;
      // 答复里带上解析出的分段：会话记录要读得出这条文本按那一种语法被读成了什么（D59）。
      // 没有命令文本的调用与解析不出分段的调用都不带这个字段，答复形状与加这一条之前一样。
      const answer = (via, rule) => judged('allow', via, {
        ...(segments === undefined ? {} : { segments }),
        ...(rule?.match === undefined ? {} : { rule: rule.match }),
      });

      const refuse = (code, via, reason, rule, reply) => {
        record(true);
        return judged('deny', via, {
          code,
          reason,
          ...(rule === undefined ? {} : { rule }),
          ...(reply === undefined ? {} : { answer: reply }),
        });
      };

      // 网络目标的类别先收紧（D58）：用不了的 URL 与「根本不该被取回的地址」这一类不进后面的顺序。
      if (target !== undefined && (target.failure !== undefined || target.class === undefined)) {
        return refuse('policy_denied', 'target', `the network target cannot be classified (${target.failure ?? 'unsupported'})`);
      }
      if (target?.class === 'link-local' || target?.class === 'unspecified') {
        return refuse('policy_denied', 'target', `${target.class} addresses (link-local, metadata endpoints, multicast and reserved ranges) are not fetched from this run`);
      }
      const loopOrPrivate = target?.class === 'loopback' || target?.class === 'private';

      // 命中的规则里只要有拒绝就拒绝：链只能收紧，写在拒绝规则前面的放行规则不能把它压掉（I4）。
      // 拒绝对整条文本与每一个分段都生效，`git status | rm x` 才拦得住。
      const denied = candidates.find((item) => item.decision === 'deny'
        && (matches(command, item.match) || (segments ?? []).some((segment) => matches(segment, item.match))));
      if (denied) {
        return refuse('policy_denied', 'rule', denied.reason ?? `${named} is denied by policy`, denied.match);
      }

      for (const check of guards) {
        const reason = check({ tool: named, input, command });
        if (typeof reason === 'string') return refuse('guard_denied', 'guard', reason);
      }

      const allowed = candidates.filter((item) => item.decision === 'allow');
      // 盖住这一次的那一条放行规则要留名字：D77 那一格说的是命中了哪一条，而不是只说通过了。
      const covering = () => (parts === undefined ? undefined : allowed.find((item) => parts.every((segment) => matches(segment, item.match))));
      let covered;
      if (loopOrPrivate) {
        // 环回与内网至少问到一次：放行规则写得再宽也算没盖住，因为「哪一个地址」不是字符串看得出来的。
        covered = undefined;
      } else if (command === undefined) {
        // 没有命令文本的调用（读文件一类）不受语法这一层影响：自动档直接放行，
        // 逐次询问这一档仍然要有放行规则盖住它。
        covered = effective === 'auto' ? null : covering();
      } else if (effective === 'auto') {
        // 自动档按语法放行：整棵树可信，而且每一段的第一个词都不是脚本解释器（D17 第三条）。
        // 解释器外壳不因为能解析里面那个字符串就剥掉，`bash -lc "git status"` 仍然要问。
        covered = segments !== undefined && segments.every((segment) => canAutoApprove(segment)) ? null : undefined;
      } else {
        // 逐次询问这一档：放行规则要盖住每一个分段，解析不出分段就等于盖不住。
        covered = segments !== undefined && parts.every((segment) => allowed.some((item) => matches(segment, item.match)))
          ? covering()
          : undefined;
      }
      if (covered !== undefined) {
        record(false);
        return covered === null ? answer('auto') : answer('rules', covered);
      }

      // 走到这里都要问：自动档遇到看不透的命令不自动放行，只降档到逐次询问，并把原因交出去（D17、I8）。
      const reason = askReason(parsed, target, shell);
      if (typeof ask !== 'function') return refuse('ask_unavailable', 'ask', reason ?? 'no ask channel is installed', undefined, 'unavailable');
      // 答复这一次要点头就得多看一眼：同一条文本在两种语法下能自动放行的面积不一样，答的是哪一种、跑的是哪一个可执行文件，
      // 只有 Host 这一侧知道（D59）。没有命令文本的调用不带这两个字段，答复的形状与加这一条之前一样。
      const question = { tool: named, input, command, reason };
      if (shell !== undefined) {
        question.shell = shell.kind;
        question.executable = shell.executable;
      }
      if (await ask(question) !== true) return refuse('ask_declined', 'ask', 'the user declined', undefined, 'deny');
      record(false);
      return judged('allow', 'ask', { ...(segments === undefined ? {} : { segments }), answer: 'allow' });
    },
  };
}
