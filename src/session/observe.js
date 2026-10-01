// 本次运行的文件观察记录：`read` 完整读过一个文件之后登记它的内容版本，写操作在改动之后重新登记，
// `write` 覆盖之前必须能对上那一次登记的版本（D3 的写语义）。
// 记录留在宿主这一侧、不交给模型，模型就伪造不出「我读过」；令牌按内容算而不是按时间戳算，
// 因为 Windows 上时间戳会在内容没变时也变。
import { createHash } from 'node:crypto';

// 内容版本令牌：整份字节的 sha256 取前 16 个十六进制字符。
export function versionOf(bytes) {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

export function createObservationLog() {
  const seen = new Map();
  return {
    observe(path, version) {
      seen.set(path, version);
    },
    versionAt(path) {
      return seen.get(path);
    },
    forget(path) {
      seen.delete(path);
    },
  };
}
