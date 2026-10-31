// 子进程向终端和桌面共用的输入历史追加内容，用于验证跨进程写入锁。
import { rememberHistory } from '../../dist/kernel/input-history.js';

const [path, sentence] = process.argv.slice(2);

try {
  await rememberHistory(path, [sentence]);
  process.stdout.write(`${JSON.stringify({ written: true })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ written: false, code: error.code })}\n`);
}
