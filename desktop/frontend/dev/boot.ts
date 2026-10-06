// 开发入口：先把假宿主挂到那个注入点上，再加载那一份界面。
// `src/main.tsx` 在模块顶层读 `window.__LIGULE_TRANSPORT__`，所以顺序不能反。
import { createFakeHost } from './fake-host';

window.__LIGULE_TRANSPORT__ = createFakeHost();
await import('../src/main');
