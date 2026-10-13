/// <reference types="vite/client" />
import type { Transport } from './protocol';
import type { DesktopApi } from '../../electron/api';


declare global {
  interface Window {
    readonly liguleDesktop?: DesktopApi;
    /** 预览与检查用的注入点：挂上它就不走壳的载体，帧由页面外部交进来。 */
    __LIGULE_TRANSPORT__?: Transport;
  }
}

export {};
