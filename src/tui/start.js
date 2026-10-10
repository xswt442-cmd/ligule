// 终端界面的启动（D33）：Host 与界面在同一个进程里，两端换成内存载体（src/host/memory.js）。
// 界面读的是与桌面壳同一份协议：session.create、run.start、两条通报，以及 Host 反过来的那一次审批请求。
// ink 与 react 是可选依赖，缺了它们这一条命令报 tui_dependency_missing，命令行其余部分照旧能跑。
import { createElement } from 'react';
import { render } from 'ink';
import { createConnection } from '../host/connection.js';
import { createMemoryConnectionPair } from '../host/memory.js';
import { serveHost } from '../host/host.js';
import { App } from './app.js';
import { flushHistory, historyPathOf, loadHistory, pushHistory, rememberHistory } from '../kernel/input-history.js';
import { flushInput, inputPathOf, readInput, rememberInput } from './input-store.js';
import { flushKeys, keyPathOf, readKeys, writeKeys } from './key-store.js';
import { titleEscape } from './output.js';

export async function runTui({ config, provider, policy, logger, modeName, modePaths, extensions, stdout = process.stdout, stdin = process.stdin, stderr = process.stderr, editor = process.env.VISUAL || process.env.EDITOR, historyFile = historyPathOf(), inputFile = inputPathOf(), keyFile = keyPathOf() }) {
  const pair = createMemoryConnectionPair();
  // 终端界面答得了提问：这一路进来的时候 stdin 与 stdout 都已经是真终端（`ligule tui` 在没有终端时就停了）。
  const host = serveHost({ input: pair.host.input, output: pair.host.output, config, provider, policy, logger, modeName, modePaths, extensions, interactive: true });
  const client = createConnection(pair.client);
  try {
    const { sessionId } = await client.request('session.create', {});
    // 输入历史读一次就交进界面：往后的读与翻都看界面自己那一份，写这一份文件也只由界面发起。
    const entries = await loadHistory(historyFile);
    let known = entries;
    const history = {
      entries,
      remember: async (text) => {
        known = pushHistory(known, text);
        await rememberHistory(historyFile, known);
      },
    };
    const instance = render(
      createElement(App, {
        client,
        sessionId,
        // 编辑器那一个命令名由启动这一侧读环境变量，界面自己不碰进程。
        info: { model: config.model?.model, boundary: config.boundary, editor },
        history,
        // 草稿与排着的那几句归本机这一份文件：读写都由启动这一侧接出去，界面不认识路径（与历史同一层做法）。
        inputs: {
          read: (projectRoot, sessionId) => readInput(inputFile, projectRoot, sessionId),
          write: (projectRoot, own, draft, queued) => rememberInput(inputFile, { projectRoot, sessionId: own, draft, queued }),
        },
        interactive: Boolean(stdin.isTTY && stdout.isTTY),
        // 个人键位存在本机另一份文件里：读与写同样由启动这一侧接出去，界面不认识路径（方案 6.1）。
        keys: { read: () => readKeys(keyFile), write: (overrides) => writeKeys(keyFile, overrides) },
        // 状态行按宽度取舍要看终端列数（D40），界面自己不读进程。
        stdout,
      }),
      { stdout, stdin, stderr },
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
