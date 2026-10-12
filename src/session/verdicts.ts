// 判定结果的汇总（D77、实现顺序第 38 步）：读一份会话记录算出来，内核里不另存第二份计数器。
// 三档说的是「没问人就成了」「问过人」「没让做」，加上命中的规则与拒绝的码：档位是不是太粗，要靠这几格答。
import type { SessionEvent } from './format.js';

export interface VerdictCounts {
  capability: string;
  auto: number;
  asked: number;
  allowed: number;
  denied: number;
  codes: Record<string, number>;
  rules: Record<string, number>;
  levels: Record<string, number>;
}

interface RecordedVerdict {
  decision?: unknown;
  via?: unknown;
  capability?: unknown;
  level?: unknown;
  forced?: unknown;
  rule?: unknown;
  answer?: unknown;
}

// 被拒绝阈值压到逐次询问的那一次算哪一档：写成 `ask(forced)`，因为它既不是配置里的那一份档位，也不是一般的问。
function levelOf(verdict: RecordedVerdict): string {
  const level = typeof verdict.level === 'string' ? verdict.level : 'unknown';
  return verdict.forced === true ? `${level}→ask` : level;
}

function bump(table: Record<string, number>, key: string): void {
  table[key] = (table[key] ?? 0) + 1;
}

export function summarizeVerdicts(events: SessionEvent[]): VerdictCounts[] {
  const byCapability = new Map<string, VerdictCounts>();
  for (const event of events) {
    if (event.kind !== 'tool') continue;
    const verdict = event.verdict as RecordedVerdict | undefined;
    // 没有判定链的那一次调用（单元测试与以后可能有的旁路）不留这一格，也就不进这份汇总。
    if (typeof verdict?.decision !== 'string') continue;
    const capability = typeof verdict.capability === 'string' && verdict.capability !== ''
      ? verdict.capability
      : String(event.tool ?? '');
    const item = byCapability.get(capability)
      ?? { capability, auto: 0, asked: 0, allowed: 0, denied: 0, codes: {}, rules: {}, levels: {} };
    byCapability.set(capability, item);
    bump(item.levels, levelOf(verdict));
    // 命中的规则两种结果都要数：放行规则写宽了与拒绝规则拦住了什么，是同一份证据（D77）。
    if (typeof verdict.rule === 'string' && verdict.rule !== '') bump(item.rules, verdict.rule);
    if (verdict.decision === 'deny') {
      item.denied += 1;
      const code = (event.result as { code?: string } | undefined)?.code ?? 'unknown';
      bump(item.codes, code);
      continue;
    }
    item.allowed += 1;
    if (verdict.via === 'ask') item.asked += 1;
    else item.auto += 1;
  }
  return [...byCapability.values()].sort((left, right) => left.capability.localeCompare(right.capability));
}

// 一行一个能力名：给人看的这一份与上面那份是同一批数，不另算一遍。
export function formatVerdicts(counts: VerdictCounts[]): string[] {
  return counts.map((item) => {
    const rules = Object.entries(item.rules).map(([rule, count]) => `"${rule}"×${count}`).join(' ');
    const codes = Object.entries(item.codes).map(([code, count]) => `${code}×${count}`).join(' ');
    const levels = Object.entries(item.levels).map(([level, count]) => `${level}×${count}`).join(' ');
    return `${item.capability}  自动 ${item.auto}  问过 ${item.asked}  没让做 ${item.denied}`
      + `  档位 ${levels}`
      + (rules === '' ? '' : `  命中规则 ${rules}`)
      + (codes === '' ? '' : `  码 ${codes}`);
  });
}
