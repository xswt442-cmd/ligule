import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Transport } from './protocol';

// 桌面壳的载体（D30）：一行一条帧，经 Tauri 的命令与事件在 WebView 与后端进程的两根管道之间搬进搬出。
// 界面拿不到地址、端口与凭据，本机也不监听端口。
export function tauriTransport(): Transport {
  let fault: ((reason: string) => void) | undefined;
  return {
    send: (frame) => {
      // 壳那一侧回不了话（后端进程不在了、管道断了）就报到故障那一条路上：帧发不出去是界面要知道的事。
      invoke('host_send', { frame }).catch((reason: unknown) => {
        fault?.(String((reason as { message?: unknown })?.message ?? reason));
      });
    },
    onFrame: (handle) => {
      void listen<string>('host-frame', (event) => handle(event.payload));
    },
    onLog: (handle) => {
      void listen<string>('host-log', (event) => handle(event.payload));
    },
    onFault: (handle) => {
      fault = handle;
    },
  };
}
