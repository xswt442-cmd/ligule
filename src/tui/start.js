// 终端界面的启动（D33）：Host 与界面在同一个进程里，两端换成内存载体（src/host/memory.js）。
// 界面读的是与桌面壳同一份协议：session.create、run.start、两条通报，以及 Host 反过来的那一次审批请求。
// ink 与 react 是可选依赖，缺了它们这一条命令报 tui_dependency_missing，命令行其余部分照旧能跑。
import { createElement } from 'react';
import { render } from 'ink';
import { createConnection } from '../host/connection.js';
import { createMemoryConnectionPair } from '../host/memory.js';
import { serveHost } from '../host/host.js';
import { App } from './app.js';

export async function runTui({ config, provider, policy, logger, stdout = process.stdout, stdin = process.stdin, stderr = process.stderr }) {
  const pair = createMemoryConnectionPair();
  const host = serveHost({ input: pair.host.input, output: pair.host.output, config, provider, policy, logger });
  const client = createConnection(pair.client);
  const { sessionId } = await client.request('session.create', {});
  const instance = render(
    createElement(App, {
      client,
      sessionId,
      info: { model: config.model?.model, boundary: config.boundary },
      interactive: Boolean(stdin.isTTY && stdout.isTTY),
    }),
    { stdout, stdin, stderr },
  );
  await instance.waitUntilExit();
  // 界面退出之后关掉客户端这一侧：Host 读到末尾就把还在跑的轮次取消、按装配清单的逆序撤插件（D30）。
  pair.client.output.end();
  host.release();
}
