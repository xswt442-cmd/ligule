// 还没写进配置的编辑攥在各栏自己的状态里，而离开它的入口在父层：设置的四个出口、右侧面板的关闭与切换。
// 这一份表是两边唯一的桥——栏里报一句上来，父层在离开之前先问一遍（审阅 G2）。
export type EditGate = Record<string, string>;

/** 一栏把自己那一句报上来，空串是收回。内容没变时交回同一个对象：界面不为一句重复的报话再画一轮。 */
export function report(gate: EditGate, key: string, reason: string): EditGate {
  // 没报过的那一格读成空串：收回一份本来就空着的东西，不该算一次变化。
  const now = gate[key] ?? '';
  if (now === reason) return gate;
  const next = { ...gate };
  if (reason === '') delete next[key];
  else next[key] = reason;
  return next;
}

/** 拦住离开的那几句：一句都没有就可以直接走。 */
export function holdReasons(gate: EditGate): string[] {
  return Object.values(gate).filter((reason) => reason !== '');
}
