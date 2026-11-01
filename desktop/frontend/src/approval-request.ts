// 把 Host 的 approval.request 参数整理成审批卡需要的形状。
// 这里只做参数归一与文案，不决定是否放行，也不持有界面状态。
import type { Ask } from './components/ApprovalCard';
import { capabilityOf, changeBody, changeOf } from './rows.ts';
export type Text = (chinese: string, english: string) => string;

export type ApprovalRequestParams = {
  sessionId?: string;
  projectRoot?: string;
  tool?: string;
  command?: string;
  args?: Record<string, unknown>;
  reason?: string;
  shell?: string;
  executable?: string;
  policy?: string;
  policySource?: string;
  policyForced?: boolean;
  detailsRef?: string;
  argumentBytes?: number;
  argumentSha256?: string;
  identityDigest?: string;
  contentBytes?: number;
  contentSha256?: string;
  rememberable?: boolean;
  rememberScopes?: ('session' | 'project' | 'user')[];
  rememberHintKey?: 'file' | 'tool' | 'command' | 'mcp';
  rememberTargetOptions?: ('file' | 'workspace' | 'tool' | 'command')[];
  scriptBinding?: {
    path?: string;
    sha256?: string;
    interpreter?: string;
    workspaceRoot?: string;
    permission?: { profile?: string; network?: string; capabilities?: Record<string, string> };
  };
};

/** 请求必须属于某个会话，否则不显示审批卡。 */
export function approvalSession(params: ApprovalRequestParams | undefined): string | null {
  const owner = params?.sessionId;
  return typeof owner === 'string' && owner !== '' ? owner : null;
}

/** 组装摘要、变更说明与脚本绑定说明；返回值与 `Ask` 的界面字段一一对应。 */
export function toApprovalAsk(id: string, params: ApprovalRequestParams, t: Text): Ask {
  const tool = params.tool ?? '';
  const args = params.args ?? {};
  const detail = String(params.command ?? args.path ?? args.url ?? capabilityOf(tool, args));
  const change = changeOf(tool, args);
  const content = changeBody(change, args);
  const englishChange = changeOf(tool, args, 'en');
  // 脚本审批必须显示实际执行的文件、摘要与权限绑定，避免只看到路径。
  const detailsSuffix = params.scriptBinding === undefined ? { chinese: '', english: '' } : {
    chinese: `\n\n${t('脚本审批绑定', 'Script approval binding')}:\n${t('路径', 'Path')}: ${params.scriptBinding.path ?? ''}\nSHA-256: ${params.scriptBinding.sha256 ?? ''}\n${t('解释器', 'Interpreter')}: ${params.scriptBinding.interpreter ?? ''}\n${t('工作区', 'Workspace')}: ${params.scriptBinding.workspaceRoot ?? ''}\n${t('权限', 'Permission')}: ${params.scriptBinding.permission?.profile ?? ''} / ${params.scriptBinding.permission?.network ?? ''}\n${JSON.stringify(params.scriptBinding.permission?.capabilities ?? {})}`,
    english: `\n\nScript approval binding:\nPath: ${params.scriptBinding.path ?? ''}\nSHA-256: ${params.scriptBinding.sha256 ?? ''}\nInterpreter: ${params.scriptBinding.interpreter ?? ''}\nWorkspace: ${params.scriptBinding.workspaceRoot ?? ''}\nPermission: ${params.scriptBinding.permission?.profile ?? ''} / ${params.scriptBinding.permission?.network ?? ''}\n${JSON.stringify(params.scriptBinding.permission?.capabilities ?? {})}`,
  };
  const summary = typeof params.contentBytes === 'number' && typeof params.contentSha256 === 'string'
    ? `${t(`内容 ${params.contentBytes} 字节 · SHA-256 ${params.contentSha256}`, `Content ${params.contentBytes} bytes · SHA-256 ${params.contentSha256}`)}\n\n`
    : typeof params.argumentSha256 === 'string'
      ? `${t(`参数 ${params.argumentBytes ?? 0} 字节 · SHA-256 ${params.argumentSha256}`, `Arguments ${params.argumentBytes ?? 0} bytes · SHA-256 ${params.argumentSha256}`)}\n\n`
      : '';
  return {
    id,
    sessionId: params.sessionId ?? '',
    project: params.projectRoot ?? '',
    tool,
    detail,
    change: change.summary,
    reason: params.reason ?? '',
    // 显示权限判定使用的命令语法和实际执行文件。
    backend: params.shell === undefined ? '' : `${params.shell} · ${params.executable ?? ''}`,
    // 同时显示本次审批使用的策略、策略来源和是否因连续拒绝而收紧。
    policy: params.policy ?? '',
    policySource: params.policySource ?? '',
    policyForced: params.policyForced === true,
    rememberable: params.rememberable === true,
    rememberScopes: params.rememberScopes ?? [],
    ...(params.rememberHintKey === undefined ? {} : { rememberHintKey: params.rememberHintKey }),
    ...(Array.isArray(params.rememberTargetOptions) ? { rememberTargetOptions: params.rememberTargetOptions } : {}),
    ...(typeof params.detailsRef === 'string' ? { detailsRef: params.detailsRef } : {}),
    ...(typeof params.argumentBytes === 'number' ? { argumentBytes: params.argumentBytes } : {}),
    ...(typeof params.argumentSha256 === 'string' ? { argumentSha256: params.argumentSha256 } : {}),
    ...(typeof params.identityDigest === 'string' ? { identityDigest: params.identityDigest } : {}),
    detailsLoaded: false,
    detailsLoading: false,
    detailsSuffix,
    content: `${summary}${content}${detailsSuffix.chinese}`,
    english: { change: englishChange.summary, content: `${summary}${changeBody(englishChange, args, 'en')}${detailsSuffix.english}` },
  };
}
