/**
 * Rejections from the Host, Kernel and tools are `KernelError` values, so the
 * code is the stable half of a failure and the detail is a human sentence the
 * caller may inspect when it knows the rejection carries one.
 */
export function hasCode(error: unknown, code: string): error is { code: string; detail: string } {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}
