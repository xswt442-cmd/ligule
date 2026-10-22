import { applyModeToPrompt, type ModeFile } from '../kernel/modes.js';
import type { Kernel } from '../kernel/kernel.js';
import type { PromptAssembly } from '../kernel/prompt.js';
import type { SessionLog } from '../session/session.js';

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
  // 在旧模式仍生效时安装新限制；新模式被拒绝时不能短暂开放全部工具。
  const applied = applyModeToPrompt({ file, kernel, prompt, fragments, maxBytes: promptFragmentBytes });
  mode.undo();
  Object.assign(mode, {
    file,
    tools: applied.tools,
    undo: applied.undo,
  });
  // 重新应用相同模式时不修改会话记录；最后一条模式事件是持久选择事实。
  const last = (await session.read()).filter((event) => event.kind === 'mode').at(-1);
  const lastTools = Array.isArray(last?.tools) && last.tools.every((tool): tool is string => typeof tool === 'string')
    ? last.tools
    : undefined;
  if (last === undefined || last.name !== file.name || last.layer !== file.layer || lastTools?.join(' ') !== applied.tools.join(' ') || last.digest !== file.digest) {
    await session.append({ kind: 'mode', name: file.name, layer: file.layer, path: file.path, tools: applied.tools, digest: file.digest });
  }
}
