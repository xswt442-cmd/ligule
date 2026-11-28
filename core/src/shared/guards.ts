import { isAbsolute } from 'node:path';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return isRecord(value);
}

export function errorCode(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isPortableAbsolutePath(value: string): boolean {
  return isAbsolute(value) || /^[A-Za-z]:[\\/]/u.test(value) || /^\\\\[^\\/]+[\\/]/u.test(value);
}

export function isNullNativeHandle(handle: number | bigint | null | undefined): boolean {
  return handle === null || handle === undefined || handle === 0 || handle === 0n;
}
