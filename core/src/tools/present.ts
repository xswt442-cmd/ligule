import { KernelError } from '../kernel/error.js';
import type { ToolContext, ToolDefinition } from '../kernel/kernel.js';
import type { FileArtifact } from '../artifact.js';
import { boundaryOf, workingDirectoryOf } from '../capability/limits.js';
import { readFileArtifacts, type PresentFile } from '../capability/artifact.js';
import { currentKernelExecutionContext } from '../kernel/execution-context.js';

interface PresentArguments { readonly files: readonly PresentFile[] }
export interface ViewRequestArguments {
  readonly kind: 'file' | 'directory' | 'diff' | 'command' | 'subrun';
  readonly path?: string;
  readonly executionId?: string;
  readonly subrunId?: string;
}
interface PresentDependencies {
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly session: { append(event: Record<string, unknown>): Promise<unknown> };
  readonly requestView?: (args: ViewRequestArguments, context: ToolContext) => Promise<ViewRequestResult>;
}

export interface ViewRequestResult {
  readonly status: 'sent' | 'view_unavailable';
  readonly opened: false;
  readonly read: false;
}

export interface PresentResult {
  readonly text: string;
  readonly artifacts: readonly FileArtifact[];
}

export function createPresentPlugin(dependencies?: PresentDependencies) {
  return {
    name: 'ligule-present',
    setup(kernel: { register(tool: unknown): () => void }) {
      const unregisterPresent = kernel.register({
        name: 'present', access: 'read', readOnly: true, execution: 'serial',
        description: 'Present one or more workspace files to the user. Records metadata and a SHA-256 digest for the current disk snapshot; later changes or deletion are not reflected, and no persistent file copy is stored.',
        parameters: {
          type: 'object', additionalProperties: false,
          properties: {
            files: {
              type: 'array', minItems: 1, maxItems: 16,
              items: {
                type: 'object', additionalProperties: false,
                properties: {
                  path: { type: 'string', minLength: 1, maxLength: 2048, description: 'Workspace relative file path.' },
                  description: { type: 'string', maxLength: 400, description: 'Optional description for the user.' },
                },
                required: ['path'],
              },
            },
          },
          required: ['files'],
        },
        async run(args: PresentArguments, { config, signal }: Pick<ToolContext, 'config' | 'signal'>): Promise<PresentResult> {
          if (dependencies === undefined) throw new KernelError('artifact_context_required');
          const { sessionId, workspaceRoot, session } = dependencies;
          signal?.throwIfAborted();
          const configuredRoot = workingDirectoryOf(config);
          if (configuredRoot !== workspaceRoot) throw new KernelError('artifact_workspace_changed');
          const artifacts = await readFileArtifacts(args.files, sessionId, workspaceRoot, boundaryOf(config), signal);
          signal?.throwIfAborted();
          await session.append({ kind: 'artifact', ignorable: true, artifacts });
          return {
            text: `${artifacts.map((artifact) => `${artifact.path} (${artifact.mimeType}, ${artifact.bytes} bytes, SHA-256 ${artifact.sha256})${artifact.description === undefined ? '' : ` — ${artifact.description}`}`).join('\n')}\nMetadata describes the disk snapshot at presentation time; later changes or deletion are not reflected. No persistent file copy was stored.`,
            artifacts,
          };
        },
      } satisfies ToolDefinition<PresentArguments>);
      const unregisterView = kernel.register({
        name: 'open_resource', access: 'read', readOnly: true, execution: 'serial',
        description: 'Ask the connected Desktop to show a file, directory, Git diff, command, or direct subtask reference already permitted in this Session. The request never grants read or execution access; the result reports delivery only, not that the user opened or read it.',
        parameters: {
          type: 'object', additionalProperties: false,
          properties: {
            kind: { type: 'string', enum: ['file', 'directory', 'diff', 'command', 'subrun'] },
            path: { type: 'string', minLength: 1, maxLength: 4096 },
            executionId: { type: 'string', minLength: 1, maxLength: 160 },
            subrunId: { type: 'string', minLength: 1, maxLength: 160 },
          },
          required: ['kind'],
        },
        async run(args: ViewRequestArguments, context: ToolContext): Promise<ViewRequestResult> {
          const execution = currentKernelExecutionContext();
          if (dependencies?.requestView === undefined || execution?.source !== 'human'
            || execution.sessionId !== dependencies.sessionId || context.sessionId !== dependencies.sessionId) {
            return { status: 'view_unavailable', opened: false, read: false };
          }
          return await dependencies.requestView(args, context);
        },
      } satisfies ToolDefinition<ViewRequestArguments>);
      return () => {
        unregisterView();
        unregisterPresent();
      };
    },
  };
}
