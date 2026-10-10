import { Fold } from './Fold';
import type { Verbosity } from './types';

// 审批那一格：答的取值只有 allow 与 deny 两种，界面不动判定档位（D81 边界三）。
export type Ask = {
  id: string;
  // 那一次询问属于哪一份会话：宿主等的是一个答复，界面看着别的那一份时也答得了它（实现顺序第 71 步）。
  sessionId: string;
  // 那一份会话读的是哪一项目录，随那一次询问一起交回来：答的是「在那一个项目里做这件事」，看着别的那一份时也要看得见（方案 5.4）。
  project: string;
  tool: string;
  // 那一句要动的对象：命令文本、路径、目标地址或那一项 MCP 能力名。
  detail: string;
  change: string;
  // 判定链给的那一句为什么问，原样显示，不替它改写。
  reason: string;
  backend: string;
  // 那一次判定自己走的档位、它的来源，以及是不是被连着拒绝压到逐次询问的：这三样问那一份会话自己知道（审阅 C08）。
  policy: string;
  policySource: string;
  policyForced: boolean;
  content: string;
};

// 档位那一格说的是现在这一档怎么走到「问人」这一格的。只有 auto 与 ask 两种（D17）。
const TIER: Record<string, string> = {
  auto: '放行规则在这一档不参与，看的是守卫与命令语法：看不透的那一件才问到你',
  ask: '要有同一条放行规则盖住整条命令的每一个分段，其余都先问到你',
};

// 档位出自哪一件：配置那一份默认、这一份会话自己改过，还是连着拒掉几次被压下来的（D101、D93）。
const tierSource = (ask: Ask): string => ask.policyForced
  ? '这一份会话连着拒掉几次，这一档被压到逐次询问'
  : ask.policySource === 'session' ? '这一份会话自己改过档位'
    : ask.policySource === 'config' ? '配置文件里那一份默认档'
      : '那一次问过来时没带着来源';

export function ApprovalCard({ ask, queued, verbosity, active, onAnswer, onOpen }: {
  ask: Ask;
  queued: number;
  verbosity: Verbosity;
  active: string | null;
  onAnswer: (decision: 'allow' | 'deny') => void;
  onOpen: (sessionId: string) => void;
}) {
  // 问过来的那一份不是眼前这一份：答复按那一次请求的编号回去，跟看着的是哪一份无关。
  const background = ask.sessionId !== active;
  return <section className="approval" aria-label="等一个人答应的调用">
    <div className="approval-body">
      <div className="approval-head">
        <span className="approval-kind">{background ? '另一份会话要执行这一步' : '要执行这一步'}</span>
        <code className="row-tool">{ask.tool}</code>
        {ask.project !== '' && <span className="row-note">项目 {ask.project}</span>}
        {ask.backend !== '' && <span className="row-note">用的是 {ask.backend}</span>}
        {queued > 0 && <span className="row-note">后面还有 {queued} 条在等</span>}
        {background && <button type="button" onClick={() => onOpen(ask.sessionId)}>看这一份会话 {ask.sessionId.slice(0, 8)}</button>}
      </div>
      {ask.detail !== '' && <div className="row-target">{ask.detail}</div>}
      {ask.change !== '' && <div className="row-target">{ask.change}</div>}
      {ask.reason !== '' && <p className="approval-reason">{ask.reason}</p>}
      <Fold text={ask.content} verbosity={verbosity} always label="看要改的内容" />
    </div>
    <div className="approval-actions">
      <button type="button" data-tone="allow" onClick={() => onAnswer('allow')}>允许这一次</button>
      <button type="button" data-tone="deny" onClick={() => onAnswer('deny')}>不允许</button>
      <span className="approval-tier">这一条问过来时那一份会话走的是 {ask.policy === '' ? '那一次没带着档位' : ask.policy} 档（{tierSource(ask)}）：{TIER[ask.policy] ?? '这一档怎么走到问人这一格读不出来'}</span>
    </div>
  </section>;
}
