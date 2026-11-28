export interface ExecLogChunk {
  readonly sequence: number;
  readonly stream: 'stdout' | 'stderr';
  readonly offset: number;
  readonly data: Buffer;
}

export interface ExecLogSnapshot {
  readonly totalBytes: number;
  readonly firstAvailableOffset: number;
  readonly chunks: readonly ExecLogChunk[];
}
