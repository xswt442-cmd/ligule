import { applyMode, type ModeFile } from '../kernel/modes.js';
import type { Kernel } from '../kernel/kernel.js';
import type { PromptAssembly } from '../kernel/prompt.js';
import type { SessionLog } from '../session/session.js';
import { KernelError } from '../kernel/error.js';

export interface SessionModeState {
  file: ModeFile | undefined;
  tools: string[];
  undo(): void;
}

export interface SessionPromptFragment {
  readonly name: string;
  readonly text: string;
}

export async function adoptSessionMode({
  file,
  kernel,
  prompt,
  fragments,
  promptFragmentBytes,
  session,
  mode,
}: {
  readonly file: ModeFile;
  readonly kernel: Kernel;
  readonly prompt: PromptAssembly;
  readonly fragments: readonly SessionPromptFragment[];
  readonly promptFragmentBytes: number;
  readonly session: SessionLog;
  readonly mode: SessionModeState;
}): Promise<void> {
  const selected = file.prompt === '*'
    ? [...fragments]
    : file.prompt.map((name) => {
        const found = fragments.find((entry) => entry.name === name);
        if (found === undefined) {
          throw new KernelError('mode_prompt_unavailable', {
            detail: `${name} (mode ${file.name}; registered: ${fragments.map((entry) => entry.name).join(', ') || 'none'})`,
          });
        }
        return found;
      });
  // Install the new restriction while the old one is active; a rejected mode must not expose the full tool set.
  const applied = applyMode(kernel, file);
  const fragmentUndo: (() => void)[] = [];
  try {
    selected.forEach((fragment, index) => {
      fragmentUndo.push(prompt.fragment({
        name: `extension:${fragment.name}`,
        anchor: 2 + index,
        text: fragment.text,
        maxBytes: promptFragmentBytes,
      }));
    });
  } catch (error) {
    for (const remove of fragmentUndo.reverse()) remove();
    applied.undo();
    throw error;
  }
  mode.undo();
  const tools = kernel.manifest().map((entry) => entry.name);
  Object.assign(mode, {
    file,
    tools,
    undo: () => {
      for (const remove of fragmentUndo.slice().reverse()) remove();
      applied.undo();
    },
  });
  // Reattaching an unchanged mode must not alter the session log; its last record is the durable selection fact.
  const last = (await session.read()).filter((event) => event.kind === 'mode').at(-1);
  const lastTools = Array.isArray(last?.tools) && last.tools.every((tool): tool is string => typeof tool === 'string')
    ? last.tools
    : undefined;
  if (last === undefined || last.name !== file.name || last.layer !== file.layer || lastTools?.join(' ') !== tools.join(' ') || last.digest !== file.digest) {
    await session.append({ kind: 'mode', name: file.name, layer: file.layer, path: file.path, tools, digest: file.digest });
  }
}
