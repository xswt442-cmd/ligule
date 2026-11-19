import { KernelError } from './error.js';

/** Validate an OTLP/HTTP traces endpoint without loading the OpenTelemetry SDK. */
export function checkedOtlpEndpoint(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > 2_048) {
    throw new KernelError('telemetry_otlp_endpoint_invalid');
  }
  let endpoint: URL;
  try { endpoint = new URL(value); }
  catch { throw new KernelError('telemetry_otlp_endpoint_invalid'); }
  const host = endpoint.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  const loopbackAddress = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (!['http:', 'https:'].includes(endpoint.protocol) || !loopbackAddress || endpoint.username !== '' || endpoint.password !== ''
    || endpoint.search !== '' || endpoint.hash !== '' || !endpoint.pathname.endsWith('/v1/traces')) {
    throw new KernelError('telemetry_otlp_endpoint_invalid');
  }
  return endpoint.toString();
}
