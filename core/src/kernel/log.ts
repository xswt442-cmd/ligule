// 向组件注入统一日志接口：`debug` 和 `log` 必需，`error` 可选；具体实现由 Host 提供。
// 宿主没有交 logger 时不产生任何输出：内核不写死输出目标，也不假设那里有一个终端可写。
import { KernelError } from './error.js';

export type LoggerFields = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(message: string, fields?: LoggerFields): void;
  log(message: string, fields?: LoggerFields): void;
  error(message: string, fields?: LoggerFields): void;
}

export interface LoggerBackend {
  debug(message: string, fields?: LoggerFields): void;
  log(message: string, fields?: LoggerFields): void;
  error?(message: string, fields?: LoggerFields): void;
}

const NOOP: Logger = Object.freeze({
  debug() {},
  log() {},
  error() {},
});

export function createLogger(logger?: LoggerBackend): Logger {
  if (logger === undefined) return NOOP;
  if (typeof logger.debug !== 'function' || typeof logger.log !== 'function') {
    throw new KernelError('logger_debug_and_log_required');
  }
  if (logger.error !== undefined && typeof logger.error !== 'function') {
    throw new KernelError('logger_error_must_be_function');
  }
  const backendError = logger.error;
  // 宿主只实现 debug 与 log 时，错误经 log 送出去并带上 severity，这样它不会在日志里消失。
  const error = typeof backendError === 'function'
    ? (message: string, fields?: LoggerFields) => backendError.call(logger, message, fields)
    : (message: string, fields?: LoggerFields) => logger.log(message, { ...fields, severity: 'error' });
  return {
    debug: (message: string, fields?: LoggerFields) => logger.debug(message, fields),
    log: (message: string, fields?: LoggerFields) => logger.log(message, fields),
    error,
  };
}
