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
    // 换一具后端进程。会话不在壳里：它只负责进程，接回哪一份会话由界面用协议说（D30、第 65 步）。
    restart: () => invoke('host_restart').then(() => undefined),
    // 首次使用时那一份默认工作区在壳那一侧：交回系统文档目录下那一具，不在那儿就建出来（方案 5.5.3）。
    defaultWorkspace: () => invoke<string>('default_workspace'),
    // 壳那一侧的退出请求（托盘「退出」、macOS 的 Cmd+Q、关掉最后一扇窗口都走这一条，方案 6.4）。
    onQuit: (handle) => { void listen('shell-quit', () => handle()); },
    // 人确认过之后才真的收：壳记下这一条之后不再拦退出与关闭（`app_quit`）。
    quit: () => invoke('app_quit').then(() => undefined),
  };
}
