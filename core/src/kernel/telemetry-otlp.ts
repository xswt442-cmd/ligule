import { ROOT_CONTEXT, SpanKind, SpanStatusCode, trace as otelTrace } from '@opentelemetry/api';
import type { Attributes, Context, Span } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import { KernelError } from './error.js';
interface OtlpTraceSink {
  emit(event: Readonly<Record<string, string | number | boolean>>): void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

const OTLP_EXPORT_TIMEOUT_MS = 250;
const OTLP_MAX_ACTIVE_SPANS = 512;
const OTLP_MAX_SPANS_PER_TRACE = 2_048;
const OTLP_ENVIRONMENT_KEYS = Object.freeze([
  'OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
  'OTEL_EXPORTER_OTLP_HEADERS', 'OTEL_EXPORTER_OTLP_TRACES_HEADERS',
  'OTEL_EXPORTER_OTLP_TIMEOUT', 'OTEL_EXPORTER_OTLP_TRACES_TIMEOUT',
  'OTEL_EXPORTER_OTLP_COMPRESSION', 'OTEL_EXPORTER_OTLP_TRACES_COMPRESSION',
  'OTEL_EXPORTER_OTLP_CERTIFICATE', 'OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE', 'OTEL_EXPORTER_OTLP_CLIENT_KEY',
  'OTEL_EXPORTER_OTLP_TRACES_CERTIFICATE', 'OTEL_EXPORTER_OTLP_TRACES_CLIENT_CERTIFICATE', 'OTEL_EXPORTER_OTLP_TRACES_CLIENT_KEY',
]);

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

function otlpExporterFor(endpoint: string): OTLPTraceExporter {
  const environment = new Map<string, string>();
  for (const key of OTLP_ENVIRONMENT_KEYS) {
    const value = process.env[key];
    if (value !== undefined) {
      environment.set(key, value);
      delete process.env[key];
    }
  }
  try {
    return new OTLPTraceExporter({ url: endpoint, headers: {}, timeoutMillis: OTLP_EXPORT_TIMEOUT_MS, concurrencyLimit: 1 });
  } finally {
    for (const [key, value] of environment) process.env[key] = value;
  }
}

export function createOtlpTraceSink(endpoint: string): OtlpTraceSink {
  const exporter = otlpExporterFor(endpoint);
  const processor = new BatchSpanProcessor({ exporter, maxQueueSize: 256, maxExportBatchSize: 32,
    scheduledDelayMillis: 250, exportTimeoutMillis: OTLP_EXPORT_TIMEOUT_MS });
  const provider = new TracerProvider({ spanProcessors: [processor], resource: resourceFromAttributes({ 'service.name': 'ligule' }),
    spanLimits: { attributeCountLimit: 32, attributeValueLengthLimit: 256, eventCountLimit: 0, linkCountLimit: 0 } });
  const tracer = provider.getTracer('ligule.core');
  const runs = new Map<string, Span>();
  const tools = new Map<string, Span>();
  const operations = new Map<string, Span>();
  const active = new Set<Span>();
  const traceCounts = new Map<string, number>();
  let closed = false;

  const toolKey = (executionId: string, callId: string): string => `${executionId}\0${callId}`;
  const operationKey = (type: string, id: string): string => `${type}\0${id}`;

  function parentContext(parent?: Span): Context {
    return parent === undefined ? ROOT_CONTEXT : otelTrace.setSpanContext(ROOT_CONTEXT, parent.spanContext());
  }

  function baseAttributes(event: Readonly<Record<string, string | number | boolean>>): Attributes {
    return {
      'ligule.telemetry.schema_version': 1,
      'ligule.execution.id': event.executionId as string,
      ...(typeof event.runId === 'string' ? { 'ligule.run.id': event.runId } : {}),
      ...(typeof event.sessionId === 'string' ? { 'ligule.session.id': event.sessionId } : {}),
      ...(typeof event.userSeq === 'number' ? { 'ligule.user.seq': event.userSeq } : {}),
    };
  }

  function start(event: Readonly<Record<string, string | number | boolean>>, name: string, kind: SpanKind, parent?: Span,
    extra: Attributes = {}): Span | undefined {
    if (closed || active.size >= OTLP_MAX_ACTIVE_SPANS) return undefined;
    const span = tracer.startSpan(name, { kind, attributes: { ...baseAttributes(event), ...extra } }, parentContext(parent));
    const traceId = span.spanContext().traceId;
    const count = traceCounts.get(traceId) ?? 0;
    if (count >= OTLP_MAX_SPANS_PER_TRACE) {
      span.end();
      return undefined;
    }
    traceCounts.set(traceId, count + 1);
    active.add(span);
    return span;
  }

  function finish(span: Span | undefined, attributes: Attributes = {}, status: 'ok' | 'error' = 'ok', errorCode?: string): void {
    if (span === undefined || !active.delete(span)) return;
    try {
      span.setAttributes(attributes);
      if (errorCode !== undefined) span.setAttribute('ligule.error.code', errorCode);
      span.setStatus(status === 'error' ? { code: SpanStatusCode.ERROR, ...(errorCode === undefined ? {} : { message: errorCode }) }
        : { code: SpanStatusCode.OK });
      span.end();
    } catch { /* Export instrumentation cannot alter Host execution. */ }
  }

  function clearTraceIfDone(span: Span | undefined): void {
    if (span === undefined) return;
    const traceId = span.spanContext().traceId;
    if (![...active].some(item => item.spanContext().traceId === traceId)) traceCounts.delete(traceId);
  }

  function runParent(event: Readonly<Record<string, string | number | boolean>>): Span | undefined {
    if (typeof event.parentExecutionId !== 'string') return undefined;
    if (typeof event.parentCallId === 'string') return tools.get(toolKey(event.parentExecutionId, event.parentCallId));
    return runs.get(event.parentExecutionId);
  }

  return {
    emit(event) {
      if (closed) return;
      const executionId = event.executionId as string;
      const eventType = event.type;
      if (eventType === 'run.started') {
        if (runs.has(executionId)) return;
        if (event.parentExecutionId !== undefined && runParent(event) === undefined) return;
        const span = start(event, 'ligule.run', SpanKind.INTERNAL, runParent(event), {
          ...(typeof event.runId === 'string' ? { 'ligule.run.id': event.runId } : {}),
          ...(typeof event.parentRunId === 'string' ? { 'ligule.parent.run.id': event.parentRunId } : {}),
          ...(typeof event.parentExecutionId === 'string' ? { 'ligule.parent.execution.id': event.parentExecutionId } : {}),
          ...(typeof event.parentCallId === 'string' ? { 'ligule.parent.tool_call.id': event.parentCallId } : {}),
          'ligule.run.status': 'running',
        });
        if (span !== undefined) runs.set(executionId, span);
        return;
      }
      if (eventType === 'run.finished') {
        const span = runs.get(executionId);
        runs.delete(executionId);
        const status = event.status as string;
        finish(span, { 'ligule.run.status': status, 'ligule.model.request_count': event.modelCalls as number,
          'ligule.tool.call_count': event.toolCalls as number }, status === 'completed' ? 'ok' : 'error',
        typeof event.errorCode === 'string' ? event.errorCode : status === 'cancelled' ? 'run_cancelled' : undefined);
        clearTraceIfDone(span);
        return;
      }
      if (eventType === 'model.started') {
        if (!runs.has(executionId)) return;
        const requestId = event.requestId as string;
        const span = start(event, 'gen_ai.chat', SpanKind.CLIENT, runs.get(executionId), {
          'gen_ai.operation.name': 'chat',
          'ligule.model.request.id': requestId,
          'ligule.model.logical_request.id': event.logicalRequestId as string,
          'ligule.model.attempt': event.attempt as number,
          ...(typeof event.provider === 'string' ? { 'gen_ai.system': event.provider } : {}),
          ...(typeof event.model === 'string' ? { 'gen_ai.request.model': event.model } : {}),
        });
        if (span !== undefined) operations.set(operationKey('model', requestId), span);
        return;
      }
      if (eventType === 'model.finished') {
        const span = operations.get(operationKey('model', event.requestId as string));
        operations.delete(operationKey('model', event.requestId as string));
        const attrs: Attributes = { 'ligule.model.attempt': event.attempt as number,
          'ligule.model.duration_ms': event.durationMs as number,
          'ligule.model.status': event.status as string,
          'ligule.usage.reported': typeof event.inputTokens === 'number' || typeof event.outputTokens === 'number'
            || typeof event.cacheHitInputTokens === 'number' || typeof event.cacheMissInputTokens === 'number'
            || typeof event.cacheCreationInputTokens === 'number' || typeof event.cacheUncachedInputTokens === 'number',
          'ligule.usage.input_reported': typeof event.inputTokens === 'number',
          'ligule.usage.output_reported': typeof event.outputTokens === 'number',
          'ligule.usage.cache_reported': typeof event.cacheSource === 'string',
          ...(typeof event.inputTokens === 'number' ? { 'gen_ai.usage.input_tokens': event.inputTokens } : {}),
          ...(typeof event.outputTokens === 'number' ? { 'gen_ai.usage.output_tokens': event.outputTokens } : {}),
          ...(typeof event.cacheSource === 'string' ? { 'ligule.usage.cache.source': event.cacheSource } : {}),
          ...(typeof event.cacheSourceFields === 'string' ? { 'ligule.usage.cache.source_fields': event.cacheSourceFields } : {}),
          ...(typeof event.cacheHitInputTokens === 'number' ? { 'ligule.usage.cache.hit_input_tokens': event.cacheHitInputTokens } : {}),
          ...(typeof event.cacheMissInputTokens === 'number' ? { 'ligule.usage.cache.miss_input_tokens': event.cacheMissInputTokens } : {}),
          ...(typeof event.cacheCreationInputTokens === 'number' ? { 'ligule.usage.cache.creation_input_tokens': event.cacheCreationInputTokens } : {}),
          ...(typeof event.cacheUncachedInputTokens === 'number' ? { 'ligule.usage.cache.uncached_input_tokens': event.cacheUncachedInputTokens } : {}),
          ...(typeof event.providerInputIncludesCache === 'boolean' ? { 'ligule.usage.provider_input_includes_cache': event.providerInputIncludesCache } : {}),
          ...(typeof event.cacheConsistent === 'boolean' ? { 'ligule.usage.cache.consistent': event.cacheConsistent } : {}),
          ...(typeof event.finishReason === 'string' ? { 'ligule.model.finish_reason': event.finishReason } : {}) };
        const code = typeof event.errorCode === 'string' ? event.errorCode : undefined;
        finish(span, attrs, event.status === 'completed' && code === undefined ? 'ok' : 'error', code);
        return;
      }
      if (eventType === 'tool.started') {
        if (!runs.has(executionId)) return;
        const callId = event.callId as string;
        const key = toolKey(executionId, callId);
        if (tools.has(key)) return;
        const span = start(event, `ligule.tool.${event.tool as string}`, SpanKind.INTERNAL, runs.get(executionId), {
          'ligule.tool.name': event.tool as string,
          'ligule.tool.call_id': callId,
        });
        if (span !== undefined) tools.set(key, span);
        return;
      }
      if (eventType === 'tool.finished') {
        const key = toolKey(executionId, event.callId as string);
        const span = tools.get(key);
        tools.delete(key);
        const outcome = event.outcome as string;
        finish(span, { 'ligule.tool.name': event.tool as string, 'ligule.tool.call_id': event.callId as string,
          'ligule.tool.outcome': outcome, 'ligule.tool.duration_ms': event.durationMs as number },
        outcome === 'success' ? 'ok' : 'error', typeof event.errorCode === 'string' ? event.errorCode : undefined);
        return;
      }
      if (eventType === 'approval.started') {
        const requestId = event.requestId as string;
        const parent = typeof event.callId === 'string' ? tools.get(toolKey(executionId, event.callId)) ?? runs.get(executionId) : runs.get(executionId);
        if (parent === undefined) return;
        const span = start(event, 'ligule.approval', SpanKind.INTERNAL, parent, {
          'ligule.approval.request.id': requestId,
          ...(typeof event.callId === 'string' ? { 'ligule.tool.call_id': event.callId } : {}),
        });
        if (span !== undefined) operations.set(operationKey('approval', requestId), span);
        return;
      }
      if (eventType === 'approval.finished') {
        const span = operations.get(operationKey('approval', event.requestId as string));
        operations.delete(operationKey('approval', event.requestId as string));
        finish(span, { 'ligule.approval.decision': event.decision as string,
          'ligule.approval.duration_ms': event.durationMs as number,
          ...(typeof event.callId === 'string' ? { 'ligule.tool.call_id': event.callId } : {}) },
        event.decision === 'error' ? 'error' : 'ok', typeof event.errorCode === 'string' ? event.errorCode : undefined);
        return;
      }
      if (eventType === 'compaction.started') {
        if (!runs.has(executionId)) return;
        const operationId = event.operationId as string;
        const span = start(event, 'ligule.compaction', SpanKind.INTERNAL, runs.get(executionId), {
          'ligule.compaction.operation': event.operation as string,
          'ligule.compaction.operation_id': operationId,
          'ligule.compaction.input_messages': event.inputMessages as number,
        });
        if (span !== undefined) operations.set(operationKey('compaction', operationId), span);
        return;
      }
      if (eventType === 'compaction.finished') {
        const span = operations.get(operationKey('compaction', event.operationId as string));
        operations.delete(operationKey('compaction', event.operationId as string));
        const status = event.status as string;
        finish(span, { 'ligule.compaction.operation': event.operation as string,
          'ligule.compaction.status': status, 'ligule.compaction.duration_ms': event.durationMs as number,
          'ligule.compaction.input_messages': event.inputMessages as number,
          ...(typeof event.outputMessages === 'number' ? { 'ligule.compaction.output_messages': event.outputMessages } : {}) },
        status === 'failed' || status === 'cancelled' ? 'error' : 'ok',
        typeof event.errorCode === 'string' ? event.errorCode : undefined);
      }
    },
    async flush() {
      try { await provider.forceFlush({ timeoutMillis: OTLP_EXPORT_TIMEOUT_MS }); } catch { /* Export failure is isolated from Agent work. */ }
    },
    async shutdown() {
      if (closed) return;
      closed = true;
      for (const span of active) finish(span, { 'ligule.span.incomplete_at_shutdown': true }, 'error', 'telemetry_shutdown');
      active.clear();
      runs.clear(); tools.clear(); operations.clear(); traceCounts.clear();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const shutdown = provider.shutdown().catch(() => {});
      try {
        await Promise.race([shutdown, new Promise<void>(resolveTimeout => {
          timeout = setTimeout(resolveTimeout, OTLP_EXPORT_TIMEOUT_MS);
        })]);
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
    },
  };
}
