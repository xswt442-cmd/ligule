// 三方法的日志接口注入给所有组件（D26）：必需 debug 与 log，可选 error，后端由宿主自己接。
// 宿主没有交 logger 时不产生任何输出：内核不写死输出目标，也不假设那里有一个终端可写。
import { KernelError } from './error.js';

const NOOP = Object.freeze({
  debug() {},
  log() {},
  error() {},
});

export function createLogger(logger) {
  if (logger === undefined) return NOOP;
  if (typeof logger.debug !== 'function' || typeof logger.log !== 'function') {
    throw new KernelError('logger_debug_and_log_required');
  }
  if (logger.error !== undefined && typeof logger.error !== 'function') {
    throw new KernelError('logger_error_must_be_function');
  }
  // 宿主只实现 debug 与 log 时，错误经 log 送出去并带上 severity，这样它不会在日志里消失。
  const error = typeof logger.error === 'function'
    ? (message, fields) => logger.error(message, fields)
    : (message, fields) => logger.log(message, { ...fields, severity: 'error' });
  return {
    debug: (message, fields) => logger.debug(message, fields),
    log: (message, fields) => logger.log(message, fields),
    error,
  };
}
