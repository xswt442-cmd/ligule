// Node 的 fetch 会拒绝一组保留端口，因此测试服务器需要避开这些端口。
const REFUSED = new Set([1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]);

export function fetchablePort(port) {
  return typeof port === 'number' && port >= 1024 && !REFUSED.has(port);
}

// 让系统分配端口；若端口不可用于 fetch，则关闭服务器并重新申请。
export async function listenFetchable(server) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (attempt > 0) {
      server.close();
      await new Promise((resolve) => server.once('close', resolve));
    }
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address()?.port;
    if (fetchablePort(port)) return port;
  }
  throw new Error(`test_endpoint_port_unusable:${String(server.address()?.port)}`);
}
