// 网络目标解析、权限分类和连接使用同一组 DNS 结果，确保实际连接的地址就是已批准地址。
// 主机名仍用于 Host 头、TLS SNI 和证书校验；建立连接时将 DNS 结果固定为已批准地址。
import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { ClientRequestArgs } from 'node:http';
import { isIP } from 'node:net';
import { KernelError } from '../kernel/error.js';

// 公网地址按普通规则判定；环回和私有地址至少需要一次审批。
// 链路本地地址（含云元数据地址）和未指定、组播、保留地址一律拒绝。
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

// 将 IPv6 地址解析为字节后分类，正确识别 IPv4 映射地址。
// 例如 `::ffff:127.0.0.1` 和 `::ffff:7f00:1` 必须归为同一地址类别。
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

// 对一次 DNS 查询返回的所有地址采用最严格类别；只要包含私有地址，目标就按私有地址处理。
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

// 一次解析并返回本次连接使用的地址。解析失败和协议不支持分别报错，不将它们视为公网。
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

// 连接使用已批准的 IP 地址，但 Host 头、TLS SNI 和证书校验仍使用原始主机名。
// 自定义 lookup 只返回已批准的地址，防止 socket 再次查询 DNS。
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

// 只跟随同源重定向，避免跳转到其他主机或端口。
// 每一跳都重新解析并应用相同规则，不能将当前主机的批准扩展到重定向目标。
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

const POST_BODY_LIMIT = 64 * 1024;
const POST_RESPONSE_LIMIT = 2 * 1024 * 1024;
const POST_TIMEOUT_LIMIT = 30_000;

export function isBearerCredential(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 8192 && /^[A-Za-z0-9._~+\/-]+=*$/u.test(value);
}

/** Send one bounded JSON POST to the exact address covered by an existing approval. */
export async function postJsonTarget(approved: NetworkTarget, { body, bearer, maxBytes, timeoutMs, signal }: {
  body: Record<string, unknown>;
  bearer: string;
  maxBytes: number;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<{ status: number; text: string; bytes: number; contentType: string }> {
  if (approved.failure !== undefined || (approved.scheme !== 'http:' && approved.scheme !== 'https:')) {
    throw new KernelError('post_target_invalid');
  }
  if (DENIED.includes(approved.class) || !Array.isArray(approved.addresses) || approved.addresses.length === 0
    || approved.addresses.some((address) => isIP(address) === 0 || DENIED.includes(classifyAddress(address)))
    || strictest(approved.addresses.map(classifyAddress)) !== approved.class) {
    throw new KernelError('post_target_denied');
  }
  if (!isBearerCredential(bearer)) {
    throw new KernelError('post_bearer_invalid');
  }
  if (approved.scheme !== 'https:' && approved.class !== 'loopback') {
    throw new KernelError('post_insecure_auth_denied');
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new KernelError('post_limits_invalid');
  }
  if (signal?.aborted === true) throw new KernelError('post_cancelled');
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new KernelError('post_body_invalid');
  let encoded: string;
  try { encoded = JSON.stringify(body); }
  catch { throw new KernelError('post_body_invalid'); }
  if (encoded === undefined) throw new KernelError('post_body_invalid');
  const payload = Buffer.from(encoded, 'utf8');
  if (payload.length > POST_BODY_LIMIT) throw new KernelError('post_body_too_large');

  let url: URL;
  try { url = new URL(approved.url); }
  catch { throw new KernelError('post_target_invalid'); }
  const host = approved.host.startsWith('[') && approved.host.endsWith(']')
    ? approved.host.slice(1, -1) : approved.host;
  const port = Number(approved.port);
  const expectedPort = url.port !== '' ? url.port : url.protocol === 'https:' ? '443' : '80';
  if (url.protocol !== approved.scheme || url.hostname !== approved.host || expectedPort !== approved.port
    || url.username !== '' || url.password !== ''
    || `${url.pathname}${url.search}` !== approved.path || !Number.isInteger(port) || port < 1 || port > 65_535
    || approved.addresses.some((address) => isIP(address) === 0)) {
    throw new KernelError('post_target_invalid');
  }
  const responseLimit = Math.min(maxBytes, POST_RESPONSE_LIMIT);
  const requestTimeout = Math.min(timeoutMs, POST_TIMEOUT_LIMIT);
  const cancel = AbortSignal.any([AbortSignal.timeout(requestTimeout), ...(signal === undefined ? [] : [signal])]);
  const hostHeader = String(port) === (approved.scheme === 'https:' ? '443' : '80')
    ? approved.host : `${approved.host}:${port}`;

  return new Promise((resolve, reject) => {
    let request: ReturnType<typeof httpRequest> | undefined;
    let settled = false;
    const fail = (code: string) => {
      if (settled) return;
      settled = true;
      request?.destroy();
      reject(new KernelError(cancel.aborted ? signal?.aborted === true ? 'post_cancelled' : 'post_timeout' : code));
    };
    request = (approved.scheme === 'https:' ? httpsRequest : httpRequest)(
      {
        protocol: approved.scheme,
        hostname: approved.addresses[0],
        port,
        path: approved.path,
        method: 'POST',
        ...(approved.scheme === 'https:' ? { servername: host } : {}),
        headers: {
          host: hostHeader,
          authorization: `Bearer ${bearer}`,
          accept: 'application/json',
          'content-type': 'application/json',
          'content-length': payload.length,
        },
        lookup: pinnedLookup(approved.addresses[0]!),
        agent: false,
        signal: cancel,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          response.destroy();
          fail('post_redirect_denied');
          return;
        }
        let bytes = 0;
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > responseLimit) {
            fail('post_response_too_large');
            response.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.once('aborted', () => fail('post_response_incomplete'));
        response.once('error', () => fail('post_response_incomplete'));
        response.once('end', () => {
          if (settled) return;
          settled = true;
          resolve({
            status,
            text: Buffer.concat(chunks).toString('utf8').replaceAll(bearer, '[redacted]'),
            bytes,
            contentType: typeof response.headers['content-type'] === 'string' ? response.headers['content-type'] : '',
          });
        });
      },
    );
    request.once('error', () => {
      if (cancel.aborted) fail(signal?.aborted === true ? 'post_cancelled' : 'post_timeout');
      else fail('post_transport_failed');
    });
    request.end(payload);
  });
}
