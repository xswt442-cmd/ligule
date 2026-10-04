// 网络目标的解析、分类与取回（D58）。判定建立在解析之后的地址上，而且连接用的就是这一次批准的那些地址：
// 「查一次 DNS 判断、再让 HTTP 客户端自己查第二次」的两次结果可以不是同一个地址，那一次的允许也就盖不住实际连过去的那一个。
// 主机名继续用于 Host 头、TLS SNI 与证书校验；只有建立连接时改成用已经批准的地址。
import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { ClientRequestArgs } from 'node:http';
import { KernelError } from '../kernel/error.js';

// public 走正常规则；loopback 与 private 至少问到一次；link-local（含云主机的元数据端点）与
// unspecified（未指定、组播、保留段这一类根本不该被取回的地址）一律拒。
export type TargetClass = 'public' | 'loopback' | 'private' | 'link-local' | 'unspecified';
export type TargetFailure = 'unsupported' | 'unresolved';

export interface NetworkTarget {
  url: string;
  scheme: 'http:' | 'https:';
  host: string;
  port: string;
  path: string;
  addresses: string[];
  class: TargetClass;
  failure: TargetFailure | undefined;
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

const DENIED: TargetClass[] = ['link-local', 'unspecified'];

function parseV4(address: string): number[] | undefined {
  const parts = address.split('.');
  if (parts.length !== 4) return undefined;
  const bytes = parts.map((part) => Number(part));
  return bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255) ? bytes : undefined;
}

const bytesOf = (words: number[]): number[] => words.flatMap((word) => [(word >> 8) & 0xff, word & 0xff]);

const wordsOf = (text: string): number[] | undefined => {
  if (text === '') return [];
  const words: number[] = [];
  for (const part of text.split(':')) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return undefined;
    words.push(Number.parseInt(part, 16));
  }
  return words;
};

// IPv6 手写一个够用的解析器，落到字节再判：URL 会把 ::ffff:127.0.0.1 规范化成 ::ffff:7f00:1，
// 按字符串前缀判就会把环回看成公网，尾段写成 IPv4 与写成十六进制必须是同一个结果。
function parseV6(address: string): number[] | undefined {
  const lowered = address.toLowerCase().split('%')[0];
  if (!lowered.includes(':')) return undefined;
  const embedded = lowered.match(/(?:^|:)((?:\d{1,3}\.){3}\d{1,3})$/);
  let head = lowered;
  let tail: number[] = [];
  if (embedded?.[1] !== undefined) {
    const v4 = parseV4(embedded[1]);
    if (v4 === undefined) return undefined;
    tail = v4;
    head = lowered.slice(0, lowered.length - embedded[1].length).replace(/:+$/, '');
  }
  const compressed = head.indexOf('::');
  if (compressed < 0) {
    const words = wordsOf(head);
    if (words === undefined || words.length * 2 + tail.length !== 16) return undefined;
    return [...bytesOf(words), ...tail];
  }
  if (head.indexOf('::', compressed + 1) >= 0) return undefined;
  const left = wordsOf(head.slice(0, compressed));
  const right = wordsOf(head.slice(compressed + 2));
  if (left === undefined || right === undefined) return undefined;
  const missing = 8 - left.length - right.length - tail.length / 2;
  if (missing < 0) return undefined;
  return [...bytesOf(left), ...new Array(missing * 2).fill(0), ...bytesOf(right), ...tail];
}

function classifyBytes(bytes: number[]): TargetClass {
  if (bytes.length === 4) {
    const [a, b] = bytes;
    if (a === 127) return 'loopback';
    if (a === 10 || (a === 172 && (b ?? 0) >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && (b ?? 0) >= 64 && b <= 127)) return 'private';
    if (a === 169 && b === 254) return 'link-local';
    if (a === 0 || a >= 224) return 'unspecified';
    return 'public';
  }
  if (bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return classifyBytes(bytes.slice(12));
  }
  if (bytes.every((byte) => byte === 0)) return 'unspecified';
  if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return 'loopback';
  if ((bytes[0] & 0xfe) === 0xfc) return 'private';
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return 'link-local';
  if (bytes[0] === 0xff) return 'unspecified';
  return 'public';
}

export function classifyAddress(address: string): TargetClass {
  const v4 = parseV4(address);
  if (v4 !== undefined) return classifyBytes(v4);
  const v6 = parseV6(address);
  return v6 === undefined ? 'unspecified' : classifyBytes(v6);
}

const familyOf = (address: string): 4 | 6 => (address.includes(':') ? 6 : 4);

// 最严的那一个地址算这一跳的类别：一个名字里混进一个内网地址就是内网。
function strictest(classes: TargetClass[]): TargetClass {
  const order: TargetClass[] = ['unspecified', 'link-local', 'private', 'loopback', 'public'];
  return order.find((rank) => classes.includes(rank)) ?? 'public';
}

async function resolveAddresses(host: string, resolve: (host: string) => Promise<string[]>): Promise<string[]> {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (/^[\d.]+$/.test(bare) || bare.includes(':')) return [bare];
  if (bare === 'localhost' || bare.endsWith('.localhost')) return ['127.0.0.1', '::1'];
  return resolve(bare);
}

// 一次解析出这一次要用的地址。解析不出与不支持是两种要告诉人的事，都不按「当公网算」处理。
export async function resolveTarget(url: unknown, options: { resolve?: (host: string) => Promise<string[]> } = {}): Promise<NetworkTarget> {
  const resolve = options.resolve ?? (async (host: string) => (await lookup(host, { all: true })).map((entry) => entry.address));
  const text = typeof url === 'string' ? url : String(url);
  const failed = (failure: TargetFailure): NetworkTarget => ({
    url: text, scheme: 'http:', host: '', port: '', path: '', addresses: [], class: 'unspecified', failure,
  });
  if (text.trim() === '') return failed('unsupported');
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return failed('unsupported');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return failed('unsupported');
  if (parsed.username !== '' || parsed.password !== '') return failed('unsupported');
  if (parsed.hostname === '') return failed('unsupported');
  let addresses;
  try {
    addresses = await resolveAddresses(parsed.hostname, resolve);
  } catch {
    return failed('unresolved');
  }
  if (addresses.length === 0) return failed('unresolved');
  return {
    url: parsed.href,
    scheme: parsed.protocol,
    host: parsed.hostname,
    port: parsed.port !== '' ? parsed.port : parsed.protocol === 'https:' ? '443' : '80',
    path: `${parsed.pathname}${parsed.search}`,
    addresses,
    class: strictest(addresses.map(classifyAddress)),
    failure: undefined,
  };
}

// 连的是地址，写的是名字：Host 头与 TLS SNI 取主机名，证书按主机名校验（Node 拿 servername 那一个做身份检查）。
// lookup 只交回批准过的那几个地址，socket 不再自己问一次 DNS。
// 连接时只交回批准过的那一个地址：Node 的 lookup 钩子就是给这种用法留的，不必引入 HTTP 依赖。
type LookupOption = NonNullable<ClientRequestArgs['lookup']>;

function pinnedLookup(address: string): LookupOption {
  return (_host, _options, callback) => callback(null, address, familyOf(address));
}

function connect(target: NetworkTarget, approved: NetworkTarget, { maxBytes, timeoutMs, signal }: {
  maxBytes: number;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<{ status: number; location: string; contentType: string; bytes: number; head: string; truncated: boolean; from: string }> {
  return new Promise((resolve, reject) => {
    const cancel = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal === undefined ? [] : [signal])]);
    const port = Number(target.port);
    const hostHeader = port === 80 || port === 443 ? approved.host : `${approved.host}:${port}`;
    const from = `${target.scheme}//${approved.host}${port === 80 || port === 443 ? '' : `:${port}`}${target.path}`;
    const send = (target.scheme === 'https:' ? httpsRequest : httpRequest)(
      {
        protocol: target.scheme,
        hostname: target.addresses[0],
        host: hostHeader,
        port,
        path: target.path,
        method: 'GET',
        ...(target.scheme === 'https:' ? { servername: approved.host } : {}),
        headers: { host: hostHeader, accept: '*/*' },
        lookup: pinnedLookup(target.addresses[0]),
        agent: false,
        signal: cancel,
      },
      (response) => {
        let bytes = 0;
        let shown = 0;
        let truncated = false;
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (shown >= maxBytes) {
            truncated = true;
            return;
          }
          const keep = chunk.subarray(0, maxBytes - shown);
          chunks.push(keep);
          shown += keep.length;
          truncated = truncated || keep.length < chunk.length;
        });
        response.once('end', () => resolve({
          status: response.statusCode ?? 0,
          location: typeof response.headers.location === 'string' ? response.headers.location : '',
          contentType: typeof response.headers['content-type'] === 'string' ? response.headers['content-type'] : '',
          bytes,
          head: Buffer.concat(chunks).toString('utf8'),
          truncated,
          from,
        }));
        response.once('error', reject);
      },
    );
    send.once('error', (error) => {
      if (signal?.aborted) {
        reject(new KernelError('fetch_cancelled', { cause: error, detail: 'the request was cancelled' }));
        return;
      }
      reject(new KernelError('fetch_transport_failed', {
        cause: error,
        detail: `${from} could not be fetched: ${cancel.aborted ? `no answer within ${timeoutMs}ms` : String((error as Error).cause ?? error.message)}`,
      }));
    });
    send.end();
  });
}

// 只跟同源的重定向：换了主机或端口就要一次新的批准，而一次取回里不该再弹第二个询问。
// 每一跳重新解析并按同一张表重判——批准给的是「那一个名字的这些地址」，不是远端接下来想去的任何地方。
export async function fetchTarget(approved: NetworkTarget, { maxBytes, timeoutMs, redirectLimit, signal, resolve }: {
  maxBytes: number;
  timeoutMs: number;
  redirectLimit: number;
  signal?: AbortSignal;
  resolve?: (host: string) => Promise<string[]>;
}): Promise<FetchResult> {
  if (approved.failure !== undefined) {
    throw new KernelError('fetch_url_invalid', { detail: `${approved.url} is not a URL this tool can fetch (${approved.failure})` });
  }
  if (DENIED.includes(approved.class)) {
    throw new KernelError('fetch_target_denied', { detail: `${approved.url} resolves to a ${approved.class} address (${approved.addresses.join(', ')})` });
  }
  let target = approved;
  for (let hop = 0; ; hop += 1) {
    const answer = await connect(target, approved, { maxBytes, timeoutMs, signal });
    if (answer.status >= 300 && answer.status < 400 && answer.location !== '') {
      if (hop === redirectLimit) throw new KernelError('fetch_redirect_limit', { detail: `${approved.url} redirected more than ${redirectLimit} times` });
      const next = new URL(answer.location, answer.from);
      if (next.origin !== new URL(approved.url).origin) {
        throw new KernelError('fetch_redirect_denied', {
          detail: `${answer.from} redirects to ${next.origin}, another origin; the approval covered ${approved.url}`,
        });
      }
      const reresolved = await resolveTarget(next.href, { resolve });
      if (reresolved.failure !== undefined || reresolved.class !== approved.class) {
        throw new KernelError('fetch_redirect_denied', {
          detail: `${answer.from} redirects to ${next.href}, which resolves as ${reresolved.class ?? reresolved.failure}, not the ${approved.class} target that was approved`,
        });
      }
      target = reresolved;
      continue;
    }
    if (answer.status < 200 || answer.status >= 300) {
      throw new KernelError('fetch_response_failed', { detail: `${answer.from} answered ${answer.status}` });
    }
    return {
      text: answer.truncated ? `${answer.head}\n[truncated: ${answer.head.length} of ${answer.bytes} bytes shown]` : answer.head,
      bytes: answer.bytes,
      shownBytes: answer.head.length,
      truncated: answer.truncated,
      finalUrl: answer.from,
      hops: hop,
      contentType: answer.contentType,
    };
  }
}
