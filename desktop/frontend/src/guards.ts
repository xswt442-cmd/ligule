/** 把未知值收窄成普通对象；数组与 null 都不算对象。 */
export function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 需要直接读取字段时的空对象兜底，避免每个面板各写一份同样的三元表达式。 */
export function objectOrEmpty(value: unknown): Record<string, unknown> {
  return object(value) ? value : {};
}
