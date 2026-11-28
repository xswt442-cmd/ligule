import { createConfig, type ConfigSnapshot } from '../kernel/config.js';
import { KernelError } from '../kernel/error.js';
import type { LoggerBackend } from '../kernel/log.js';
import type { PolicyReviewRecord, PolicyReviewRequest, PolicyRule } from '../kernel/policy.js';
import type { ReviewFacts } from '../kernel/reviewer.js';
import type { SessionLog } from '../session/session.js';
import type { DelegationGrant } from './agent-control.js';
import { inactiveGrantOutcome, isGrantActive, selectReviewEvidence, staleReviewOutcome } from './review-evidence.js';
import { createSessionReviewer, narrowReviewerSettings, reviewerRouteFields, reviewerSettings } from './reviewer.js';
import type { HostSessionBase, ProjectEnvironment } from './types.js';

export function trustedReviewerConfig({ config, layers }: Pick<ProjectEnvironment, 'config' | 'layers'>): ConfigSnapshot | undefined {
  const trusted = Object.keys(layers).length === 0
    ? undefined
    : createConfig({ user: layers.user ?? {}, flag: layers.flag ?? {} });
  const fields = reviewerRouteFields(trusted ?? config);
  if (fields.length > 0) {
    throw new KernelError('reviewer_route_removed', {
      detail: `the [reviewer] table still sets ${fields.join(', ')}; the reviewer always uses the session model, so remove those fields`,
    });
  }
  return trusted;
}

interface SessionReviewContext {
  readonly id: string;
  readonly projectRoot: string;
  readonly config: ConfigSnapshot;
  readonly trustedConfig?: ConfigSnapshot;
  readonly configuredRules?: PolicyRule[];
  readonly session: SessionLog;
  readonly state: Pick<HostSessionBase, 'reviewEvidence' | 'generation' | 'permission' | 'sessionPolicyRules'>;
  readonly workspaceTrusted: boolean;
  readonly logger?: Pick<LoggerBackend, 'log'>;
  readonly initialGrant?: DelegationGrant;
  refreshGrant?(): Promise<DelegationGrant | undefined>;
}

function reviewRuleOf(rule: PolicyRule, source: 'session' | 'config'): NonNullable<ReviewFacts['rules']>[number] {
  return {
    tool: rule.tool,
    decision: rule.decision,
    source,
    ...(rule.match === undefined ? {} : { match: rule.match }),
    ...(rule.target === undefined ? {} : { target: rule.target }),
    ...(rule.path === undefined ? {} : { path: rule.path }),
    ...(rule.argsHash === undefined ? {} : { argsHash: rule.argsHash }),
  };
}

export function createSessionReview({
  id, projectRoot, config, trustedConfig, configuredRules, session, state, workspaceTrusted, logger, initialGrant, refreshGrant,
}: SessionReviewContext) {
  const merged = reviewerSettings(config);
  const trusted = trustedConfig === undefined ? merged : reviewerSettings(trustedConfig);
  if (merged === undefined || trusted === undefined) return undefined;
  const settings = narrowReviewerSettings(merged, trusted);
  const ignoredRouteFields = reviewerRouteFields(config);
  if (ignoredRouteFields.length > 0) {
    try {
      logger?.log?.('reviewer ignores route fields from an untrusted configuration layer', {
        sessionId: id, fields: ignoredRouteFields.join(','),
      });
    } catch { /* 记录失败不影响会话 */ }
  }
  let liveGrant = initialGrant;
  let grantCheckFailed = false;
  const grantInactive = () => grantCheckFailed || (liveGrant !== undefined && !isGrantActive(liveGrant));
  async function refresh() {
    if (refreshGrant === undefined) return;
    try {
      liveGrant = await refreshGrant();
      grantCheckFailed = false;
    } catch {
      grantCheckFailed = true;
    }
  }
  const reviewer = createSessionReviewer({
    settings,
    provider: () => state.generation.provider.withGeneration({ outputTokensCeiling: settings.maxOutputTokens }),
    factsOf: (request): ReviewFacts => ({
      tool: request.tool,
      args: request.input,
      ...(request.command === undefined ? {} : { command: request.command }),
      policyMode: request.policy,
      permission: { profile: state.permission.profile, network: state.permission.network },
      boundary: projectRoot,
      workingDirectory: projectRoot,
      workspaceTrusted,
      ...(request.reason === undefined ? {} : { reason: request.reason }),
      userInstructions: (state.reviewEvidence?.constraints ?? []).filter(item => item.source === 'user').map(item => item.text),
      ...(state.reviewEvidence === undefined ? {} : { evidence: state.reviewEvidence }),
      rules: [
        ...state.sessionPolicyRules.map(rule => reviewRuleOf(rule, 'session')),
        ...(configuredRules ?? []).map(rule => reviewRuleOf(rule, 'config')),
      ],
      ...(liveGrant === undefined ? {} : {
        grant: {
          id: liveGrant.id, active: !grantInactive(), scope: liveGrant.projectRoot,
          ...(liveGrant.allowedPolicies === undefined ? {} : { allowedPolicies: liveGrant.allowedPolicies }),
        },
      }),
    }),
    logger(message, detail) {
      try { logger?.log?.(message, { ...detail, sessionId: id }); } catch { /* 记录失败不影响审批结果 */ }
    },
    onUsage(event) {
      if (event === null) return;
      void session.append(event).catch((error: unknown) => {
        try { logger?.log?.('failed to record reviewer usage', { sessionId: id, session_error: String(error) }); } catch { /* 忽略 */ }
      });
    },
  });

  async function recordReview(request: PolicyReviewRequest): Promise<PolicyReviewRecord> {
    const startedAt = Date.now();
    await refresh();
    const evidence = await selectReviewEvidence(session, { tool: request.tool });
    const appendAudit = async (record: PolicyReviewRecord): Promise<void> => {
      try {
        await session.append({
          kind: 'policyReview', ignorable: true, at: new Date().toISOString(), tool: request.tool, review: record.decision,
          ...(record.reasonCode === undefined ? {} : { reasonCode: record.reasonCode }),
          make: 'session-reviewer', durationMs: Date.now() - startedAt,
          ...(record.includedSeqs === undefined || record.includedSeqs.length === 0 ? {} : { evidenceSeqs: [...record.includedSeqs] }),
          ...(record.reason === undefined ? {} : { reason: record.reason }),
        });
      } catch (error) {
        logger?.log?.('failed to record the review decision', { sessionId: id, session_error: String(error) });
      }
    };
    state.reviewEvidence = evidence;
    let outcome: PolicyReviewRecord;
    if (evidence === undefined) outcome = staleReviewOutcome();
    else if (grantInactive()) outcome = inactiveGrantOutcome();
    else {
      outcome = await reviewer.review(request);
      await refresh();
      if (outcome.decision === 'allow' && grantInactive()) outcome = inactiveGrantOutcome();
    }
    await appendAudit(outcome);
    return outcome;
  }
  return { reviewer, recordReview };
}
