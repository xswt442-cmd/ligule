// 系统提示由静态段、分界标记、动态片段和尾部追加依次组成。
// `replace` 替换分界标记前的静态段；`append` 在完整提示末尾追加文本。
// 空段不产生额外空行。分界标记始终保留，以便不同执行复用相同静态前缀并命中模型缓存。
import { KernelError } from './error.js';

export const PROMPT_BOUNDARY = '--- ligule: dynamic context below ---';

export interface PromptFragment {
  readonly name: string;
  readonly anchor: number;
  readonly text: string;
  readonly maxBytes: number;
}

export interface PromptAssemblyOptions {
  readonly static?: string;
  readonly replace?: string;
  readonly append?: string;
}

export interface PromptAssembly {
  readonly staticPrefix: string;
  fragment(definition: PromptFragment): () => void;
  render(): string;
}

// 动态片段超限时添加可见截断标记；标记本身也计入字节预算。
// 预算不足以容纳标记时仍返回标记，说明配置预算过小。
function cap(text: string, maxBytes: number, name: string): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  const note = `\n[prompt fragment ${JSON.stringify(name)} truncated to fit ${maxBytes} bytes]`;
  const budget = maxBytes - Buffer.byteLength(note, 'utf8');
  if (budget <= 0) return note.slice(1);
  let kept = bytes.subarray(0, budget).toString('utf8');
  while (Buffer.byteLength(kept, 'utf8') > budget) kept = kept.slice(0, -1);
  return kept + note;
}

export function createPromptAssembly(options: PromptAssemblyOptions = {}): PromptAssembly {
  const fragments: PromptFragment[] = [];
  return {
    // 静态前缀保持稳定；同一装配器的重复渲染返回相同内容。
    get staticPrefix() {
      return options.replace ?? options.static ?? '';
    },
    fragment(definition) {
      if (!Number.isFinite(definition?.anchor)) throw new KernelError('prompt_fragment_anchor_required');
      if (typeof definition.name !== 'string' || definition.name === '') throw new KernelError('prompt_fragment_name_required');
      if (typeof definition.text !== 'string') throw new KernelError('prompt_fragment_text_required');
      if (!(definition.maxBytes >= 1)) throw new KernelError('prompt_fragment_max_bytes_required');
      fragments.push(definition);
      return () => {
        const index = fragments.indexOf(definition);
        if (index >= 0) fragments.splice(index, 1);
      };
    },
    render() {
      const dynamic = fragments
        .slice()
        .sort((left, right) => left.anchor - right.anchor || left.name.localeCompare(right.name))
        .map((fragment) => cap(fragment.text, fragment.maxBytes, fragment.name))
        .join('\n\n');
      // 按固定顺序组合各段，并忽略空段。
      return [this.staticPrefix, PROMPT_BOUNDARY, dynamic, options.append ?? ''].filter((part) => part !== '').join('\n\n');
    },
  };
}
