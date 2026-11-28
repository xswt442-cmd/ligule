import type { LoopCompaction, LoopProgressEvent } from '../kernel/loop.js';
import { resolveModel } from '../kernel/model-services.js';
import { createCompaction } from '../session/compaction.js';
import type { SessionLog } from '../session/session.js';
import { usageEvent } from '../session/usage.js';
import type { HostProvider } from './provider.js';
import { compactionLimitsOf } from './runtime-limits.js';
import type { HostSessionBase } from './types.js';

type CompactionContext = Pick<Parameters<typeof createCompaction>[0], 'directory' | 'id' | 'logger' | 'requestPrefix'> & {
  readonly config: Parameters<typeof compactionLimitsOf>[0];
  readonly provider: HostProvider;
  readonly session: SessionLog;
  readonly state: Pick<HostSessionBase, 'compaction' | 'generation'>;
  reportProgress(event: LoopProgressEvent): void;
};

function progressProvider(provider: HostProvider, onProgress: (event: LoopProgressEvent) => void): HostProvider {
  return {
    get name() { return provider.name; },
    get model() { return provider.model; },
    get pending() { return provider.pending; },
    get capabilities() { return provider.capabilities; },
    get requiresCompletion() { return provider.requiresCompletion; },
    get outputTokens() { return provider.outputTokens; },
    get contextTokens() { return provider.contextTokens; },
    get thinkingCapability() { return provider.thinkingCapability; },
    get thinkingEffort() { return provider.thinkingEffort; },
    withModel(model) { return progressProvider(provider.withModel(model), onProgress); },
    withGeneration(options) { return progressProvider(provider.withGeneration(options), onProgress); },
    async *stream(request, options) {
      onProgress({ kind: 'phase', phase: 'compaction', modelCalls: 0, toolCalls: 0 });
      for await (const event of provider.stream(request, options)) {
        if (event.type === 'text' || event.type === 'reasoning' || event.type === 'tool-call') {
          onProgress({ kind: 'activity', phase: 'compaction', activity: 'model_output', modelCalls: 0, toolCalls: 0 });
        }
        yield event;
      }
    },
  };
}

export function createSessionCompaction({ config, provider, state, session, reportProgress, ...options }: CompactionContext) {
  function rebuild(model: Record<string, unknown>) {
    const selectedModel = resolveModel(model);
    const outputTokens = state.generation.options.outputTokens ?? selectedModel.outputTokens;
    const limits = compactionLimitsOf(config, selectedModel.serviceContextTokens, outputTokens);
    return limits === undefined ? null : createCompaction({
      ...options, provider: progressProvider(provider, reportProgress), session, limits,
    });
  }
  const loop: LoopCompaction = {
    prepare: (request, signal, collectDiagnostics) => state.compaction?.prepare(request, signal, collectDiagnostics) ?? Promise.resolve(request.messages),
    recover: (error, request, signal, collectDiagnostics) => state.compaction?.recover(error, request, signal, collectDiagnostics) ?? Promise.resolve(null),
    observe: async (request, events) => {
      const current = state.compaction;
      if (current !== undefined && current !== null) await current.observe(request, events);
      else {
        const usage = usageEvent(request, events, 'agent', { unknownWhenUnreported: true });
        if (usage !== null) await session.append(usage);
      }
    },
    diagnostics: () => state.compaction?.diagnostics(),
    seedDiagnostics: (diagnostics) => state.compaction?.seedDiagnostics(diagnostics),
    resetDiagnostics: () => state.compaction?.resetDiagnostics(),
  };
  return { rebuild, loop };
}
