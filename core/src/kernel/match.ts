// 权限规则和文件名匹配共用前缀及 `*` 通配语法。
// 命令前缀必须匹配完整参数边界，避免 `git status` 放行 `git statusfoo`。
function escapeLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function matches(input: string | undefined, pattern: string | undefined): boolean {
  if (pattern === undefined) return true;
  if (input === undefined) return false;
  if (pattern.includes('*')) {
    return new RegExp(`^${pattern.split('*').map(escapeLiteral).join('[\\s\\S]*')}$`).test(input);
  }
  return input === pattern || input.startsWith(`${pattern} `);
}

// 文件名匹配中 `*` 和 `?` 不跨路径分隔符，`**` 可以跨目录；`**/` 也可匹配零层目录。
// 比较前统一将路径分隔符转换为正斜杠。
export function matchesName(name: string, pattern: string): boolean {
  const source = pattern
    .split(/(\*\*\/|\*\*|\*|\?)/g)
    .map((part) => (part === '**/' ? '(?:[^/]*/)*' : part === '**' ? '[\\s\\S]*' : part === '*' ? '[^/]*' : part === '?' ? '[^/]' : escapeLiteral(part)))
    .join('');
  return new RegExp(`^${source}$`).test(name);
}
