// 视图行交给组件的那一格形状（D88）。组件只认这一份，不认会话记录。
import type { Row } from '../rows';

// 工作步骤展示的四个档位：只改可见性与默认是否展开，收进来的东西一直是全的（D32）。
export type Verbosity = 'brief' | 'standard' | 'detailed' | 'full';

export type RowProps = { row: Row; verbosity: Verbosity };
