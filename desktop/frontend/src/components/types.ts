// 转录组件接收的行数据结构。组件不直接读取会话记录。
import type { Row } from '../rows';
import type { Client } from '../protocol';

// 推理内容的显示选项只控制可见性和默认展开状态，不修改记录内容。
export type Verbosity = 'brief' | 'standard' | 'detailed' | 'full';

// `flash` 标记搜索定位到的行。
// `branch` 标记可作为分支起点的完整结束轮次，并携带对应事件序号。
export type RowProps = { row: Row; verbosity: Verbosity; flash?: boolean; branch?: (at: number) => void; onModels?: () => void; client?: Client; sessionId?: string | null; projectRoot?: string };
