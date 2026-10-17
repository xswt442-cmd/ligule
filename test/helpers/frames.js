// Ink 用同步输出起止符包住完整帧。只读取带结束符的最后一帧，避免在终端尚未写完时误判状态。
// 去除 ANSI 样式码后再比较文本，避免光标颜色等控制序列干扰断言。
export function completeFrame(value) {
  const closed = value.lastIndexOf('\x1B[?2026l');
  return closed < 0 ? '' : (value.slice(0, closed).split('\x1B[?2026h').pop() ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}
