// 开发入口：先把假宿主挂到那个注入点上，再加载那一份界面。
// `src/main.tsx` 在模块顶层读 `window.__LIGULE_TRANSPORT__`，所以顺序不能反。
// `?rows=2000` 让假宿主交出那么多条合成记录；再加 `?bench=1` 就量一轮读数，结果画在右下角并打进控制台。
//
// 读数不用 `requestAnimationFrame`：窗口被别的程序挡住时 Chrome 不产帧，那一类采样会一直等下去。
// 这里量的是「一次动作到界面挂上 DOM 并完成一次布局」的墙钟时间，两拍调度那几毫秒算在里面。
import { createFakeHost, longEvent } from './fake-host';

declare global {
  interface Window {
    __LIGULE_COST__?: (action: () => void) => Promise<number>;
  }
}

const params = new URLSearchParams(location.search);
const rows = Number(params.get('rows') ?? 0);
const host = createFakeHost(rows > 0 ? { events: rows } : {});
window.__LIGULE_TRANSPORT__ = host;
await import('../src/main');

const transcript = (): HTMLElement => document.querySelector('.conversation') as HTMLElement;
const idle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const mountedRows = () => document.querySelectorAll('.conversation > .row').length;

async function cost(action: () => void): Promise<number> {
  await idle();
  const node = transcript();
  const started = performance.now();
  action();
  // 两拍：React 把这一批更新交出去并挂上 DOM，之后那一次布局才算进读数里。
  await idle();
  await idle();
  void node.offsetHeight;
  return Number((performance.now() - started).toFixed(2));
}

const average = (values: number[]) => Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2));
const worst = (values: number[]) => Math.max(...values);
const click = (label: string) => [...document.querySelectorAll('button')].find((item) => item.textContent === label);

// 滚一遍：每次改 scrollTop 之后逼一次布局，量的是这一屏换一次位置要多久。
async function scrollCost(): Promise<Record<string, number>> {
  const node = transcript();
  const span = node.scrollHeight - node.clientHeight;
  const values: number[] = [];
  for (let index = 0; index < 20; index += 1) {
    values.push(await cost(() => {
      node.scrollTop = ((index + 1) / 20) * span;
    }));
  }
  return { 平均: average(values), 最慢: worst(values) };
}

// 追加一条刚落盘的事件：整份列表要重画一次，这一格说的是每来一条要多久。
async function appendCost(target: ReturnType<typeof createFakeHost>, times: number): Promise<Record<string, number>> {
  const values: number[] = [];
  for (let index = 0; index < times; index += 1) {
    values.push(await cost(() => target.pushEvent(longEvent(index + 1))));
  }
  return { 平均: average(values), 最慢: worst(values) };
}

async function runBench(target: ReturnType<typeof createFakeHost>, count: number): Promise<void> {
  // 等界面挂上、那一份会话建出来：读记录那一个按钮在没有会话时什么都不做。
  for (let tries = 0; tries < 100 && (transcript() === null || document.getElementById('session-title')?.textContent === '没有会话'); tries += 1) {
    await idle();
  }
  const rebuild = await cost(() => click('读回记录')?.click());
  const windowed = {
    挂上的行数: mountedRows(),
    整份重建毫秒: rebuild,
    滚动一次毫秒: await scrollCost(),
    追加一条毫秒: await appendCost(target, 40),
  };

  // 对照组：把整份记录都挂上，再量同样两件事。走的是界面上真有的那一个把手。
  for (let tries = 0; tries < 20 && document.querySelector('.earlier') !== null; tries += 1) {
    await cost(() => [...document.querySelectorAll('button')].find((item) => item.textContent?.startsWith('显示更早'))?.click());
  }
  const readout = {
    记录条数: count,
    窗口内: windowed,
    全量: {
      挂上的行数: mountedRows(),
      滚动一次毫秒: await scrollCost(),
      追加一条毫秒: await appendCost(target, 15),
    },
  };
  const panel = document.createElement('pre');
  panel.id = 'bench';
  panel.style.cssText = 'position:fixed;right:1rem;bottom:1rem;z-index:9;padding:.6rem .8rem;border:1px solid #3a3a3a;border-radius:6px;background:#101013;color:#d8d8d8;font-size:12px;white-space:pre';
  panel.textContent = JSON.stringify(readout, null, 2);
  document.body.append(panel);
  console.log('桌面前端读数', JSON.stringify(readout));
}

// 那一个测量也交出去：浏览器里可以在任意挂上行数下再量一次，不必重开页面。
window.__LIGULE_COST__ = cost;
if (params.get('bench') === '1') void runBench(host, rows);
