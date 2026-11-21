// `/sub` 从父记录读取派生会话 ID；结果溢出时支线 ID 可能不在记录里。
import { isRecord } from './guards.js';
import type { TuiRecord } from './transcript.js';

export function branchOf(record: TuiRecord | undefined): { readonly code: 'tui_sub_needs_a_branch' } | { readonly sessionId: string } | { readonly code: 'tui_sub_reference_spilled'; readonly spilled: string | undefined } {
  if (record?.kind !== 'tool' || (record.tool !== 'subagent' && record.tool !== 'subagent_start')) return { code: 'tui_sub_needs_a_branch' };
  const result = isRecord(record.result) ? record.result : undefined;
  const content = isRecord(result?.content) ? result.content : undefined;
  const sessionId = content?.sessionId ?? (record.tool === 'subagent_start' ? content?.subrunId : undefined);
  // 结果超出限制时存入溢出文件；此时支线 ID 可能不在记录内容中。
  if (typeof sessionId !== 'string' || sessionId === '') {
    return { code: 'tui_sub_reference_spilled', spilled: typeof result?.spilled === 'string' ? result.spilled : undefined };
  }
  return { sessionId };
}
