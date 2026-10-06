import type { ReactElement } from 'react';

// 界面要的那些形状自己画：为十来个图标引一条图标库不划算（D97）。
// 一律 24 的视图框、随字色走的描边，尺寸由调用方给。
const SHAPES = {
  plus: <path d="M12 5v14M5 12h14" />,
  send: <path d="M12 20V5M6 11l6-6 6 6" />,
  stop: <path d="M7 7h10v10H7z" />,
  gear: <>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M12 3v2.4M12 18.6V21M3 12h2.4M18.6 12H21M5.6 5.6l1.7 1.7M16.7 16.7l1.7 1.7M18.4 5.6l-1.7 1.7M7.3 16.7l-1.7 1.7" />
  </>,
  grid: <path d="M4 6h16M4 12h16M4 18h16" />,
  copy: <>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M15 5H6a2 2 0 0 0-2 2v9" />
  </>,
  chevron: <path d="M9 6l6 6-6 6" />,
  check: <path d="M5 13l4 4L19 7" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  warn: <>
    <path d="M12 4l8 15H4z" />
    <path d="M12 10v4M12 16.5v.5" />
  </>,
  folder: <path d="M4 7h5l2 2h9v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" />,
  clock: <>
    <circle cx="12" cy="12" r="8" />
    <path d="M12 8v4.5l3 1.5" />
  </>,
  refresh: <path d="M20 12a8 8 0 1 1-2.6-5.9M20 4v4h-4" />,
  search: <>
    <circle cx="11" cy="11" r="6" />
    <path d="M15.5 15.5L20 20" />
  </>,
  spark: <path d="M12 4l1.8 5.2L19 11l-5.2 1.8L12 18l-1.8-5.2L5 11l5.2-1.8z" />,
};

export type IconName = keyof typeof SHAPES;

export function Icon({ name, size = 16 }: { name: IconName; size?: number }): ReactElement {
  return <svg
    viewBox="0 0 24 24"
    width={size}
    height={size}
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    className="icon"
  >{SHAPES[name]}</svg>;
}
