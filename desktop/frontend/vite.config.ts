import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 端口写死并 strictPort：桌面壳的 devUrl 指着这一个地址，端口被占就失败，不要静默换一个让壳打不开界面。
// 生产构建生成静态资源，由 Electron 的 app:// 协议加载。
export default defineConfig(({ command }) => ({
  plugins: [react()],
  html: { cspNonce: command === 'serve' ? process.env.LIGULE_DESKTOP_CSP_NONCE : undefined },
  clearScreen: false,
  server: { port: 5188, strictPort: true },
  build: { outDir: 'dist', target: 'es2022' },
}));
