import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { TextDecoder } from 'node:util';

const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_WRITE_QUEUE_BYTES = 32 * 1024 * 1024;
const SHUTDOWN_GRACE_MS = 3_000;

export type HostFault = 'spawn-failed' | 'stdout-invalid-utf8' | 'stdout-frame-too-large' | 'stdout-invalid-json' | 'stdout-truncated-frame' | 'stderr-read-failed' | 'process-error' | 'process-exit' | 'write-failed' | 'write-queue-full';

export interface HostControllerOptions {
  node: string;
  hostEntry: string;
  entry?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  onFrame(frame: string): void;
  onFault(fault: HostFault): void;
}

export class HostController {
  private readonly options: HostControllerOptions;
  private generation = 0;
  private child: ChildProcessWithoutNullStreams | undefined;
  private pendingWrites = 0;
  private stopped = true;
  private cleanup: Promise<void> | undefined;
  private lifecycleOperation: 'start' | 'stop' | 'restart' | undefined;

  constructor(options: HostControllerOptions) {
    this.options = options;
  }

  // 只供主进程自己使用（诊断与真实窗口验收）：定位当前那一具 Host，不向 Renderer 暴露进程信息。
  get pid(): number | undefined {
    return this.child?.pid;
  }

  start(): Promise<void> {
    return this.withLifecycle('start', () => this.startInternal());
  }

  private async startInternal(): Promise<void> {
    if (this.child !== undefined) throw new Error('Host is already running');
    await this.cleanup;
    this.cleanup = undefined;
    this.stopped = false;
    const generation = ++this.generation;
    let child: ChildProcessWithoutNullStreams;
    try {
      const arguments_ = this.options.entry === undefined
        ? [this.options.hostEntry, 'host']
        : [this.options.entry, this.options.hostEntry];
      const stdio: ('pipe' | 'ipc')[] = this.options.entry === undefined
        ? ['pipe', 'pipe', 'pipe']
        : ['pipe', 'pipe', 'pipe', 'ipc'];
      child = spawn(this.options.node, arguments_, {
        cwd: this.options.cwd,
        env: this.options.env,
        stdio,
        windowsHide: true,
        detached: process.platform !== 'win32',
      }) as unknown as ChildProcessWithoutNullStreams;
    } catch {
      this.stopped = true;
      this.options.onFault('spawn-failed');
      throw new Error('Host could not be started');
    }
    this.child = child;
    this.pendingWrites = 0;
    this.readFrames(child, generation);
    child.stderr.on('data', () => {
      // stderr 只排空，绝不把原始诊断内容交给界面。
    });
    child.stderr.on('error', () => this.fault(generation, 'stderr-read-failed'));
    child.stdin.on('error', () => this.fault(generation, 'write-failed'));
    child.on('error', () => this.fault(generation, 'process-error'));
    child.on('disconnect', () => this.fault(generation, 'process-exit'));
    child.on('exit', () => this.fault(generation, 'process-exit'));
  }

  send(frame: string): Promise<void> {
    if (this.lifecycleOperation !== undefined) return Promise.reject(new Error('Host lifecycle operation is in progress'));
    const child = this.child;
    if (this.stopped || child === undefined || child.stdin.destroyed || child.stdin.writableEnded) {
      return Promise.reject(new Error('Host transport is closed'));
    }
    if (frame.includes('\n') || frame.includes('\r') || !isJsonObject(frame)) {
      return Promise.reject(new Error('Host frame must be one valid JSON object on one line'));
    }
    const payload = `${frame}\n`;
    const size = Buffer.byteLength(payload, 'utf8');
    const generation = this.generation;
    if (this.pendingWrites + size > MAX_WRITE_QUEUE_BYTES) {
      if (generation === this.generation && child === this.child) this.options.onFault('write-queue-full');
      return Promise.reject(new Error('Host write queue is full'));
    }
    this.pendingWrites += size;
    return new Promise((resolve, reject) => {
      child.stdin.write(payload, 'utf8', (error) => {
        if (generation === this.generation && child === this.child) {
          this.pendingWrites = Math.max(0, this.pendingWrites - size);
        }
        if (error !== null && error !== undefined) {
          this.fault(generation, 'write-failed');
          reject(new Error('Host frame could not be written'));
          return;
        }
        resolve();
      });
    });
  }

  restart(): Promise<void> {
    return this.withLifecycle('restart', async () => {
      await this.stopInternal();
      await this.startInternal();
    });
  }

  stop(): Promise<void> {
    return this.withLifecycle('stop', () => this.stopInternal());
  }

  private async stopInternal(): Promise<void> {
    const child = this.child;
    this.stopped = true;
    this.generation += 1;
    if (child === undefined) {
      await this.cleanup;
      return;
    }
    await this.stopCurrent(child);
  }

  private withLifecycle(operation: 'start' | 'stop' | 'restart', action: () => Promise<void>): Promise<void> {
    if (this.lifecycleOperation !== undefined) {
      return Promise.reject(new Error('Host lifecycle operation is in progress'));
    }
    this.lifecycleOperation = operation;
    return action().finally(() => {
      if (this.lifecycleOperation === operation) this.lifecycleOperation = undefined;
    });
  }

  private async stopCurrent(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (this.child === child) this.child = undefined;
    if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
    await waitForExit(child, SHUTDOWN_GRACE_MS);
    if (child.exitCode === null && child.signalCode === null) {
      this.killOwnedProcess(child);
      await waitForExit(child, SHUTDOWN_GRACE_MS);
    }
    if (child.exitCode === null && child.signalCode === null) throw new Error('Host process did not exit');
  }

  private readFrames(child: ChildProcessWithoutNullStreams, generation: number): void {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let pending = '';
    let pendingBytes = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      if (generation !== this.generation) return;
      let decoded: string;
      try {
        decoded = decoder.decode(chunk, { stream: true });
      } catch {
        this.fault(generation, 'stdout-invalid-utf8');
        return;
      }
      let start = 0;
      while (start <= decoded.length) {
        const end = decoded.indexOf('\n', start);
        const segment = decoded.slice(start, end < 0 ? decoded.length : end);
        pendingBytes += Buffer.byteLength(segment, 'utf8');
        if (pendingBytes > MAX_FRAME_BYTES) {
          this.fault(generation, 'stdout-frame-too-large');
          return;
        }
        pending += segment;
        if (end < 0) return;
        const frame = pending.endsWith('\r') ? pending.slice(0, -1) : pending;
        if (!isJsonObject(frame)) {
          this.fault(generation, 'stdout-invalid-json');
          return;
        }
        pending = '';
        pendingBytes = 0;
        try {
          this.options.onFrame(frame);
        } catch {
          this.fault(generation, 'process-error');
          return;
        }
        start = end + 1;
      }
    });
    child.stdout.on('end', () => {
      try {
        pending += decoder.decode();
      } catch {
        this.fault(generation, 'stdout-invalid-utf8');
        return;
      }
      if (pending.length > 0) this.fault(generation, 'stdout-truncated-frame');
      else this.fault(generation, 'process-exit');
    });
    child.stdout.on('error', () => this.fault(generation, 'process-error'));
  }

  private fault(generation: number, fault: HostFault): void {
    if (generation !== this.generation || this.stopped) return;
    this.stopped = true;
    this.options.onFault(fault);
    const child = this.child;
    this.child = undefined;
    child?.stdin.destroy();
    if (child !== undefined) {
      this.killOwnedProcess(child);
      this.cleanup = waitForExit(child, SHUTDOWN_GRACE_MS);
    }
  }

  private killOwnedProcess(child: ChildProcessWithoutNullStreams): void {
    if (child.pid === undefined) return;
    if (process.platform === 'win32') {
      child.kill();
      return;
    }
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill();
    }
  }
}

function isJsonObject(value: string): boolean {
  if (value.length === 0) return false;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, timeoutMs);
    child.once('exit', done);
    function done(): void {
      clearTimeout(timer);
      child.removeListener('exit', done);
      resolve();
    }
  });
}
