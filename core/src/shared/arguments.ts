import { KernelError } from '../errors.js';

// 使用 shell 引号规则解析参数；引号不配对时返回错误，避免改变用户输入含义。
export function splitArguments(text: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: string | undefined;
  let started = false;
  for (const character of text) {
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (started) tokens.push(current);
      current = '';
      started = false;
      continue;
    }
    current += character;
    started = true;
  }
  if (quote !== undefined) throw new KernelError('template_arguments_unbalanced', { detail: `${text} leaves a ${quote} quote open` });
  if (started) tokens.push(current);
  return tokens;
}
