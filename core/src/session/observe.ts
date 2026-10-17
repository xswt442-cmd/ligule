// 本次运行的文件观察记录：`read` 完整读过一个文件之后登记它的内容版本，写操作在改动之后重新登记，
// `write` 覆盖文件前必须匹配读取时登记的版本。
// 记录留在宿主这一侧、不交给模型，模型就伪造不出「我读过」；令牌按内容算而不是按时间戳算，
// 因为 Windows 上时间戳会在内容没变时也变。
import { createHash } from 'node:crypto';

export interface ObservationLog {
  observe(path: string, version: string): void;
  versionAt(path: string): string | undefined;
  forget(path: string): void;
}

// 内容版本令牌：整份字节的 sha256 取前 16 个十六进制字符。
export function versionOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

export function createObservationLog(): ObservationLog {
  const seen = new Map<string, string>();
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
