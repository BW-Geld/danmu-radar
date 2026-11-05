'use strict';

/**
 * 用 Chrome DevTools Protocol 给本地页面截图（不依赖 puppeteer）。
 *
 *   node tools/shot.js http://127.0.0.1:7799/ live 1600 1000
 *
 * 做法：chrome --headless=new 直接打开目标页 → 轮询 /json/list 找到该 page target 的
 * webSocketDebuggerUrl → 连上去发 Page.enable / Page.captureScreenshot。
 * 注意：必须连 page 级 target，浏览器级 ws 不能直接发 Page.* 命令。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { WSClient } = require('../server/ws');

const url = process.argv[2] || 'http://127.0.0.1:7799/';
const name = process.argv[3] || 'shot';
const W = Number(process.argv[4] || 1600);
const H = Number(process.argv[5] || 1000);
const PORT = 9333;
const TABS = ['live', 'search', 'user', 'board', 'timeline', 'favorites', 'settings'];

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));

const log = (...a) => console.error('[shot]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 每个页签截图前先在页面里做一次真实操作 */
const DEMO = {
  live: null,
  search: `(async () => {
    document.querySelector('#q').value='哈哈';
    document.querySelector('#s-btn').click();
    await new Promise(r => setTimeout(r, 1400));
    const b = document.querySelector('.origin-btn');
    if (b) b.click();
  })();`,
  user: `(async () => {
    const r = await fetch('/api/users?q=');
    const d = await r.json();
    const uid = ${JSON.stringify(process.env.SHOT_UID || '')} || d.users[0].uid;
    document.querySelector('#uid').value = uid;
    document.querySelector('#u-btn').click();
  })();`,
  board: `(async () => {
    document.querySelector('#b-btn').click();
  })();`,
  timeline: `(async () => {
    const ready = () => /这一天共|还没有选择/.test(document.querySelector('#t-readout').textContent);
    for (let i = 0; i < 60 && !ready(); i++) await new Promise(r => setTimeout(r, 200));
    if (typeof tl === 'undefined' || !tl.data) {
      document.querySelector('#t-refresh').click();
      for (let i = 0; i < 60 && (typeof tl === 'undefined' || !tl.data); i++) await new Promise(r => setTimeout(r, 200));
    }
    if (typeof tl === 'undefined' || !tl.data) return;
    const d = tl.data;
    let best = -1, at = 0;
    for (let i = 0; i + 30 < d.buckets.length; i++) {
      let s = 0;
      for (let j = 0; j < 30; j++) s += d.buckets[i + j];
      if (s > best) { best = s; at = i; }
    }
    const cv = document.querySelector('#t-canvas');
    const rect = cv.getBoundingClientRect();
    const y = rect.top + rect.height / 2;
    const toX = (b) => rect.left + (b / 1440) * rect.width;
    const mk = (type, x) => new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 3, pointerType: 'mouse', isPrimary: true });
    cv.dispatchEvent(mk('pointerdown', toX(at)));
    cv.dispatchEvent(mk('pointermove', toX(at + 15)));
    cv.dispatchEvent(mk('pointermove', toX(at + 30)));
    cv.dispatchEvent(mk('pointerup', toX(at + 30)));
    await new Promise(r => setTimeout(r, 6000));
  })();`,
  settings: null,
};

if (!CHROME) {
  log('找不到 Chrome/Edge');
  process.exit(1);
}

const profile = path.join(process.env.TEMP || '.', `dyshot-${Date.now()}`);
const outDir = path.join(__dirname, '..', '.shots');
fs.mkdirSync(outDir, { recursive: true });

async function pageTarget() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  throw new Error('调试端口未就绪');
}

(async () => {
  const watchdog = setTimeout(() => {
    log('watchdog 60s，强制退出');
    process.exit(2);
  }, 60000);

  const child = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-crash-reporter',
      '--no-sandbox',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      `--window-size=${W},${H}`,
      url,
    ],
    { stdio: 'ignore' }
  );
  log('chrome pid', child.pid);

  let ws = null;
  try {
    const wsUrl = await pageTarget();
    log('target', wsUrl);
    const u = new URL(wsUrl);
    ws = new WSClient({
      host: u.hostname,
      port: Number(u.port),
      path: u.pathname + u.search,
      secure: false,
      origin: null, // CDP 会因 Origin 头返回 403
    });
    await ws.connect(8000);
    log('cdp connected');

    let seq = 0;
    const pending = new Map();
    ws.on('message', (payload) => {
      let msg;
      try {
        msg = JSON.parse(payload.toString('utf8'));
      } catch {
        return;
      }
      const p = msg.id && pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      }
    });
    const send = (method, params = {}, timeout = 15000) =>
      new Promise((resolve, reject) => {
        const id = ++seq;
        const t = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} 超时`));
        }, timeout);
        pending.set(id, {
          resolve: (v) => {
            clearTimeout(t);
            resolve(v);
          },
          reject: (e) => {
            clearTimeout(t);
            reject(e);
          },
        });
        ws.send(JSON.stringify({ id, method, params }), 0x1); // CDP 只接受文本帧
      });

    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', {
      width: W,
      height: H,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await send('Page.navigate', { url });
    await sleep(3000);
    log('navigated');

    for (const tab of TABS) {
      if (tab !== TABS[0]) {
        await send('Runtime.evaluate', {
          expression: `document.querySelector('[data-tab="${tab}"]').click()`,
        });
        await sleep(800);
      }
      // 给页面喂一点真实操作，避免截到的全是空状态
      const demo = DEMO[tab];
      if (demo) {
        // DEMO 是 async IIFE：用 awaitPromise 等它跑完（含页面里的等待），
        // 否则固定 sleep 会和页面内的异步请求赛跑，截到「统计中…」或空画布
        await send('Runtime.evaluate', { expression: demo, awaitPromise: true }, 60000);
        await sleep(tab === 'search' ? 1200 : 800);
      }
      const { data } = await send('Page.captureScreenshot', { format: 'png' }, 20000);
      const file = path.join(outDir, `${name}-${tab}.png`);
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
      log('saved', file, Math.round(data.length / 1024) + 'KB(b64)');
    }
    clearTimeout(watchdog);
  } catch (e) {
    log('失败:', e.message);
    process.exitCode = 1;
  } finally {
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    child.kill();
  }
})();
