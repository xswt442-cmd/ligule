import {
  parseProviderDiagnostic,
  providerDiagnosticText as providerDiagnosticTextPair,
  runtimeFailureText as coreRuntimeFailureText,
  type Locale,
} from '@ligule/core/tui.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function providerDiagnosticText(value: unknown, locale: Locale = 'zh'): string | undefined {
  if (!isRecord(value)) return undefined;
  const diagnostic = parseProviderDiagnostic(value);
  if (diagnostic === undefined) return undefined;
  return providerDiagnosticTextPair(diagnostic)[locale === 'zh' ? 'zh' : 'en'];
}

export function runtimeFailureText(code: string, locale: Locale = 'zh'): string | undefined {
  return coreRuntimeFailureText(code, locale === 'en' ? 'en' : 'zh');
}
