// `status.get` 返回的数据结构。协议方法和参数模式由 `core/src/host/protocol.ts` 定义。
// 此处只声明界面使用的字段；缺少字段时不参与渲染。
export type Usage = {
  window: number;
  threshold: number;
  retained: number;
  estimated: number;
  // Host 根据服务端用量计算的 Token 估算校准系数；无校准数据时为 1。
  factor: number;
  // 本地 Token 估算方法的标识。
  measurement: string;
  reported: { seq: number; input: number; output: number | null } | null;
};

export type Status = {
  sessionId: string;
  running: boolean;
  tools: string[];
  // 当前模式名称与权限策略是不同字段，分别维护。
  mode: string | null;
  modeLayer: string | null;
  pendingMode: string | null;
  model: string | null;
  selectedModel: string | null;
  outputTokens: number | null;
  pendingModel: string | null;
  serviceId: string;
  pendingServiceId: string | null;
  policy: string;
  // 当前策略来源：配置默认值或会话运行期覆盖。
  policySource: 'config' | 'session';
  denials: { consecutive: number; total: number };
  eventCount: number;
  // 已加载的提示模板列表，供命令面板显示。
  templates: { command: string; description: string; hint: string | null }[];
  // 上下文窗口未知时 Host 返回 null；此时不启用压缩或显示压力条。
  usage: Usage | null;
  progress: RunProgress | null;
};

export type RunProgress = {
  phase: 'preparing' | 'model_request' | 'tool_execution' | 'compaction' | 'awaiting_approval' | 'awaiting_input' | 'settling';
  startedAt: number;
  phaseStartedAt: number;
  lastProgressAt: number;
  modelCalls: number;
  toolCalls: number;
  outputTokens: number | null;
};
