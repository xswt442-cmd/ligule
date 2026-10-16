// 终端界面的启动（D33）：Host 与界面在同一个进程里，两端换成内存载体（src/host/memory.ts）。
// 界面读的是与桌面壳同一份协议：session.create、run.start、两条通报，以及 Host 反过来的那一次审批请求。
// ink 与 react 是可选依赖，缺了它们这一条命令报 tui_dependency_missing，命令行其余部分照旧能跑。
import { createElement } from 'react';
import { render, type RenderOptions } from 'ink';
import { createConnection } from '@ligule/core/host/connection.js';
import { createMemoryConnectionPair } from '@ligule/core/host/memory.js';
import { serveHost } from '@ligule/core/host/host.js';
import { App } from './app.js';
import type { TuiClient } from './app.js';
import type { Locale } from '@ligule/core/kernel/locale.js';
import { flushHistory, historyPathOf, loadHistory, pushHistory, rememberHistory } from '@ligule/core/kernel/input-history.js';
import { flushInput, inputPathOf, readInput, rememberInput } from './input-store.js';
import { flushKeys, keyPathOf, readKeys, writeKeys } from './key-store.js';
import { titleEscape } from './output.js';
import { setTrusted } from './trust-store.js';
import { modeOptions } from './mode-options.js';

type ServeOptions = Parameters<typeof serveHost>[0];

export interface RunTuiOptions extends Omit<ServeOptions, 'input' | 'output' | 'interactive'> {
  readonly locale?: Locale;
  readonly stdout?: RenderOptions['stdout'];
  readonly stdin?: RenderOptions['stdin'];
  readonly stderr?: RenderOptions['stderr'];
  readonly editor?: string;
  readonly historyFile?: string;
  readonly inputFile?: string;
  readonly keyFile?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function runTui({ config, provider, policy, logger, modeName, modePaths, extensions, locale = 'zh', stdout = process.stdout, stdin = process.stdin, stderr = process.stderr, editor = process.env.VISUAL || process.env.EDITOR, historyFile = historyPathOf(), inputFile = inputPathOf(), keyFile = keyPathOf() }: RunTuiOptions): Promise<void> {
  const pair = createMemoryConnectionPair();
  // 终端界面答得了提问：这一路进来的时候 stdin 与 stdout 都已经是真终端（裸 `ligule` 和 `ligule tui` 都会先检查）。
  const host = serveHost({ input: pair.host.input, output: pair.host.output, config, provider, policy, logger, modeName, modePaths, extensions, interactive: true });
  // 内存连接与本函数创建的 Host 成对；TuiClient 声明这些 Host 方法在本进程内返回的具体结构。
  const client = createConnection(pair.client) as TuiClient;
  try {
    const created = await client.request('session.create', {});
    if (!isRecord(created) || typeof created.sessionId !== 'string') throw new Error('tui_session_create_invalid');
    const { sessionId } = created;
    // 输入历史读一次就交进界面：往后的读与翻都看界面自己那一份，写这一份文件也只由界面发起。
    const history = {
      entries: await loadHistory(historyFile),
      // 只把这一句交出去，基准由写的那一遍在锁内读：留着进程里那份旧快照整份写回，会把另一端刚落下的一句挤到后面。
      // 交回写成之后的那一份清单，界面采用它——屏幕上的历史与文件里的那一份才是同一份。
      remember: (text: string) => rememberHistory(historyFile, [text]),
    };
    const instance = render(
      createElement(App, {
        client,
        sessionId,
        locale,
        // 编辑器那一个命令名由启动这一侧读环境变量，界面自己不碰进程。
        info: {
          model: typeof config.model?.model === 'string' ? config.model.model : undefined,
          boundary: typeof config.workspaceRoot === 'string' ? config.workspaceRoot : typeof config.boundary === 'string' ? config.boundary : undefined,
          editor,
        },
        history,
        // 草稿与排着的那几句归本机这一份文件：读写都由启动这一侧接出去，界面不认识路径（与历史同一层做法）。
        inputs: {
          read: (projectRoot: string, own: string) => readInput(inputFile, projectRoot, own),
          write: (projectRoot: string, own: string, draft: string, queued: readonly string[]) => rememberInput(inputFile, { projectRoot, sessionId: own, draft, queued: [...queued] }),
        },
        interactive: Boolean(stdin.isTTY && stdout.isTTY),
        // 个人键位存在本机另一份文件里：读与写同样由启动这一侧接出去，界面不认识路径（方案 6.1）。
        keys: { read: () => readKeys(keyFile), write: (overrides: Parameters<typeof writeKeys>[1]) => writeKeys(keyFile, overrides) },
        trust: { revoke: () => setTrusted(String(config.workspaceRoot ?? config.boundary), false) },
        modes: modePaths === undefined ? undefined : { read: () => modeOptions(modePaths) },
        // 状态行按宽度取舍要看终端列数（D40），界面自己不读进程。
        stdout,
      }),
      // CI 默认让 Ink 关闭交互渲染；真正的终端和测试模拟 TTY 都必须显式开启。
      { stdout, stdin, stderr, exitOnCtrlC: false, interactive: Boolean(stdin.isTTY && stdout.isTTY) },
    );
    await instance.waitUntilExit();
  } finally {
    // 退出之前把终端标题交回去：进程已经不在了，那一格还写着 `ligule · 模型 … · 会话 …` 会让那个标签页说一件不成立的事。
    // 写不进就不写（管道对面先关掉时这里会抛），别让这一格把后面的收尾与放锁挡住。
    try {
      stdout.write(titleEscape(''));
    } catch { /* 标准输出已经不接了 */ }
    try {
      await Promise.all([flushHistory(historyFile), flushInput(inputFile), flushKeys()]);
    } finally {
      // 界面退出之后关掉客户端这一侧：Host 读到末尾就把还在跑的轮次取消、按装配清单的逆序撤插件（D30）。
      pair.client.output.end();
      await host.release();
    }
  }
}
