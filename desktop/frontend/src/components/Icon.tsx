import type { LucideIcon } from 'lucide-react';
import { ArrowUp, Bell, Check, ChevronDown, ChevronRight, Clock, Copy, Download, Folder, FolderOpen, HelpCircle, List, MoreHorizontal, PanelLeft, Plus, RefreshCw, Search, Settings, Sparkles, Square, Trash2, TriangleAlert, X } from 'lucide-react';

// 统一使用 Lucide 图标，并在此处设置视图框、尺寸和描边。
// 组件仅接受下方登记的图标名称，新增图标需先加入列表。
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
  trash: Trash2,
  warn: TriangleAlert,
  folder: Folder,
  folderOpen: FolderOpen,
  clock: Clock,
  refresh: RefreshCw,
  search: Search,
  spark: Sparkles,
  fold: ChevronDown,
  unfold: ChevronRight,
  help: HelpCircle,
  more: MoreHorizontal,
  sidebar: PanelLeft,
  bell: Bell,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof SHAPES;

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  const Shape = SHAPES[name];
  return <Shape size={size} strokeWidth={1.7} aria-hidden="true" className="icon" />;
}
