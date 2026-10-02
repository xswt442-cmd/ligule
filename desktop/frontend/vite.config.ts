import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 端口写死并 strictPort：桌面壳的 devUrl 指着这一个地址，端口被占就失败，不要静默换一个让壳打不开界面。
// 构建产物只有 index.html 与 assets/*，交给 Tauri 打包，不留在运行时里起服务（D30、D33）。
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 5188, strictPort: true },
  build: { outDir: 'dist', target: 'es2022' },
});
