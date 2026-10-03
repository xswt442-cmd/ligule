// `fetch`：一个 URL 换回一段文本（D48、D58）。第一版只做 GET、只走 http 与 https、不带任何身份，
// 也不抽正文——域名与实际字节数要进会话记录，先把「按边界取回并留在记录里」这一件事做对。
import { fetchTarget, resolveTarget } from '../capability/network.js';
import { limitsOf } from '../capability/limits.js';
import { KernelError } from '../kernel/error.js';
import type { NetworkTarget } from '../capability/network.js';

export const fetchTool = {
  name: 'fetch',
  description: 'Fetch one URL as text: GET only, http or https, no cookies and no credentials of this machine.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The absolute http(s) URL to read.' },
    },
    required: ['url'],
  },
  // 参数里哪一个是取回目标交给内核（模型看不见这一格，D12）：判定链看的是解析之后的地址类别（D58）。
  targetArgument: 'url',
  async run(args: { url?: string }, { config, signal, target }: { config: Parameters<typeof limitsOf>[0]; signal?: AbortSignal; target?: NetworkTarget }) {
    if (typeof args.url !== 'string' || args.url.trim() === '') {
      throw new KernelError('fetch_url_required', { detail: 'fetch takes one absolute URL' });
    }
    const { fetchBytes, fetchTimeoutMs, fetchRedirects } = limitsOf(config);
    // 走过判定链的那一次调用拿得到链条批准过的那一份目标，直接连它解析出的地址；
    // 没有链的那一条入口（`ligule call`）自己解析一次，工具这层的拒绝对两条路都生效。
    const approved = target ?? await resolveTarget(args.url);
    const page = await fetchTarget(approved, { maxBytes: fetchBytes, timeoutMs: fetchTimeoutMs, redirectLimit: fetchRedirects, signal });
    return {
      text: page.text,
      host: approved.host,
      addresses: approved.addresses,
      targetClass: approved.class,
      finalUrl: page.finalUrl,
      hops: page.hops,
      bytes: page.bytes,
      truncated: page.truncated,
      contentType: page.contentType,
    };
  },
};

export const networkPlugin = {
  name: 'ligule-network',
  setup(kernel: { register(tool: unknown): () => void }) {
    return kernel.register(fetchTool);
  },
};
