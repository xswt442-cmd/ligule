// 内存载体（D30 的「载体可以替换」、D33 的终端界面走这一条）：客户端与 Host 在同一个进程里，
// 帧仍然按一行一条走，两端换成两根 PassThrough。协议、connection.js 与内核都不为此改动。
// 两根流交叉接：写进 client.output 的一行由 host.input 读出，反向同理。
import { PassThrough } from 'node:stream';

export function createMemoryConnectionPair() {
  const toHost = new PassThrough();
  const toClient = new PassThrough();
  return {
    host: { input: toHost, output: toClient },
    client: { input: toClient, output: toHost },
  };
}
