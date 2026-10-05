// 终端界面的启动（D33）：Host 与界面在同一个进程里，两端换成内存载体（src/host/memory.js）。
// 界面读的是与桌面壳同一份协议：session.create、run.start、两条通报，以及 Host 反过来的那一次审批请求。
// ink 与 react 是可选依赖，缺了它们这一条命令报 tui_dependency_missing，命令行其余部分照旧能跑。
import { createElement } from 'react';
import { render } from 'ink';
import { createConnection } from '../host/connection.js';
import { createMemoryConnectionPair } from '../host/memory.js';
import { serveHost } from '../host/host.js';
import { App } from './app.js';
import { historyPathOf, loadHistory, pushHistory, rememberHistory } from './history.js';

export async function runTui({ config, provider, policy, logger, modeName, modePaths, extensions, stdout = process.stdout, stdin = process.stdin, stderr = process.stderr, editor = process.env.EDITOR, historyFile = historyPathOf() }) {
  const pair = createMemoryConnectionPair();
  const host = serveHost({ input: pair.host.input, output: pair.host.output, config, provider, policy, logger, modeName, modePaths, extensions });
  const client = createConnection(pair.client);
  const { sessionId } = await client.request('session.create', {});
  // 输入历史读一次就交进界面：往后的读与翻都看界面自己那一份，写这一份文件也只由界面发起。
  const entries = await loadHistory(historyFile);
  let known = entries;
  const history = {
    entries,
    remember: async (text) => {
      known = pushHistory(known, text);
      try {
        await rememberHistory(historyFile, known);
      } catch {
        // 这一份便利的文件写不进去不该挡住这一次发送：会话记录才是事实源（I5）。
      }
    },
  };
  const instance = render(
    createElement(App, {
      client,
      sessionId,
      // 编辑器那一个命令名由启动这一侧读环境变量，界面自己不碰进程。
      info: { model: config.model?.model, boundary: config.boundary, editor },
      history,
      interactive: Boolean(stdin.isTTY && stdout.isTTY),
      // 状态行按宽度取舍要看终端列数（D40），界面自己不读进程。
      stdout,
    }),
    { stdout, stdin, stderr },
  );
  await instance.waitUntilExit();
  // 界面退出之后关掉客户端这一侧：Host 读到末尾就把还在跑的轮次取消、按装配清单的逆序撤插件（D30）。
  pair.client.output.end();
  host.release();
}
