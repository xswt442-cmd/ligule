// 网络目标的分类与取回（D58）：判定要发生在地址解析之后，而且每一跳重做一遍。
// 一个看着对外的 URL 靠一次重定向就能把请求带进内网或云主机的元数据端点，
// 所以「先看字符串再放行」这一条顺序本身是错的。
import { lookup } from 'node:dns/promises';
import { KernelError } from '../kernel/error.js';

export type TargetClass = 'public' | 'loopback' | 'private' | 'link-local';
// 分类之外的两种情况：URL 或端口不能用（只放 http 与 https），以及名字解析不出地址。
export type TargetFailure = 'unsupported' | 'unresolved';

export interface NetworkTarget {
  class: TargetClass | undefined;
  failure: TargetFailure | undefined;
  host: string;
  port: string;
  addresses: string[];
}

const GROUPS: { bits: number[], class: TargetClass, length: number }[] = [
  // IPv4 里这几段是环回、专用与链路本地（含云主机的元数据端点 169.254.169.254）。
  { bits: [127], class: 'loopback', length: 1 },
  { bits: [10], class: 'private', length: 1 },
  { bits: [172, 16], class: 'private', length: 2 },
  { bits: [192, 168], class: 'private', length: 2 },
  { bits: [169, 254], class: 'link-local', length: 2 },
  { bits: [100, 64], class: 'private', length: 2 },
  { bits: [0], class: 'loopback', length: 1 },
];

function classifyV4(address: string): TargetClass | undefined {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined;
  if (parts[1] !== undefined && parts[1] >= 16 && parts[1] <= 31 && parts[0] === 172) return 'private';
  if (parts[0] === 100 && parts[1] !== undefined && parts[1] >= 64 && parts[1] <= 127) return 'private';
  for (const group of GROUPS) {
    if (group.length === 1 ? parts[0] === group.bits[0] : parts[0] === group.bits[0] && parts[1] === group.bits[1]) return group.class;
  }
  return undefined;
}

// IPv6 只按前缀判那几段常写的：环回 ::1、唯一本地 fc00::/7、链路本地 fe80::/10，
// 以及写成 IPv4 映射地址（::ffff:127.0.0.1）的那一种。
function classifyV6(address: string): TargetClass | undefined {
  const lowered = address.toLowerCase().split('%')[0];
  if (lowered === '::1') return 'loopback';
  const mapped = lowered.match(/^::ffff:([\d.]+)$/);
  if (mapped !== null) return classifyV4(mapped[1]);
  const head = Number.parseInt(lowered.replace(/:/g, '').slice(0, 4), 16);
  if (Number.isNaN(head)) return undefined;
  if ((head & 0xfe00) === 0xfc00) return 'private';
  if ((head & 0xffc0) === 0xfe80) return 'link-local';
  return undefined;
}

export function classifyAddress(address: string): TargetClass {
  return address.includes(':') ? classifyV6(address) ?? 'public' : classifyV4(address) ?? 'public';
}

// 只放 http 与 https；端口与用户名密码那几样由 URL 解析器给出的值原样带进判定，不做默认推断。
export function parseTarget(url: string): { host: string; port: string } {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new KernelError('fetch_scheme_unsupported', { detail: `only http and https are fetched, not ${parsed.protocol}` });
  return { host: parsed.hostname, port: parsed.port === '' ? (parsed.protocol === 'https:' ? '443' : '80') : parsed.port };
}

// options.resolve 是给测试留的缝：真机上这一步是 dns.promises.lookup，测试里换成一张固定的表，
// 判的仍然是同一分类函数，不是替它编一个结果。
export async function classifyTarget(url: string, options: { resolve?: (host: string) => Promise<string[]> } = {}): Promise<NetworkTarget> {
  let host: string;
  let port: string;
  try {
    ({ host, port } = parseTarget(url));
  } catch {
    return { class: undefined, failure: 'unsupported', host: '', port: '', addresses: [] };
  }
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const literal = classifyLiteral(bare);
  if (literal !== undefined) return { class: literal.class, failure: undefined, host, port, addresses: [literal.address] };
  if (host === '' ) return { class: undefined, failure: 'unsupported', host, port, addresses: [] };
  let addresses;
  try {
    addresses = options.resolve === undefined ? (await lookup(bare, { all: true })).map((entry) => entry.address) : await options.resolve(bare);
  } catch {
    return { class: undefined, failure: 'unresolved', host, port, addresses: [] };
  }
  if (addresses.length === 0) return { class: undefined, failure: 'unresolved', host, port, addresses: [] };
  // 一个名字可以指向多个地址，最严的那一个算这一跳的类别：公网名字里混进一个内网地址就是内网。
  const ranked: TargetClass[] = ['link-local', 'loopback', 'private', 'public'];
  const classes = addresses.map(classifyAddress);
  return { class: ranked.find((rank) => classes.includes(rank)), failure: undefined, host, port, addresses };
}

function classifyLiteral(host: string): { class: TargetClass; address: string } | undefined {
  if (host === 'localhost') return { class: 'loopback', address: 'localhost' };
  if (/^[\d.]+$/.test(host) || host.includes(':')) return { class: classifyAddress(host), address: host };
  return undefined;
}

export interface FetchResult {
  text: string;
  bytes: number;
  shownBytes: number;
  truncated: boolean;
  finalUrl: string;
  hops: number;
  contentType: string;
}

// 取回那一页：每一跳都重新分类，跳到的类别与最初批准的类别不同就停在这里。
// 最初的批准是对那一个地址给的，不能由远端服务器决定跳到哪儿去。
export async function fetchTarget(url: string, { maxBytes, timeoutMs, redirectLimit, signal }: {
  maxBytes: number;
  timeoutMs: number;
  redirectLimit: number;
  signal?: AbortSignal;
}): Promise<FetchResult> {
  const approved = await classifyTarget(url);
  if (approved.failure !== undefined || approved.class === undefined) {
    throw new KernelError('fetch_target_denied', { detail: `${url} is not a target this run can classify (${approved.failure ?? 'unsupported'})` });
  }
  const hops: string[] = [url];
  for (let hop = 0; hop <= redirectLimit; hop += 1) {
    const target = hop === 0 ? url : hops[hop];
    const response = await request(target, { timeoutMs, signal });
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location !== null) {
      if (hop === redirectLimit) throw new KernelError('fetch_redirect_limit', { detail: `${url} redirected more than ${redirectLimit} times` });
      const next = await followSameClass(response.url ?? target, location, approved.class);
      hops.push(next);
      response.body?.cancel().catch(() => {});
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new KernelError('fetch_response_failed', { detail: `${response.url ?? target} answered ${response.status}` });
    }
    return await readBody(response, { maxBytes, finalUrl: response.url ?? target, hops: hop });
  }
  throw new KernelError('fetch_redirect_limit', { detail: `${url} redirected more than ${redirectLimit} times` });
}

async function request(url: string, { timeoutMs, signal }: { timeoutMs: number; signal?: AbortSignal }) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const cancelled = signal === undefined ? timeout : AbortSignal.any([timeout, signal]);
  let response;
  try {
    // 不带任何凭据：没有 cookie  jar、没有自定义头、也不读环境里的 token，redirect 自己管。
    response = await fetch(url, { method: 'GET', redirect: 'manual', credentials: 'omit', headers: {}, signal: cancelled });
  } catch (error) {
    if (signal?.aborted) throw new KernelError('fetch_cancelled', { cause: error, detail: 'the request was cancelled' });
    throw new KernelError('fetch_transport_failed', { cause: error, detail: `${url} could not be fetched: ${timeout.aborted ? `no answer within ${timeoutMs}ms` : String((error as Error).cause ?? error)}` });
  }
  return response;
}

async function followSameClass(from: string, location: string, approved: TargetClass): Promise<string> {
  const next = new URL(location, from).href;
  const target = await classifyTarget(next);
  if (target.failure !== undefined || target.class !== approved) {
    throw new KernelError('fetch_redirect_denied', {
      detail: `${from} redirects to ${next} (${target.class ?? target.failure}), which is not the ${approved} target this call was approved for`,
    });
  }
  return next;
}

async function readBody(response: Response, { maxBytes, finalUrl, hops }: { maxBytes: number; finalUrl: string; hops: number }): Promise<FetchResult> {
  const reader = response.body?.getReader();
  if (reader === undefined) return { text: '', bytes: 0, shownBytes: 0, truncated: false, finalUrl, hops, contentType: '' };
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let shownBytes = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    bytes += value.length;
    if (shownBytes >= maxBytes) {
      truncated = true;
      continue;
    }
    const keep = value.subarray(0, maxBytes - shownBytes);
    chunks.push(keep);
    shownBytes += keep.length;
    truncated = truncated || keep.length < value.length;
  }
  const text = Buffer.concat(chunks).toString('utf8');
  const contentType = response.headers.get('content-type') ?? '';
  return {
    text: truncated ? `${text}\n[truncated: ${shownBytes} of ${bytes} bytes shown]` : text,
    bytes,
    shownBytes,
    truncated,
    finalUrl,
    hops,
    contentType,
  };
}
