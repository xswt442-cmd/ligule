// 一具进程往两端共用的那份输入历史里写一句：跨进程那一半的锁只有真起进程才证明得了。
import { rememberHistory } from '../../dist/kernel/input-history.js';

const [path, sentence] = process.argv.slice(2);

try {
  await rememberHistory(path, [sentence]);
  process.stdout.write(`${JSON.stringify({ written: true })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ written: false, code: error.code })}\n`);
}
