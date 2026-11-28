import { createConfig, type ConfigSnapshot } from '../../kernel/config.js';
import { KernelError } from '../../kernel/error.js';
import { modelSelection, modelServices, resolveModel } from '../../kernel/model-services.js';
import { readPersistedPolicyMode } from '../../kernel/policy.js';
import { isRecord } from '../../shared/guards.js';
import { requiredString, type HostMethodParams } from '../protocol.js';
import { hostProviderFromConfig, modelSelectionOf, type HostGenerationOptions, type HostProvider } from '../provider.js';
import type { AdoptionResult, ProjectEnvironment, SessionGeneration } from '../types.js';

type ConfigEnvironment = Pick<ProjectEnvironment, 'config' | 'store'>;

interface ConfigWriteContext<Environment extends ConfigEnvironment> {
  readonly defaultStore: ConfigEnvironment['store'];
  environmentFor(projectRoot: unknown): Promise<Environment>;
  environments(): Iterable<Environment>;
  sessionsIn(environment: Environment): Iterable<Pick<SessionGeneration, 'explicit' | 'model' | 'options'>>;
  deriveProvider(config: ConfigSnapshot, generation?: HostGenerationOptions): HostProvider;
  adoptWritten(environment: Environment, layer: string, table: string, key: string, effective: unknown, changed: boolean): Promise<AdoptionResult>;
}

function shownText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function shownConfigOf(config: ConfigSnapshot) {
  const model = isRecord(config.model) ? config.model : {};
  let endpoint = shownText(model.baseURL);
  if (endpoint !== undefined) {
    try {
      const url = new URL(endpoint);
      endpoint = `${url.protocol}//${url.host}${url.pathname}`;
    } catch {
      endpoint = undefined;
    }
  }
  return {
    model: {
      api: shownText(model.api),
      baseURL: endpoint,
      model: shownText(model.model),
      apiKeyEnv: shownText(model.apiKeyEnv),
    },
  };
}

export async function readConfig({ config, store }: ConfigEnvironment) {
  if (store === undefined) return {
    ...shownConfigOf(config),
    services: modelServices(config.model?.services),
    selection: config.model?.selection === undefined ? null : modelSelection(config.model.selection),
    layers: [], sources: {},
  };
  const { layers, sources, values, rules, ruleSources, ruleLayers, rulesSource } = await store.read();
  return {
    ...shownConfigOf(values),
    services: modelServices(values.model?.services),
    selection: values.model?.selection === undefined ? null : modelSelection(values.model.selection),
    policyMode: values.policy.mode === undefined
      ? undefined
      : readPersistedPolicyMode(values.policy.mode, values.policy.semantics),
    layers,
    sources,
    rules,
    ruleSources,
    ruleLayers,
    rulesSource,
  };
}

export async function writeConfig<Environment extends ConfigEnvironment>(
  params: HostMethodParams, context: ConfigWriteContext<Environment>,
) {
  if (context.defaultStore === undefined) throw new KernelError('config_write_unsupported');
  const { value, op, index, ruleTool, ruleDecision, ruleMatch, ruleReason, ruleTarget, rulePath, ruleArgsHash,
    serverName, serverCommand, serverArgs, serverEnv, serverCwd } = params;
  const field = requiredString(params.field, 'field');
  const layer = requiredString(params.layer, 'layer');
  const version = requiredString(params.version, 'version');
  const given = {
    tool: ruleTool, decision: ruleDecision, match: ruleMatch, reason: ruleReason,
    target: ruleTarget, path: rulePath, argsHash: ruleArgsHash,
  };
  const rule = Object.values(given).every((item) => item === undefined) ? undefined : given;
  const serverGiven = { name: serverName, command: serverCommand, args: serverArgs, env: serverEnv, cwd: serverCwd };
  const server = Object.values(serverGiven).every((item) => item === undefined) ? undefined : serverGiven;
  const env = await context.environmentFor(params.projectRoot);
  if (env.store === undefined) throw new KernelError('config_write_unsupported');
  const { key, table, shadowed, shadowedBy, changed, effective, layers, ...saved } = await env.store.write({ layer, field, value, version, op, index, rule, server }, async (candidate, editedLayer) => {
    if (!field.startsWith('model.')) return;
    if (layer === 'user') hostProviderFromConfig(createConfig({ user: editedLayer }));
    for (const target of layer === 'user' ? [...context.environments()] : [env]) {
      if (target.store === undefined) continue;
      const own = target === env ? candidate : await target.store.preview(layer, editedLayer);
      const config = { ...target.config, ...own };
      hostProviderFromConfig(config);
      if (field === 'model.selection') context.deriveProvider(config);
      if (field === 'model.services' && isRecord(config.model)) {
        if (config.model.selection !== undefined) resolveModel(config.model);
        for (const service of modelServices(config.model.services)) {
          for (const setting of service.modelSettings ?? []) {
            context.deriveProvider({
              ...config,
              model: { ...config.model, selection: { provider: service.id, model: setting.id } },
            });
          }
        }
      }
      if (field !== 'model.outputTokens' && field !== 'model.services') continue;
      for (const generation of context.sessionsIn(target)) {
        if (generation.explicit !== true) continue;
        if (field === 'model.services' && modelSelectionOf(generation.model)?.provider === 'legacy') continue;
        const key = field === 'model.outputTokens' ? 'outputTokens' : 'services';
        const effective = isRecord(config.model) ? config.model[key] : undefined;
        context.deriveProvider({ ...config, model: { ...generation.model, [key]: effective } }, generation.options);
      }
    }
  });
  const adoption = await context.adoptWritten(env, layer, table, key, effective, changed);
  return {
    ...saved,
    shadowed,
    ...(shadowedBy === undefined ? {} : { shadowedBy }),
    changed,
    ...adoption,
    ...(key === 'rules' ? { rules: effective } : {}),
    layers,
  };
}
