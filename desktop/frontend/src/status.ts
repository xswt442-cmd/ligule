// `status.get` 交回的那一格形状（D82、D86）。方法与参数模式定义在后端 `src/host/protocol.js`，
// 这里只留界面要读的那几格：读不到的字段不参与画，画出来的都在这一份上。
export type Usage = {
  window: number;
  threshold: number;
  retained: number;
  estimated: number;
  factor: number | null;
  reported: { seq: number; input: number; output: number } | null;
  measurement: string;
};

export type Status = {
  sessionId: string;
  running: boolean;
  tools: string[];
  // 模式名与判定档位是两样东西，字段也分开（D40：界面上 `mode` 这个词不该同时指两处）。
  mode: string | null;
  modeLayer: string | null;
  pendingMode: string | null;
  policy: string;
  denials: { consecutive: number; total: number };
  eventCount: number;
  // 窗口那一格没写时宿主交出 null：两条触发都不启用，压力条整块不出现（D75）。
  usage: Usage | null;
};
