// `fetch`：一个 URL 换回一段文本（D48、D58）。第一版只做 GET、只走 http 与 https、不带任何身份，
// 也不抽正文——域名与实际字节数要进会话记录，先把「按边界取回并留在记录里」这一件事做对。
import { fetchTarget, parseTarget } from '../capability/network.js';
import { limitsOf } from '../capability/limits.js';
import { KernelError } from '../kernel/error.js';

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
  // 目标类别在判定链那一步已经按解析后的地址过了一次（D58）；这里只管把那一页取回来，
  // 并重做每一跳的分类——批准是给最初那一个地址的，跳到哪儿不由远端服务器决定。
  targetArgument: 'url',
  async run(args: { url: string }, { config, signal }: { config: Record<string, unknown>; signal?: AbortSignal }) {
    if (typeof args.url !== 'string' || args.url.trim() === '') {
      throw new KernelError('fetch_url_required', { detail: 'fetch takes one absolute URL' });
    }
    const { fetchBytes, fetchTimeoutMs, fetchRedirects } = limitsOf(config);
    const { host } = parseTarget(args.url);
    const page = await fetchTarget(args.url, { maxBytes: fetchBytes, timeoutMs: fetchTimeoutMs, redirectLimit: fetchRedirects, signal });
    return {
      text: page.text,
      host,
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
