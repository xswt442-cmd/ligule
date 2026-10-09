import type { LucideIcon } from 'lucide-react';
import { ArrowUp, Check, Clock, Copy, Download, Folder, List, Plus, RefreshCw, Search, Settings, Sparkles, Square, TriangleAlert, X } from 'lucide-react';

// 图标统一走 lucide：一套 24 的视图框、一种线条，尺寸与描边在这一处定，调用方只挑名字。
// 界面只开这一份口子：新增图标要在下面这张表里挂号，不让某一格里随手引一枚别的形状。
const SHAPES = {
  plus: Plus,
  send: ArrowUp,
  stop: Square,
  gear: Settings,
  grid: List,
  copy: Copy,
  download: Download,
  check: Check,
  close: X,
  warn: TriangleAlert,
  folder: Folder,
  clock: Clock,
  refresh: RefreshCw,
  search: Search,
  spark: Sparkles,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof SHAPES;

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  const Shape = SHAPES[name];
  return <Shape size={size} strokeWidth={1.7} aria-hidden="true" className="icon" />;
}
