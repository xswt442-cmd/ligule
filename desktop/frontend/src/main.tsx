import { createRoot } from 'react-dom/client';
import { App } from './App';
import { electronTransport } from './bridge';
import type { Transport } from './protocol';
import './styles.css';

// 浏览器测试注入只在 Vite 开发构建且没有原生桥时可用；发行版使用固定的 Preload 接口。
const transport: Transport = import.meta.env.DEV && window.liguleDesktop === undefined && window.__LIGULE_TRANSPORT__ !== undefined
  ? window.__LIGULE_TRANSPORT__ : electronTransport();

const root = document.getElementById('root');
if (root === null) throw new Error('the page has no #root');
createRoot(root).render(<App transport={transport} />);
