// 思考档是会话级设置：null 表示清除覆盖、继承模型默认（resetThinking）。
// 写入走 Core 协议的 session.configure；方法名与参数在这里集中，避免界面各写一份走样的名字。
export function thinkingRequest(sessionId: string, effort: string | null): {
  readonly method: 'session.configure';
  readonly params: { readonly sessionId: string; readonly resetThinking?: true; readonly thinkingEffort?: string };
} {
  return {
    method: 'session.configure',
    params: { sessionId, ...(effort === null ? { resetThinking: true as const } : { thinkingEffort: effort }) },
  };
}
