// 系统提示组装（D9）：静态段在前，接一个分界标记，登记的动态片段在后，最后是尾部追加。
// 两个装配口：replace 换掉分界标记之前的静态段，append 排在已经组装好的文本之后。
// 静态段、分界标记、动态片段、尾部追加，四段按这个顺序排，空的那一段不留空行。
// 分界标记总是出现：它划出可以整份复用的那一段静态前缀，派生的子执行体拿同一份静态前缀字节
// 就能命中缓存；标记本身随开关进出，反而会让前缀字节每次都变。
import { KernelError } from './error.js';

export const PROMPT_BOUNDARY = '--- ligule: dynamic context below ---';

// 片段被截时留下一行看得见的标记（I6）：上限算在完整结果上，标记自己也算字节。
// 预算小到连标记都放不下时仍然交回标记，因为「这里少了一段」必须看得见，而这么小的预算是配置错误。
function cap(text, maxBytes, name) {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  const note = `\n[prompt fragment ${JSON.stringify(name)} truncated to fit ${maxBytes} bytes]`;
  const budget = maxBytes - Buffer.byteLength(note, 'utf8');
  if (budget <= 0) return note.slice(1);
  let kept = bytes.subarray(0, budget).toString('utf8');
  while (Buffer.byteLength(kept, 'utf8') > budget) kept = kept.slice(0, -1);
  return kept + note;
}

export function createPromptAssembly(options = {}) {
  const fragments = [];
  return {
    // 静态前缀是子执行体可以直接复用的那一份字节：同一个装配器渲染两次得到的是同一个字符串。
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
      // 静态段、分界标记、动态片段、尾部追加，空的那一段不留空行。
      return [this.staticPrefix, PROMPT_BOUNDARY, dynamic, options.append ?? ''].filter((part) => part !== '').join('\n\n');
    },
  };
}
