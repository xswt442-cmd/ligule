import { KernelError } from '../kernel/error.js';
import { resolveCredential } from '../kernel/credentials.js';
import { apiRoot } from './http.js';

const MAX_RESPONSE_BYTES = 1024 * 1024;

export function discoveredModelIds(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || !('data' in value) || !Array.isArray(value.data)) {
    throw new KernelError('model_discovery_response_invalid');
  }
  const ids = value.data.flatMap((item: unknown) => {
    if (typeof item !== 'object' || item === null || !('id' in item) || typeof item.id !== 'string') return [];
    const id = item.id.trim();
    return id !== '' && id.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(id) ? [id] : [];
  });
  return [...new Set(ids)].slice(0, 128);
}

export async function discoverModels(input: { api: unknown; baseURL: unknown; reference: unknown }): Promise<string[]> {
  if (input.api !== 'chat-completions') throw new KernelError('model_discovery_unsupported');
  if (typeof input.reference !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(input.reference)) {
    throw new KernelError('credential_reference_invalid');
  }
  const apiKey = await resolveCredential(input.reference);
  if (apiKey === undefined) throw new KernelError('provider_credential_missing');
  const root = apiRoot(input.baseURL);
  let response: Response;
  try {
    response = await fetch(`${root}/models`, {
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
    });
  } catch {
    throw new KernelError('model_discovery_failed');
  }
  if (!response.ok) throw new KernelError('model_discovery_failed', { detail: `HTTP ${response.status}` });
  const size = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(size) && size > MAX_RESPONSE_BYTES) {
    // 不继续读取已知超限的目录；关闭响应体，避免长连接占用资源。
    void response.body?.cancel().catch(() => {});
    throw new KernelError('model_discovery_response_too_large');
  }
  const reader = response.body?.getReader();
  if (reader === undefined) throw new KernelError('model_discovery_response_invalid');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        // 即使上游拒绝取消，也应稳定报告响应超限，而非传输错误。
        try { await reader.cancel(); } catch { /* best-effort cleanup */ }
        throw new KernelError('model_discovery_response_too_large');
      }
      chunks.push(next.value);
    }
  } catch (cause) {
    if (cause instanceof KernelError) throw cause;
    throw new KernelError('model_discovery_failed', { cause });
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const body = new TextDecoder().decode(bytes);
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { throw new KernelError('model_discovery_response_invalid'); }
  return discoveredModelIds(parsed);
}
