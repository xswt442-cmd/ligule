export interface SessionSummary {
  id: string;
  // 缺少首行的旧记录按版本 0 解析。
  formatVersion: number;
  projectRoot: string;
  // 旧记录没有工作区来源字段时返回空值，表示来源未知，不表示默认工作区。
  workspace: string;
  workspaceOrigin: string;
  createdAt: string | null;
  updatedAt: string;
  events: number;
  lastSeq: number;
  mode: { name: string; layer: string; digest: string } | null;
  // 返回用户设置的会话名称；未命名时为空字符串，由列表显示会话编号。
  name: string;
  // 归档状态只影响列表展示；会话记录仍可恢复或取消归档。
  archived: boolean;
  // 返回已派发但尚无结果的调用数；恢复会话时这些调用会被标记为结果未知。
  unanswered: number;
  truncatedBytes: number;
  error?: { code: string; detail: string };
}
