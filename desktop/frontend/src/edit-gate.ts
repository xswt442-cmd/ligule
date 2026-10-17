// 各设置区在本地状态中保留未保存编辑；关闭或切换由父级处理。
// 设置页和右侧面板共用此接口，以便离开前统一确认。
export type EditGate = Record<string, string>;

/** 设置区更新未保存文本；传入空串会移除该项。内容未变时返回原对象，避免无效渲染。 */
export function report(gate: EditGate, key: string, reason: string): EditGate {
  // 未登记的设置区按空内容处理；移除空内容不会改变状态。
  const now = gate[key] ?? '';
  if (now === reason) return gate;
  const next = { ...gate };
  if (reason === '') delete next[key];
  else next[key] = reason;
  return next;
}

/** 判断是否存在需要确认的未保存编辑。 */
export function holdReasons(gate: EditGate): string[] {
  return Object.values(gate).filter((reason) => reason !== '');
}
