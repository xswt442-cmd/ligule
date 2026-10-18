// 判定顺序是工具规则、内容检查、策略档位，最后才是用户审批。
// 任一步拒绝后都不能被后续步骤放行；前面的步骤拒绝时不会询问用户。
// 命令先按 Host 选择的语法解析，再逐段检查。任一段命中拒绝规则就拒绝整条命令，无法确认安全时转交审批。
// 自动放行不会执行脚本解释器命令，因为它们可以运行任意代码；解析时也不会剥除解释器外壳。
import { inspectCommand, type CommandInspection, type ParsedCommand } from '../capability/command.js';
import { classifyDangerousCommand } from '../capability/dangerous-command.js';
import { KernelError } from './error.js';
import { matches } from './match.js';
import type { NetworkTarget } from '../capability/network.js';
import type { ShellSelection } from '../capability/shell.js';
import type { PolicyRule } from './config-edit.js';
import type { PermissionAccess } from './permission.js';

export type PolicyMode = 'ask' | 'auto' | 'never';
export type PolicyModeSource = 'config' | 'session';

export function isPolicyRule(value: unknown): value is PolicyRule {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return 'tool' in value && typeof value.tool === 'string'
    && 'decision' in value && (value.decision === 'allow' || value.decision === 'deny')
    && (!('match' in value) || value.match === undefined || typeof value.match === 'string')
    && (!('reason' in value) || value.reason === undefined || typeof value.reason === 'string');
}

export interface PolicyThresholds {
  readonly consecutive: number;
  readonly total: number;
}

export interface PolicyQuestion {
  readonly tool: string;
  readonly input: unknown;
  readonly command: string | undefined;
  readonly reason: string | undefined;
  readonly policy: PolicyMode;
  readonly policySource: PolicyModeSource;
  readonly policyForced: boolean;
  readonly shell?: string;
  readonly executable?: string;
}

export type PolicyAsk = (question: PolicyQuestion) => boolean | Promise<boolean>;
export type PolicyGuard = (call: { readonly tool: string; readonly input: unknown; readonly command: string | undefined }) => string | undefined;

export interface DecisionChainOptions {
  readonly mode?: PolicyMode;
  readonly rules?: PolicyRule[];
  readonly thresholds?: PolicyThresholds;
  readonly ask?: PolicyAsk;
}

export interface PolicyVerdict {
  decision: 'allow' | 'deny';
  via: string;
  capability: string;
  level: PolicyMode;
  forced?: true;
  code?: string;
  reason?: string;
  rule?: string;
  answer?: string;
  segments?: string[];
}

export interface DecisionChain {
  readonly mode: PolicyMode;
  readonly modeSource: PolicyModeSource;
  configuredMode(): PolicyMode;
  resetMode(): void;
  setMode(mode: PolicyMode): void;
  setConfiguredMode(mode: PolicyMode): void;
  setRules(rules: PolicyRule[]): void;
  readonly rules: PolicyRule[];
  denials(): { consecutive: number; total: number };
  guard(check: PolicyGuard): () => boolean;
  evaluate(input: PolicyCall): Promise<PolicyVerdict>;
}

export interface PolicyCall {
  readonly tool: string;
  readonly input: unknown;
  readonly target?: NetworkTarget;
  readonly shell?: ShellSelection;
  readonly capability?: string;
  readonly access?: PermissionAccess;
}

// 拒绝阈值和默认策略由配置层提供。
export const DEFAULT_THRESHOLDS: PolicyThresholds = Object.freeze({ consecutive: 3, total: 20 });

// 明确列出写入记录的判定字段，避免后续增加的内部数据意外进入记录。
export const VERDICT_FIELDS = Object.freeze(['capability', 'decision', 'via', 'level', 'forced', 'rule', 'answer'] as const);

// 用户提问使用独立的请求和答复流程，不属于工具审批。
const UNASKED = new Set(['ask_user_question']);

// 自动策略不会直接放行脚本解释器，因为它们可以执行任意代码。
const INTERPRETERS: readonly string[] = [
  'bash', 'sh', 'zsh', 'dash', 'fish', 'pwsh', 'powershell', 'cmd',
  'python', 'python3', 'node', 'deno', 'bun', 'perl', 'ruby', 'php',
];
const COMMAND_WRAPPERS: readonly string[] = [
  'sudo', 'su', 'doas', 'env', 'command', 'exec', 'busybox', 'timeout', 'nohup', 'setsid', 'xargs',
  'start-process', 'invoke-expression', 'iex', 'eval', 'npm', 'npx', 'pnpm', 'yarn', 'make',
  'awk', 'gawk', 'mawk', 'nawk',
];
const SCRIPT_EXTENSIONS = /\.(?:sh|bash|zsh|ps1|psm1|py|pyw|js|mjs|cjs|ts|mts|cts|rb|pl|php)$/u;

function commandOf(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null || !('command' in input) || typeof input.command !== 'string') return undefined;
  // 空白命令由工具参数校验返回稳定错误码；策略层不把它当作无法识别的命令。
  return input.command.trim() === '' ? undefined : input.command;
}

function commandCwd(input: unknown): string | undefined {
  return typeof input === 'object' && input !== null && 'cwd' in input && typeof input.cwd === 'string'
    ? input.cwd
    : undefined;
}

// 自动放行使用与危险命令分类相同的解析结果；动态命令名和解释器包装必须逐次审批。
function canAutoApprove(inspection: CommandInspection | undefined): boolean {
  if (inspection?.parsed.kind !== 'segments' || inspection.invocations.length === 0) return false;
  return inspection.invocations.every((invocation) => {
    if (invocation.executableDynamic === true || (invocation.executableNested?.length ?? 0) > 0) return false;
    const source = invocation.executable;
    if (source.includes('/') || source.includes('\\')) return false;
    const executable = source.replaceAll('\\', '/').split('/').at(-1) ?? '';
    const name = executable.toLowerCase().replace(/\.(?:exe|cmd|bat|com)$/u, '');
    return !INTERPRETERS.includes(name) && !COMMAND_WRAPPERS.includes(name) && !SCRIPT_EXTENSIONS.test(name);
  });
}

// 需要审批时附上解析器状态、无法识别的命令构造和所用语法，让界面可以说明原因。
// 面向用户的解释使用中文，机器可判断的信息由稳定错误码提供。
function askReason(parsed: ParsedCommand | undefined, target: NetworkTarget | undefined, shell: ShellSelection | undefined): string | undefined {
  const kind = shell?.kind ?? 'bash';
  if (parsed?.kind === 'unavailable') return `${kind} 的命令语法解析器用不了：${parsed.detail}`;
  if (parsed?.kind === 'unsupported') return `${kind} 的这一条命令没能完整读下来：${parsed.construct}`;
  if (target?.class === 'loopback' || target?.class === 'private') {
    return `地址 ${target.addresses.join(', ')} 属于 ${target.class}，这一次取回要你明确点头`;
  }
  return undefined;
}

// `ask` 是 Host 注入的用户审批通道。未提供该通道时，所有需要审批的调用都会被拒绝。
export function createDecisionChain({ mode = 'ask', rules = [], thresholds = DEFAULT_THRESHOLDS, ask }: DecisionChainOptions = {}): DecisionChain {
  if (mode !== 'ask' && mode !== 'auto' && mode !== 'never') throw new KernelError('policy_mode_unknown');
  if (!(thresholds.consecutive >= 1) || !(thresholds.total >= 1)) throw new KernelError('policy_thresholds_required');

  let current = mode;
  // 会话可以覆盖配置默认值；保留 `configured`，以便会话撤销覆盖时恢复默认策略。
  let configured = mode;
  let source: PolicyModeSource = 'config';
  let currentRules = rules;
  let forcedToAsk = false;
  let consecutive = 0;
  let total = 0;
  const guards = new Set<PolicyGuard>();

  function record(denied: boolean): void {
    if (denied) {
      consecutive += 1;
      total += 1;
      // 拒绝次数达到阈值后降为逐次审批；策略只会收紧，不会因此放宽。
      if (consecutive >= thresholds.consecutive || total >= thresholds.total) forcedToAsk = true;
    } else {
      consecutive = 0;
    }
  }

  return {
    // 守卫只能返回拒绝理由或不作判断，后续守卫不能撤销之前的拒绝。
    guard(check: PolicyGuard) {
      if (typeof check !== 'function') throw new KernelError('guard_check_required');
      guards.add(check);
      return () => guards.delete(check);
    },

    get mode() {
      return forcedToAsk && current !== 'never' ? 'ask' : current;
    },

    // 标明当前策略来自配置默认值还是会话覆盖；拒绝阈值触发的收紧状态单独记录在 `forced`。
    get modeSource() {
      return source;
    },

    configuredMode() {
      return configured;
    },

    // 撤销运行期的会话覆盖，恢复配置中的默认策略。
    resetMode() {
      current = configured;
      source = 'config';
    },

    setMode(next: PolicyMode) {
      if (next !== 'ask' && next !== 'auto' && next !== 'never') throw new KernelError('policy_mode_unknown');
      current = next;
      source = 'session';
    },

    // 配置默认值变化时，只更新未设置会话覆盖的策略。
    setConfiguredMode(next: PolicyMode) {
      if (next !== 'ask' && next !== 'auto' && next !== 'never') throw new KernelError('policy_mode_unknown');
      configured = next;
      if (source === 'config') current = next;
    },

    // 配置规则写入后立即影响后续判定，不重置守卫、拒绝计数或强制审批状态。
    setRules(next: PolicyRule[]) {
      if (!Array.isArray(next)) throw new KernelError('policy_rules_invalid');
      currentRules = next;
    },

    get rules() {
      return currentRules;
    },

    denials() {
      return { consecutive, total };
    },

    async evaluate({ tool, input, target, shell, capability, access }: PolicyCall): Promise<PolicyVerdict> {
      if (typeof tool !== 'string' || tool === '') throw new KernelError('policy_call_tool_required');
      // 使用工具声明的实际能力名称进行判定。MCP 调用使用 `mcp:<服务器>/<工具>`，而不是通用工具名 `mcp.call`。
      const named = capability ?? tool;
      // 用户提问不进入工具审批链。审批决定是否允许操作，提问请求用户提供信息。
      // 提问通道由 Host 管理，不能由策略档位或规则表启用、禁用。
      if (capability === undefined && UNASKED.has(named)) {
        return { decision: 'allow', via: 'unasked', capability: named, level: current, ...(forcedToAsk ? { forced: true } : {}) };
      }

      const command = commandOf(input);
      const effective = forcedToAsk && current !== 'never' ? 'ask' : current;
      // 记录此次判定时的有效策略；拒绝阈值触发的收紧状态另行记录。
      const judged = (decision: PolicyVerdict['decision'], via: string, extra: Omit<PolicyVerdict, 'decision' | 'via' | 'capability' | 'level' | 'forced'>, hardDenied = false): PolicyVerdict => ({
        decision,
        via,
        capability: named,
        level: current,
        ...(forcedToAsk || hardDenied ? { forced: true } : {}),
        ...extra,
      });
      const candidates = currentRules.filter((item) => item.tool === named);
      // 先按 Host 选择的语法解析命令，再逐段应用规则。解析不完整时将整条命令视为无法确认。
      const kind = shell?.kind ?? 'bash';
      const inspection = command === undefined ? undefined : await inspectCommand(command, kind);
      const parsed = inspection?.parsed;
      const segments = parsed?.kind === 'segments' ? parsed.segments : undefined;
      // 没有命令文本的调用仍作为一个分段应用规则检查。
      const parts = command === undefined ? [undefined] : segments;
      // 在结果中包含解析分段，便于从记录中还原命令如何被解释。
      // 无命令文本或无法解析时不返回分段字段。
      const answer = (via: string, rule?: PolicyRule) => judged('allow', via, {
        ...(segments === undefined ? {} : { segments }),
        ...(rule?.match === undefined ? {} : { rule: rule.match }),
      });

      const refuse = (code: string, via: string, reason: string, rule?: string, reply?: string): PolicyVerdict => {
        record(true);
        return judged('deny', via, {
          code,
          reason,
          ...(rule === undefined ? {} : { rule }),
          ...(reply === undefined ? {} : { answer: reply }),
        });
      };

      const hardDeny = (reason: string): PolicyVerdict => {
        record(true);
        return judged('deny', 'hard-deny', { code: 'policy_hard_denied', reason }, true);
      };

      let requiresManualApproval = access === 'external' || access === 'unknown';
      let manualApprovalReason = access === 'external'
        ? 'this operation runs in an external process that the built-in sandbox cannot confine'
        : access === 'unknown'
          ? 'this tool has no permission classification and requires per-call approval'
          : undefined;
      if (command !== undefined) {
        if (segments !== undefined && !canAutoApprove(inspection)) {
          requiresManualApproval = true;
          manualApprovalReason ??= '命令使用脚本解释器或包装器，需要逐次审批';
        }
        const classified = await classifyDangerousCommand(command, kind, inspection, commandCwd(input));
        if (classified?.kind === 'hard-deny') return hardDeny(classified.reason);
        if (classified?.kind === 'approval') {
          requiresManualApproval = true;
          manualApprovalReason ??= parsed?.kind === 'segments'
            ? classified.reason
            : askReason(parsed, target, shell) ?? classified.reason;
        }
      }

      // 先拒绝格式不支持的 URL 和不允许访问的网络地址，再进行后续权限判定。
      if (target !== undefined && (target.failure !== undefined || target.class === undefined)) {
        return refuse('policy_denied', 'target', `分不出这一个网络目标的类别（${target.failure ?? 'unsupported'}）`);
      }
      if (target?.class === 'link-local' || target?.class === 'unspecified') {
        return refuse('policy_denied', 'target', `${target.class} 这一类地址（链路本地、元数据端点、组播与保留段）不在这一趟运行里取回`);
      }
      const loopOrPrivate = target?.class === 'loopback' || target?.class === 'private';

      // 任一匹配规则拒绝时就拒绝调用，后续放行规则不能覆盖拒绝。
      // 命令规则同时检查整条命令和每个分段，以拦截管道中的危险命令。
      const denied = candidates.find((item) => item.decision === 'deny'
        && (matches(command, item.match) || (segments ?? []).some((segment) => matches(segment, item.match))));
      if (denied) {
        return refuse('policy_denied', 'rule', denied.reason ?? `${named} 被规则表拒绝`, denied.match);
      }

      for (const check of guards) {
        const reason = check({ tool: named, input, command });
        if (typeof reason === 'string') return refuse('guard_denied', 'guard', reason);
      }

      const allowed = candidates.filter((item) => item.decision === 'allow');
      // 记录实际匹配的放行规则名称，便于解释判定结果。
      const covering = () => (parts === undefined ? undefined : allowed.find((item) => parts.every((segment) => matches(segment, item.match))));
      let covered;
      if (loopOrPrivate) {
        // 环回和私有网络地址至少需要一次审批；宽泛的字符串规则无法可靠确认最终连接地址。
        covered = undefined;
      } else if (command === undefined) {
        // 不含命令文本的调用不受命令语法检查影响；自动策略可放行，逐次审批仍需匹配放行规则。
        covered = effective === 'auto' ? null : covering();
      } else if (effective === 'auto') {
        // 自动策略只放行可完整解析且每段首词都不是脚本解释器的命令。
        // 不剥离解释器包装；例如 `bash -lc "git status"` 仍须审批。
        covered = segments !== undefined && canAutoApprove(inspection) ? null : undefined;
      } else if (effective === 'never') {
        // 显式关闭审批只跳过确认步骤；目标检查、拒绝规则和守卫仍然生效。
        // 命令含糊、由解释器执行或目标属于私有网络时仍按拒绝处理。
        covered = command === undefined || (segments !== undefined && canAutoApprove(inspection)) ? null : undefined;
      } else {
        // 逐次审批要求放行规则覆盖每个命令分段；无法解析的命令不能视为已覆盖。
        covered = segments !== undefined && parts?.every((segment) => allowed.some((item) => matches(segment, item.match)))
          ? covering()
          : undefined;
      }
      if (requiresManualApproval) covered = undefined;
      if (covered !== undefined) {
        record(false);
        return covered === null ? answer(effective === 'never' ? 'never' : 'auto') : answer('rules', covered);
      }

      if (effective === 'never') {
        return refuse('policy_denied', 'never', 'this operation requires approval, which is disabled for this session');
      }

      // 自动策略无法识别命令时转为逐次审批，并返回无法自动放行的原因。
      const reason = requiresManualApproval
        ? manualApprovalReason
        : askReason(parsed, target, shell);
      if (typeof ask !== 'function') return refuse('ask_unavailable', 'ask', reason ?? '这一条连接上没有问人的通道', undefined, 'unavailable');
      // 审批请求包含 Host 实际使用的语法和可执行文件，避免用户批准一种解释、实际执行另一种。
      // 不含命令文本时省略这两个字段。将当前策略及来源随请求返回，确保客户端显示的是本次调用所属会话的状态。
      // `policyForced` 标记策略是否因连续拒绝而收紧。
      const question: PolicyQuestion = {
        tool: named,
        input,
        command,
        reason,
        policy: effective,
        policySource: source,
        policyForced: forcedToAsk,
        ...(shell === undefined ? {} : { shell: shell.kind, executable: shell.executable }),
      };
      if (await ask(question) !== true) return refuse('ask_declined', 'ask', 'the user declined', undefined, 'deny');
      record(false);
      return judged('allow', 'ask', { ...(segments === undefined ? {} : { segments }), answer: 'allow' });
    },
  };
}
