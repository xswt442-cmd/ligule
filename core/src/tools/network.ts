// `fetch` 使用 GET 请求 HTTP(S) 地址，不携带身份信息，也不抽取正文。
// 工具将域名和实际响应字节写入会话记录，并遵守网络访问边界。
import { fetchTarget, resolveTarget } from '../capability/network.js';
import { limitsOf } from '../capability/limits.js';
import { KernelError } from '../kernel/error.js';
import type { NetworkTarget } from '../capability/network.js';

export const fetchTool = {
  name: 'fetch',
  access: 'network',
  readOnly: true,
  description: 'Fetch one URL as text: GET only, http or https, no cookies and no credentials of this machine.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The absolute http(s) URL to read.' },
    },
    required: ['url'],
  },
  // URL 参数由 Kernel 保留为内部元数据；权限判定使用解析后的目标地址类别。
  targetArgument: 'url',
  async run(args: { url?: string }, { config, signal, target }: { config: Parameters<typeof limitsOf>[0]; signal?: AbortSignal; target?: NetworkTarget }) {
    if (typeof args.url !== 'string' || args.url.trim() === '') {
      throw new KernelError('fetch_url_required', { detail: 'fetch takes one absolute URL' });
    }
    const { fetchBytes, fetchTimeoutMs, fetchRedirects } = limitsOf(config);
    // 有权限判定结果时直接连接已批准的地址；独立调用入口则在此解析目标。
    // 两条路径都会执行工具自身的拒绝规则。
    const approved = target ?? await resolveTarget(args.url);
    const page = await fetchTarget(approved, { maxBytes: fetchBytes, timeoutMs: fetchTimeoutMs, redirectLimit: fetchRedirects, signal });
    return {
      text: page.text,
      host: approved.host,
      addresses: page.addresses,
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
