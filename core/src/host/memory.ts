// 内存传输用于与 Host 同进程运行的客户端，例如 TUI。
// 帧仍然按一行一条走，两端换成两根 PassThrough。协议、connection.js 与内核都不为此改动。
// 两根流交叉接：写进 client.output 的一行由 host.input 读出，反向同理。
import { PassThrough } from 'node:stream';

export interface MemoryConnectionEndpoint {
  readonly input: PassThrough;
  readonly output: PassThrough;
}

export interface MemoryConnectionPair {
  readonly host: MemoryConnectionEndpoint;
  readonly client: MemoryConnectionEndpoint;
}

export function createMemoryConnectionPair(): MemoryConnectionPair {
  const toHost = new PassThrough();
  const toClient = new PassThrough();
  return {
    host: { input: toHost, output: toClient },
    client: { input: toClient, output: toHost },
  };
}
