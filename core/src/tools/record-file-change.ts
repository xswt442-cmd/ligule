import type { ToolContext } from '../kernel/kernel.js';
import type { FileChangeMutation } from '../session/file-changes.js';

/** 记录文件变更事实所需的最小上下文。 */
export type FileChangeRecorderContext = {
  readonly permission?: ToolContext['permission'];
  readonly fileChanges?: ToolContext['fileChanges'];
};

/** 当前 Permission 仍允许读取文件时，文件变更事实才可以保留回读正文。 */
export function fileChangeReadbackAllowed(context: Pick<FileChangeRecorderContext, 'permission'>): boolean {
  const read = context.permission?.capabilities.filesystemRead;
  return read !== undefined && read !== 'unavailable';
}

/**
 * 统一记录文件变更事实：调用点只描述变更本身，回读授权始终由当前 Permission 推导，
 * 避免每个工具各自复制粘贴同一段 record 调用与授权判断。
 */
export async function recordFileChange(context: FileChangeRecorderContext,
  mutation: Omit<FileChangeMutation, 'allowReadback'>): Promise<void> {
  await context.fileChanges?.record({ ...mutation, allowReadback: fileChangeReadbackAllowed(context) });
}
