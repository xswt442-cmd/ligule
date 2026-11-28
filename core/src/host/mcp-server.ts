import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv } from 'ajv';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { KernelError } from '../kernel/error.js';
import type { DelegationSpec } from '../delegation.js';
import { createPermissionContext } from '../kernel/permission.js';
import { isTrusted } from '../kernel/workspace-trust.js';
import { createHost } from './host.js';
import { delegationPathOf, recordDelegationEvent, requireDelegationGrant } from './agent-control.js';
import { loadHostEnvironment } from './environment.js';
import { createControl, controlErrorCode, type McpInitialSettings, type McpSessionChanges } from './control.js';
import { createInteractivePermissionContext } from '../capability/permission-capabilities.js';
import { tools } from './mcp-schemas.js';

interface Arguments {
  projectRoot?: string;
  sessionId?: string;
  operationId?: string;
  timeoutMs?: number;
  delegation?: DelegationSpec;
  requestKey?: string;
  runId?: string;
  executionId?: string;
  callId?: string;
  waitMs?: number;
  cursor?: string;
  limitBytes?: number;
  parentRunId?: string;
  subrunId?: string;
  subrunIds?: string[];
  presetId?: string;
  mode?: unknown;
  outputTokens?: number;
  thinkingEffort?: string;
  loopIterations?: number;
  modelCalls?: number;
  outputSchema?: Record<string, unknown>;
  task?: string;
  input?: string;
  initial?: McpInitialSettings;
  changes?: McpSessionChanges;
  requestId?: string;
  type?: 'approval' | 'question';
  decision?: 'allow' | 'deny';
  answers?: { id: string; selected: string[]; custom?: string }[];
  action?: 'send' | 'continue' | 'cancel_queued' | 'clear_queue';
  queueItemId?: string;
  limit?: number;
  before?: number;
  at?: number;
  offset?: number;
  after?: number;
}

export async function serveMcp({ projectRoot, version, flags = [], modeName, operator = false, grantId }: {
  projectRoot: string; version: string; flags?: string[]; modeName?: string; operator?: boolean; grantId?: string;
}): Promise<void> {
  if (!isAbsolute(projectRoot)) throw new KernelError('control_project_required');
  let authorizedRoot: string;
  try {
    authorizedRoot = await realpath(projectRoot);
    if (!(await stat(authorizedRoot)).isDirectory()) throw new KernelError('control_project_required');
  } catch { throw new KernelError('control_project_required'); }
  if (!(await isTrusted(authorizedRoot))) throw new KernelError('control_project_untrusted');
  const grantStorePath = delegationPathOf();
  const grant = grantId === undefined ? undefined : await requireDelegationGrant(grantStorePath, grantId, authorizedRoot);
  if (grant !== undefined && operator && !grant.allowOperator) throw new KernelError('agent_control_operator_not_allowed');
  const operatorEnabled = operator && (grant === undefined || grant.allowOperator);
  const shippedModes = fileURLToPath(new URL('../../modes/', import.meta.url));
  const { layers, ...environment } = await loadHostEnvironment(authorizedRoot, shippedModes, flags);
  const capabilities = await createInteractivePermissionContext({ shellConfig: environment.config, workspaceRoot: authorizedRoot });
  const permission = grant === undefined ? capabilities
    : createPermissionContext(grant.defaultPermissionProfile, grant.defaultNetwork, capabilities.capabilities, {
        profiles: capabilities.profiles,
        limitations: capabilities.limitations,
        partialWorkspaceWriteConfirmationRequired: capabilities.partialWorkspaceWriteConfirmationRequired,
        partialWorkspaceWriteConfirmed: grant.confirmedPartialWorkspaceWrite,
      });
  const agentControl = grant === undefined ? undefined : {
    grantId: grant.id,
    storePath: grantStorePath,
    operator: operatorEnabled,
    validate: () => requireDelegationGrant(grantStorePath, grant.id, authorizedRoot),
  };
  const host = createHost({ ...environment,
    configLayers: layers,
    loadEnvironment: async (project) => {
      const { layers: freshLayers, ...fresh } = await loadHostEnvironment(project, shippedModes, flags);
      return { ...fresh, layers: freshLayers };
    },
    permission,
    ...(modeName === undefined ? {} : { modeName }),
    interactive: true,
    ...(agentControl === undefined ? {} : { agentControl }),
  });
  if (grant !== undefined) await recordDelegationEvent(grantStorePath, { kind: 'grant.used', grantId: grant.id });
  const server = new Server({ name: 'ligule', version }, {
    capabilities: { tools: {}, logging: {} },
    instructions: grant === undefined
      ? operatorEnabled
        ? 'One local stdio operator for the explicitly authorized project. This server was launched with --operator, so session-only settings and replies to real pending approvals/questions are available. Policy decisions still run in Host; hard denials cannot be overridden. Use ligule_run to delegate and wait in one call, or run_start/await/status/cancel for separate control. Use ligule_subrun_* to control child Runs under an active parent. Idle sessions can be explicitly closed after queued messages are cleared. Notifications are best-effort. Disconnect cancels active runs and releases locks. Operation IDs and queued messages are process-local; Session JSONL persists.'
        : 'One local stdio controller for the explicitly authorized project. Session creation/open/close/list, run, run_start/await/status/cancel, child subrun controls, session configuration reads, message sending and record paging are available. Ordinary approvals and questions wait for the local Desktop/TUI user; MCP replies and settings changes require the explicit --operator flag. Idle sessions can be explicitly closed after queued messages are cleared. Disconnect cancels active runs and releases locks. Operation IDs and queued messages are process-local; Session JSONL persists.'
      : `One local stdio controller for project ${grant.projectRoot}, bounded by grant ${grant.id} (${grant.maxPermissionProfile}, network up to ${grant.maxNetwork}, policies: ${grant.allowedPolicies.join(', ')}). The grant is not remote identity authentication and does not override OS sandbox limits or hard Policy denials.${operatorEnabled ? ' --operator also allows ordinary approved interactions.' : ' Ordinary approvals and questions wait for the local Desktop/TUI user; MCP replies and settings changes are disabled.'} Idle sessions can be explicitly closed after queued messages are cleared. Use ligule_run to delegate and ligule_subrun_* to control children under an active parent. Disconnect cancels active runs and releases locks.`,
  });
  const control = createControl(host, authorizedRoot, {
    operator: operatorEnabled,
    onEvent(event) {
      void server.sendLoggingMessage({ level: 'info', logger: 'ligule', data: event })
        .catch(() => { process.stderr.write('mcp_notification_delivery_failed\n'); });
    },
  });
  let grantWatch: NodeJS.Timeout | undefined;
  if (agentControl !== undefined) {
    const checkGrant = () => {
      grantWatch = setTimeout(() => {
        void agentControl.validate().then(checkGrant, async (error: unknown) => {
          grantWatch = undefined;
          try { await control.invalidate(controlErrorCode(error)); }
          catch { process.stderr.write('mcp_grant_shutdown_failed\n'); }
        });
      }, 500);
      grantWatch.unref();
    };
    checkGrant();
  }
  const ajv = new Ajv({ strict: false });
  const validators = new Map(tools.map((tool) => [tool.name, ajv.compile(tool.inputSchema)]));
  const outputs = new Map(tools.map((tool) => [tool.name, ajv.compile(tool.outputSchema!)]));
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const validate = validators.get(request.params.name);
    if (validate === undefined) throw new McpError(ErrorCode.InvalidParams, 'tool_unknown');
    const args = request.params.arguments ?? {};
    if (!validate(args)) throw new McpError(ErrorCode.InvalidParams, 'tool_args_invalid');
    const input: Arguments = args;
    try {
      if (agentControl !== undefined) {
        try { await agentControl.validate(); }
        catch (error) {
          await control.invalidate(controlErrorCode(error));
          throw error;
        }
      }
      let result: Record<string, unknown>;
      switch (request.params.name) {
        case 'ligule_session_create': result = await control.create(input.projectRoot!, input.initial); break;
        case 'ligule_session_open': result = await control.open(input.projectRoot!, input.sessionId!); break;
        case 'ligule_session_close': result = await control.close(input.sessionId!); break;
        case 'ligule_session_list': result = await control.list(input.projectRoot!, input.limit ?? 20); break;
        case 'ligule_session_configure': result = await control.configure(input.sessionId!, input.changes); break;
        case 'ligule_interaction_reply': result = control.replyInteraction({
          sessionId: input.sessionId!, requestId: input.requestId!, type: input.type!,
          ...(input.decision === undefined ? {} : { decision: input.decision }),
          ...(input.answers === undefined ? {} : { answers: input.answers }),
        }); break;
        case 'ligule_session_send': result = control.send(input.sessionId!, input.action ?? 'send', input.input, input.queueItemId); break;
        case 'ligule_run_start': result = await control.submit(input.sessionId!, input.input!, input.delegation, input.requestKey); break;
        case 'ligule_run_get': result = await control.getRun(input.sessionId!, {
          ...(input.runId === undefined ? {} : { runId: input.runId }),
          ...(input.requestKey === undefined ? {} : { requestKey: input.requestKey }),
        }, input.offset); break;
        case 'ligule_run': {
          const started = await control.submit(input.sessionId!, input.input!, input.delegation, input.requestKey);
          result = { ...await control.await(started.operationId, input.timeoutMs ?? 60_000), receipt: started.receipt, reused: started.reused };
          break;
        }
        case 'ligule_run_status': result = control.status(input.operationId!, input.after ?? 0, input.limit ?? 20); break;
        case 'ligule_run_await': result = await control.await(input.operationId!, input.timeoutMs ?? 60_000); break;
        case 'ligule_run_cancel': result = await control.cancel(input.operationId!); break;
        case 'ligule_preset_list': result = await control.presetList(input.sessionId!, input.cursor, input.limit ?? 64); break;
        case 'ligule_preset_preview': result = await control.presetPreview(input.sessionId!, input.presetId!, input.parentRunId, {
          ...(input.mode === undefined ? {} : { mode: input.mode }),
          ...(input.outputTokens === undefined ? {} : { outputTokens: input.outputTokens }),
          ...(input.thinkingEffort === undefined ? {} : { thinkingEffort: input.thinkingEffort }),
          ...(input.loopIterations === undefined ? {} : { loopIterations: input.loopIterations }),
          ...(input.modelCalls === undefined ? {} : { modelCalls: input.modelCalls }),
          ...(input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema }),
        }); break;
        case 'ligule_subrun_start': result = await control.subrunStart(input.sessionId!, input.parentRunId!, input.task!, {
          ...(input.presetId === undefined ? {} : { presetId: input.presetId }),
          ...(input.mode === undefined ? {} : { mode: input.mode }),
          ...(input.outputTokens === undefined ? {} : { outputTokens: input.outputTokens }),
          ...(input.thinkingEffort === undefined ? {} : { thinkingEffort: input.thinkingEffort }),
          ...(input.loopIterations === undefined ? {} : { loopIterations: input.loopIterations }),
          ...(input.modelCalls === undefined ? {} : { modelCalls: input.modelCalls }),
          ...(input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema }),
        }); break;
        case 'ligule_subrun_list': result = await control.subrunList(input.sessionId!, input.parentRunId!, input.cursor, input.limit ?? 32); break;
        case 'ligule_subrun_status': result = await control.subrunStatus(input.sessionId!, input.parentRunId!, input.subrunId!); break;
        case 'ligule_subrun_message': result = await control.subrunMessage(input.sessionId!, input.parentRunId!, input.subrunId!, input.runId!, input.input!); break;
        case 'ligule_subrun_wait': result = await control.subrunWait(input.sessionId!, input.parentRunId!, input.subrunIds!, input.timeoutMs ?? 30_000); break;
        case 'ligule_subrun_cancel': result = await control.subrunCancel(input.sessionId!, input.parentRunId!, input.subrunId!, input.runId!); break;
        case 'ligule_execution_status': result = await control.executionStatus(input.sessionId!, input.runId!, input.executionId!); break;
        case 'ligule_execution_wait': result = await control.executionWait(input.sessionId!, input.runId!, input.executionId!, input.waitMs ?? 30_000); break;
        case 'ligule_execution_logs': result = await control.executionLogs(input.sessionId!, input.runId!, input.executionId!, input.cursor, input.limitBytes ?? 4_096); break;
        case 'ligule_execution_cancel': result = await control.executionCancel(input.sessionId!, input.runId!, input.executionId!); break;
        case 'ligule_tool_result': result = await control.toolResult(input.sessionId!, input.runId!, input.callId!, input.cursor, input.limitBytes ?? 4_096); break;
        case 'ligule_session_read': result = await control.read(input.sessionId!, input.before, input.limit ?? 20, input.at, input.offset); break;
  case 'ligule_usage_get': result = await control.usage(input.sessionId!); break;
        default: throw new KernelError('tool_unknown');
      }
      const outputValid = outputs.get(request.params.name)!(result);
      if (!outputValid) throw new KernelError('host_response_invalid');
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) {
      const result = { code: controlErrorCode(error) };
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    }
  });
  const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 1024 * 1024 });
  let shutdown: Promise<void> | undefined;
  let finish!: () => void;
  let fail!: (error: unknown) => void;
  const done = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
  function close(): void {
    if (shutdown !== undefined) return;
    shutdown = (async () => {
      try { await control.release(); }
      finally { await server.close(); }
    })();
    void shutdown.then(finish, fail);
  }
  server.onclose = close;
  server.onerror = () => { process.stderr.write('mcp_transport_error\n'); close(); };
  process.stdin.once('end', close);
  process.stdin.once('close', close);
  process.stdout.once('error', close);
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  try {
    await server.connect(transport);
    await done;
  } finally {
    close();
    await shutdown;
    process.stdin.off('end', close);
    process.stdin.off('close', close);
    process.stdout.off('error', close);
    process.off('SIGINT', close);
    process.off('SIGTERM', close);
    if (grantWatch !== undefined) clearTimeout(grantWatch);
  }
}
