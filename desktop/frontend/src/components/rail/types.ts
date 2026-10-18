export type SearchHit = {
  sessionId: string;
  name?: string;
  seq: number;
  kind: string;
  text: string;
  // 摘录来自记录中的摘要；未搜索的溢出内容不会出现在这里。
  spilled?: string;
};

export type SessionSummary = {
  id: string;
  // 没有首行的旧记录按格式版本 0 读取。
  formatVersion: number;
  projectRoot: string;
  // 分组依据记录首行；空值表示记录没有这项元数据。
  workspace?: string;
  workspaceOrigin?: string;
  createdAt: string | null;
  updatedAt: string;
  events: number;
  lastSeq: number;
  mode: { name: string; layer: string; digest: string } | null;
  // 有自定义名称时显示在列表中；归档只改变列表显示。
  name?: string;
  archived?: boolean;
  // 重新打开记录时，没有结果的调用会标记为结果未知。
  unanswered: number;
  truncatedBytes: number;
  error?: { code: string; detail: string };
};
