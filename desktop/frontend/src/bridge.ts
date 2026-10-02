import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Transport } from './protocol';

// 桌面壳的载体（D30）：一行一条帧，经 Tauri 的命令与事件在 WebView 与后端进程的两根管道之间搬进搬出。
// 界面拿不到地址、端口与凭据，本机也不监听端口。
export function tauriTransport(): Transport {
  return {
    send: (frame) => {
      void invoke('host_send', { frame });
    },
    onFrame: (handle) => {
      void listen<string>('host-frame', (event) => handle(event.payload));
    },
    onLog: (handle) => {
      void listen<string>('host-log', (event) => handle(event.payload));
    },
  };
}
