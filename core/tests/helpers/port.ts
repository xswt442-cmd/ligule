import type { Server } from 'node:http';

const REFUSED = new Set([1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]);

export function fetchablePort(port: unknown): port is number {
  return typeof port === 'number' && port >= 1024 && !REFUSED.has(port);
}

export async function listenFetchable(server: Server): Promise<number> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (attempt > 0) {
      server.close();
      await new Promise<void>((resolve) => server.once('close', resolve));
    }
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : undefined;
    if (fetchablePort(port)) return port;
  }
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : undefined;
  throw new Error(`test_endpoint_port_unusable:${String(port)}`);
}
