import type { AskQuestion } from '@ligule/core/tui.js';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isAskQuestion(value: unknown): value is AskQuestion {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.question === 'string'
    && typeof value.multiSelect === 'boolean'
    && Array.isArray(value.options)
    && value.options.every(option => isRecord(option) && typeof option.label === 'string');
}
