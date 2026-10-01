// 后端能力探测：每个后端自带一个探测函数，强制程度由实测得出（I8、D18）。
// 探测不出结果时返回稳定错误码并把强制程度报成 none：报「没有约束」是可以被调用方处置的，
// 看起来受控而实际没有约束不是。底层的异常文本进日志，返回体只带错误码（D19）。
import { KernelError } from './error.js';
import { createLogger } from './log.js';

const LEVELS = ['full', 'partial', 'none'];

export async function probeBackend(backend, logger = createLogger()) {
  if (!backend || typeof backend.name !== 'string' || backend.name === '') {
    throw new KernelError('backend_name_required');
  }
  const failed = (code, cause) => {
    logger.error(`backend ${backend.name}: ${code}`, { backend: backend.name, code, cause: cause?.message });
    return { name: backend.name, enforced: 'none', code };
  };

  if (typeof backend.probe !== 'function') return failed('capability_probe_missing');

  let level;
  try {
    level = await backend.probe();
  } catch (cause) {
    return failed('capability_probe_failed', cause);
  }
  if (!LEVELS.includes(level)) return failed('capability_probe_result_invalid');
  return { name: backend.name, enforced: level };
}
