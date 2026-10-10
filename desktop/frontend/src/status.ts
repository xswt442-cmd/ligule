// `status.get` 交回的那一格形状（D82、D86）。方法与参数模式定义在后端 `src/host/protocol.js`，
// 这里只留界面要读的那几格：读不到的字段不参与画，画出来的都在这一份上。
export type Usage = {
  window: number;
  threshold: number;
  retained: number;
  estimated: number;
  // 修正系数：宿主按端点报回的用量算出来，没有可算的依据时是 1（D86）。
  factor: number;
  // 量法的名字。本地估算一直是整份请求那一种，记作 `request-v1`（D86）。
  measurement: string;
  reported: { seq: number; input: number; output: number | null } | null;
};

export type Status = {
  sessionId: string;
  running: boolean;
  tools: string[];
  // 模式名与判定档位是两样东西，字段也分开（D40：界面上 `mode` 这个词不该同时指两处）。
  mode: string | null;
  modeLayer: string | null;
  pendingMode: string | null;
  model: string | null;
  pendingModel: string | null;
  policy: string;
  // 现在生效的档位来自哪一层：配置默认还是会话临时改的（`status.get`、`policy.set` 都交回这一格）。
  policySource: 'config' | 'session';
  denials: { consecutive: number; total: number };
  eventCount: number;
  // 装载着的提示模板：命令面板里那几条入口读的就是这一份（D92、D54）。
  templates: { command: string; description: string; hint: string | null }[];
  // 窗口那一格没写时宿主交出 null：两条触发都不启用，压力条整块不出现（D75）。
  usage: Usage | null;
};
