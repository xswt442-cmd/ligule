// 终端那几份检查读的是画出来的那一帧。ink 把每一帧包在同步输出的起止符之间（`write-synchronized.js` 的 `bsu` 与 `esu`），
// 所以只认带结束符的那一帧：按起始符切只拿最后一段时，负载下一帧还没写完就会被读成「画出来的是别的状态」，
// 正断言等不到、负断言又能提前成立。样式码在这之后就去掉，光标处那一段的反色标记不会把一串字切开。
export function completeFrame(value) {
  const closed = value.lastIndexOf('\x1B[?2026l');
  return closed < 0 ? '' : (value.slice(0, closed).split('\x1B[?2026h').pop() ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}
