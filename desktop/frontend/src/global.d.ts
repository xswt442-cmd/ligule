/// <reference types="vite/client" />
import type { Transport } from './protocol';
import type { DesktopApi } from '../../electron/api';


declare global {
  interface Window {
    readonly liguleDesktop?: DesktopApi;
    /** 仅用于开发预览和检查；存在时页面使用外部传入的帧，不连接 Electron 壳。 */
    __LIGULE_TRANSPORT__?: Transport;
  }
}

export {};
