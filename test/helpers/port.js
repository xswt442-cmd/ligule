// 本地起一个给 fetch 用的 HTTP 服务，要等到的是一个 fetch 用得出去的端口。
// Node 的 fetch 拒去一张固定表里的端口（telnet、IRC、SIP、6000、10080 那些，1024 以下只放 80 与 443）；
// 下面那一张是这一版 Node 上扫出来的（1 到 65535 整片扫一遍，拒的共 82 个，最大的一个是 10080，这里只需要 1024 以上那 19 个）。
// Windows 上 `listen(0)` 的端口是按这一台机器的动态范围顺序发的（本机 2026-10-08 量过：范围从 1024 起、共 13977 个），
// 那张表里 1024 以上的那 19 个正好落在里面。于是光标走到那一段时，一片测试的往返都读成端点坏了：
// 报的是 `provider_transport_failed`，底下是 fetch 的「bad port」。
const REFUSED = new Set([1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]);

function fetchablePort(port) {
  return typeof port === 'number' && port >= 1024 && !REFUSED.has(port);
}

// 让系统挑端口，挑到一个 fetch 用得出去的为止：每重听一次，系统那一份光标就往前走一格，所以几轮之内必定拿到。
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
