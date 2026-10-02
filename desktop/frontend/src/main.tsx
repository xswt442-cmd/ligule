import { createRoot } from 'react-dom/client';
import { App } from './App';
import { tauriTransport } from './bridge';
import type { Transport } from './protocol';
import './styles.css';

// 界面在浏览器里也能跑：页面外部可以先挂一个 window.__LIGULE_TRANSPORT__ 再加载这一份，
// 用它喂假的后端帧做检查（testplace/check-desktop-frontend.mjs）。没有挂就走壳的 Tauri 载体。
const transport: Transport = window.__LIGULE_TRANSPORT__ ?? tauriTransport();

const root = document.getElementById('root');
if (root === null) throw new Error('the page has no #root');
createRoot(root).render(<App transport={transport} />);
