// 视图里所有异步读取共享的所有权判定：作用域（连接、项目、会话、Host 代次、面板开关）
// 变化后，或某个命令/日志引用被移除后，之前发出的请求不再属于当前视图。
// 迟到的结果只能被丢弃，不能写回已经切换的界面。
export type ViewToken = {
  readonly scope: number;
  readonly key: string | null;
  readonly keyEpoch: number;
};

export type ViewScope = {
  /** 记录当前作用域代号；只用于诊断与测试。 */
  readonly scope: () => number;
  /** 作用域变化：连接、项目、会话、Host 重启或面板开关。 */
  readonly bump: () => void;
  /** 取一个可用于判定迟到结果的 token；key 表示命令或日志引用。 */
  readonly capture: (key?: string | null) => ViewToken;
  /** 引用被移除（关闭标签、切走会话）后，之前捕获的 token 失效。 */
  readonly forget: (key: string) => void;
  /** token 是否仍属于当前视图。 */
  readonly isCurrent: (token: ViewToken) => boolean;
};

export function createViewScope(): ViewScope {
  let scope = 0;
  const epochs = new Map<string, number>();
  const epochOf = (key: string): number => epochs.get(key) ?? 0;
  const isCurrent = (token: ViewToken): boolean => token.scope === scope
    && (token.key === null || token.keyEpoch === epochOf(token.key));
  return {
    scope: () => scope,
    bump: () => { scope += 1; },
    capture: (key) => ({
      scope,
      key: key ?? null,
      keyEpoch: key === undefined || key === null ? 0 : epochOf(key),
    }),
    forget: (key) => { epochs.set(key, epochOf(key) + 1); },
    isCurrent,
  };
}
