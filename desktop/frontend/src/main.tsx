import { createRoot } from 'react-dom/client';
import { App } from './App';
import { tauriTransport } from './bridge';
import type { Transport } from './protocol';
import './styles.css';

// 界面在浏览器里也能跑：页面外部可以先挂一个 window.__LIGULE_TRANSPORT__ 再加载这一份，
// 开发时那一份挂在 `dev/` 的假宿主就是这么进来的。没有外部载体时使用桌面壳的 Tauri 载体。
const transport: Transport = window.__LIGULE_TRANSPORT__ ?? tauriTransport();

const root = document.getElementById('root');
if (root === null) throw new Error('the page has no #root');
createRoot(root).render(<App transport={transport} />);
