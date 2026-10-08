// 视图行交给组件的那一格形状（D88）。组件只认这一份，不认会话记录。
import type { Row } from '../rows';

// 工作步骤展示的四个档位：只改可见性与默认是否展开，收进来的东西一直是全的（D32）。
export type Verbosity = 'brief' | 'standard' | 'detailed' | 'full';

// `flash` 只给查找落到的那一行：跳过来的一屏里几十行都在，不落个记号认不出停在哪一条（方案 6.2）。
// `branch` 只给一轮完整结束那一行：按下的是「从这里分支」，交出去的是那一条事件的序号（方案 4.3）。
export type RowProps = { row: Row; verbosity: Verbosity; flash?: boolean; branch?: (at: number) => void };
