export const TUI_COLORS = {
  accent: 'green',
  success: 'green',
  muted: 'gray',
  warning: 'yellow',
  error: 'red',
  info: 'cyan',
} as const;

export type TuiColorRole = keyof typeof TUI_COLORS;
