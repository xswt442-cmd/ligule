import type { SessionEvent } from './format.js';

export interface AtifSessionSource {
  readonly sessionId: string;
  readonly userSeq: number;
  readonly runId?: string;
  readonly agentName: string;
  readonly agentVersion: string;
  readonly modelName?: string;
}

export interface AtifExportOptions {
  readonly includeSensitiveContent?: boolean;
}

type JsonObject = Record<string, unknown>;
type AtifToolCall = {
  tool_call_id: string;
  function_name: string;
  arguments: JsonObject;
  extra?: JsonObject;
};
type AtifObservationResult = {
  source_call_id: string;
  content?: string;
  extra: JsonObject;
};
type AtifStep = {
  step_id: number;
  timestamp?: string;
  source: 'user' | 'agent' | 'system';
  model_name?: string;
  message: string;
  tool_calls?: AtifToolCall[];
  observation?: { results: AtifObservationResult[] };
  metrics?: { prompt_tokens?: number; completion_tokens?: number; cached_tokens?: number; extra?: JsonObject };
  extra?: JsonObject;
};

export interface AtifTrajectory {
  schema_version: 'ATIF-v1.8';
  session_id?: string;
  trajectory_id: string;
  agent: { name: string; version: string; model_name?: string };
  steps: AtifStep[];
  extra: JsonObject;
}

const REDACTED = '[redacted]';

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function hasAbsolutePath(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value === 'string') return /(?:^|[=\s"'])\/?(?:[A-Za-z]:[\\/]|\\\\|\/)/u.test(value);
  if (Array.isArray(value)) return value.some((item) => hasAbsolutePath(item, seen));
  if (!isObject(value) || seen.has(value)) return false;
  seen.add(value);
  return Object.entries(value).some(([key, item]) => /(?:^|_)(?:path|file|directory|cwd)(?:$|_)/iu.test(key)
    || hasAbsolutePath(item, seen));
}

function printable(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value === undefined) return undefined;
  const result = JSON.stringify(value);
  if (typeof result !== 'string') throw new TypeError('atif_tool_result_not_json_serializable');
  return result;
}

function eventArray(events: readonly SessionEvent[]): SessionEvent[] {
  const ordered = [...events].filter((event) => event.kind !== 'session');
  for (const event of ordered) {
    if (!Number.isSafeInteger(event.seq) || Number(event.seq) < 0) throw new TypeError('atif_session_event_sequence_invalid');
  }
  ordered.sort((left, right) => Number(left.seq) - Number(right.seq));
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index - 1].seq === ordered[index].seq) throw new TypeError('atif_session_event_sequence_duplicate');
  }
  return ordered;
}

function metricsFor(event: SessionEvent): AtifStep['metrics'] | undefined {
  if (event.kind !== 'usage') return undefined;
  const input = event.input;
  const output = event.output;
  const metrics: NonNullable<AtifStep['metrics']> = {};
  if (Number.isSafeInteger(input) && Number(input) >= 0) metrics.prompt_tokens = Number(input);
  if (Number.isSafeInteger(output) && Number(output) >= 0) metrics.completion_tokens = Number(output);
  const cache = isObject(event.cache) ? event.cache : undefined;
  if (cache !== undefined && (cache.source === 'chat-completions' || cache.source === 'anthropic-messages')) {
    const knownCount = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
    const hit = knownCount(cache.hitInputTokens);
    const miss = knownCount(cache.missInputTokens);
    const creation = knownCount(cache.creationInputTokens);
    const sourceFields = Array.isArray(cache.sourceFields) ? cache.sourceFields.flatMap((field) => {
      if (!isObject(field) || typeof field.field !== 'string' || !['prompt_tokens', 'prompt_cache_hit_tokens',
        'prompt_cache_miss_tokens', 'prompt_tokens_details.cached_tokens', 'input_tokens',
        'cache_read_input_tokens', 'cache_creation_input_tokens'].includes(field.field)) return [];
      return [{ field: field.field, tokens: knownCount(field.tokens) }];
    }).slice(0, 8) : [];
    if (hit !== null && cache.consistent !== false && (metrics.prompt_tokens === undefined || hit <= metrics.prompt_tokens)) {
      metrics.cached_tokens = hit;
    }
    metrics.extra = { ligule: { cache_source: cache.source, cache_hit_tokens_reported: hit, cache_miss_tokens: miss,
      cache_creation_tokens: creation, cache_consistent: typeof cache.consistent === 'boolean' ? cache.consistent : null,
      provider_input_includes_cache: typeof cache.providerInputIncludesCache === 'boolean' ? cache.providerInputIncludesCache : null,
      source_fields: sourceFields } };
  }
  return Object.keys(metrics).length > 0 ? metrics : undefined;
}

function userMessage(event: SessionEvent, includeSensitiveContent: boolean): string {
  return includeSensitiveContent ? optionalText(event.text) ?? '' : REDACTED;
}

function safeCallArguments(value: unknown, includeSensitiveContent: boolean): JsonObject {
  if (includeSensitiveContent) {
    if (value === undefined) return {};
    if (!isObject(value)) throw new TypeError('atif_tool_arguments_must_be_object');
    return value;
  }
  return {};
}

function checkedSource(source: AtifSessionSource): void {
  for (const [key, value] of Object.entries({
    sessionId: source.sessionId,
    agentName: source.agentName,
    agentVersion: source.agentVersion,
  })) {
    if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`atif_source_${key}_required`);
  }
  if (!Number.isSafeInteger(source.userSeq) || source.userSeq < 0) throw new TypeError('atif_source_user_seq_invalid');
  if (source.runId !== undefined && (typeof source.runId !== 'string' || source.runId === '')) throw new TypeError('atif_source_run_id_invalid');
}

export function sessionTurnToAtif(
  events: readonly SessionEvent[],
  source: AtifSessionSource,
  options: AtifExportOptions = {},
): AtifTrajectory {
  checkedSource(source);
  const includeSensitiveContent = options.includeSensitiveContent === true;
  const ordered = eventArray(events);
  const userIndex = ordered.findIndex((event) => event.kind === 'user' && event.seq === source.userSeq);
  if (userIndex < 0) throw new TypeError('atif_user_event_not_found');
  const user = ordered[userIndex];
  const runAcceptance = isObject(user.run) ? user.run : undefined;
  const actualRunId = typeof runAcceptance?.runId === 'string' ? runAcceptance.runId : undefined;
  if (source.runId !== undefined && actualRunId !== source.runId) throw new TypeError('atif_run_id_mismatch');
  const runId = source.runId ?? actualRunId;
  const nextUser = ordered.slice(userIndex + 1).find((event) => event.kind === 'user');
  const turnEvents = ordered.slice(userIndex, nextUser === undefined ? undefined : ordered.indexOf(nextUser));
  const terminalEvents = turnEvents.filter((event) => event.kind === 'turn' && event.userSeq === source.userSeq);
  if (terminalEvents.length > 1) throw new TypeError('atif_turn_terminal_duplicate');

  const resultEvents = new Map<string, SessionEvent>();
  const callOwner = new Map<string, number>();
  const assistantSteps = new Map<string, AtifStep>();
  const steps: AtifStep[] = [];
  const missing: string[] = [];
  let stepId = 0;
  let previousAssistantSeq = Number(user.seq);

  steps.push({
    step_id: ++stepId,
    source: 'user',
    ...(typeof runAcceptance?.acceptedAt === 'string' && Number.isFinite(Date.parse(runAcceptance.acceptedAt))
      ? { timestamp: runAcceptance.acceptedAt } : {}),
    message: userMessage(user, includeSensitiveContent),
    ...(!includeSensitiveContent ? { extra: { ligule: { content_redacted: true } } } : {}),
  });

  for (const event of turnEvents.slice(1)) {
    if (event.kind === 'assistant') {
      const calls = Array.isArray(event.toolCalls) ? event.toolCalls : [];
      const toolCalls: AtifToolCall[] = [];
      for (const value of calls) {
        if (!isObject(value) || typeof value.id !== 'string' || value.id === ''
          || typeof value.name !== 'string' || value.name === '') throw new TypeError('atif_assistant_tool_call_invalid');
        if (callOwner.has(value.id)) throw new TypeError('atif_tool_call_id_duplicate');
        callOwner.set(value.id, Number(event.seq));
        const extra: JsonObject = {};
        if (!includeSensitiveContent) extra.ligule = { arguments_redacted: true };
        if (value.name === 'subagent') {
          extra.ligule = { ...(isObject(extra.ligule) ? extra.ligule : {}), subagent_trajectory_missing: true };
          missing.push('subagent_trajectory');
        }
        toolCalls.push({
          tool_call_id: value.id,
          function_name: value.name,
          arguments: safeCallArguments(value.args, includeSensitiveContent),
          ...(Object.keys(extra).length > 0 ? { extra } : {}),
        });
      }

      const metrics = turnEvents.filter((item) => item.kind === 'usage'
        && Number(item.seq) > previousAssistantSeq && Number(item.seq) < Number(event.seq))
        .map(metricsFor).filter((item): item is NonNullable<typeof item> => item !== undefined).at(-1);
      const assistant: AtifStep = {
        step_id: ++stepId,
        source: 'agent',
        ...(source.modelName === undefined ? {} : { model_name: source.modelName }),
        message: includeSensitiveContent ? optionalText(event.text) ?? '' : REDACTED,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        ...(metrics === undefined ? {} : { metrics }),
        ...(!includeSensitiveContent ? { extra: { ligule: { content_redacted: true } } } : {}),
      };
      steps.push(assistant);
      for (const call of calls) {
        if (isObject(call) && typeof call.id === 'string') assistantSteps.set(call.id, assistant);
      }
      previousAssistantSeq = Number(event.seq);
      continue;
    }

    if (event.kind === 'tool') {
      if (typeof event.callId !== 'string' || !callOwner.has(event.callId)) throw new TypeError('atif_tool_result_without_call');
      if (resultEvents.has(event.callId)) throw new TypeError('atif_tool_result_duplicate');
      const owner = callOwner.get(event.callId)!;
      if (owner < previousAssistantSeq) throw new TypeError('atif_tool_result_order_invalid');
      resultEvents.set(event.callId, event);
      continue;
    }

    if (event.kind === 'compaction') {
      const fields = ['reason', 'blockId', 'fromSeq', 'toSeq', 'tokensBefore', 'tokensAfter'] as const;
      const compaction = Object.fromEntries(fields.filter((key) => event[key] !== undefined).map((key) => [key, event[key]]));
      steps.push({
        step_id: ++stepId,
        source: 'system',
        message: 'Context compaction recorded; summary content is unavailable.',
        extra: { context_management: { type: 'compaction' }, ligule: { compaction } },
      });
      continue;
    }
    if (event.kind === 'image') {
      missing.push('images');
      continue;
    }
    if (event.kind === 'reasoning' || event.kind === 'turn') continue;
  }

  for (const [callId] of callOwner) {
    const result = resultEvents.get(callId);
    if (result === undefined || result.kind !== 'tool') throw new TypeError('atif_tool_result_missing');
    const assistantStep = assistantSteps.get(callId);
    if (assistantStep === undefined) throw new TypeError('atif_tool_call_owner_missing');
    const toolEvent = result;
    const resultData = isObject(toolEvent.result) ? toolEvent.result : {};
    const knownSuccess = resultData.kind === 'result' && resultData.failed === false;
    const knownFailure = resultData.failed === true || resultData.kind === 'failure' || resultData.kind === 'refusal';
    const failed = !knownSuccess || knownFailure;
    const code = optionalText(resultData.code);
    const extra: JsonObject = {
      ligule: {
        outcome: code === 'tool_outcome_unknown' ? 'unknown' : knownFailure ? 'failed' : knownSuccess ? 'completed' : 'unknown',
        ...(resultData.kind === undefined ? {} : { result_kind: resultData.kind }),
        ...(failed ? { failed: true } : {}),
        ...(code === undefined ? {} : { error_code: code }),
        ...(resultData.reason !== undefined && includeSensitiveContent ? { reason: resultData.reason } : {}),
        ...(toolEvent.tool === 'subagent' ? { subagent_trajectory_missing: true } : {}),
      },
    };
    const rawContent = printable(resultData.content);
    const spillReference = typeof resultData.content === 'string'
      && /\[omitted: full output is \d+ bytes, kept in result-\d+-[a-f0-9]{8}\.json\]/u.test(resultData.content);
    if (spillReference) missing.push('spill_content');
    const output = includeSensitiveContent ? rawContent : rawContent === undefined ? undefined : REDACTED;
    const observationResult: AtifObservationResult = {
      source_call_id: callId,
      ...(output === undefined ? {} : { content: output }),
      extra,
    };
    if (spillReference) {
      observationResult.extra.ligule = { ...(observationResult.extra.ligule as JsonObject), output_truncated: true, spill_content_missing: true };
    }
    if (!includeSensitiveContent && (rawContent !== undefined || hasAbsolutePath(resultData))) {
      observationResult.extra.ligule = { ...(observationResult.extra.ligule as JsonObject), content_redacted: true };
    }
    if (Array.isArray(resultData.images) || resultData.kind === 'image_result') {
      observationResult.extra.ligule = { ...(observationResult.extra.ligule as JsonObject), images_missing: true };
      missing.push('images');
    }
    assistantStep.observation ??= { results: [] };
    assistantStep.observation.results.push(observationResult);
  }

  for (const event of terminalEvents) {
    const status = optionalText(event.status);
    if (status === undefined) throw new TypeError('atif_turn_status_missing');
    steps.push({
      step_id: ++stepId,
      source: 'system',
      ...(typeof event.at === 'string' && Number.isFinite(Date.parse(event.at)) ? { timestamp: event.at } : {}),
      message: `Run ${status}.`,
      extra: { ligule: {
        turn_status: status,
        ...(optionalText(event.code) === undefined ? {} : { error_code: event.code }),
      } },
    });
  }

  if (steps.length === 0) throw new TypeError('atif_trajectory_has_no_steps');
  const trajectory: AtifTrajectory = {
    schema_version: 'ATIF-v1.8',
    ...(runId === undefined ? {} : { session_id: runId }),
    trajectory_id: `${source.sessionId}:${source.userSeq}`,
    agent: {
      name: source.agentName,
      version: source.agentVersion,
      ...(source.modelName === undefined ? {} : { model_name: source.modelName }),
    },
    steps,
    extra: {
      ligule: {
        session_id: source.sessionId,
        user_seq: source.userSeq,
        ...(runId === undefined ? { run_id_unknown: true } : {}),
        ...(missing.length === 0 ? {} : { missing_features: [...new Set(missing)] }),
      },
    },
  };
  return trajectory;
}
