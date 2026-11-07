// 交互探针：打开排行榜，点第一个「已关注」→ 取消关注 → 立刻读文字，验证不用刷新就变。
// 用法：node tools/probe-chip.js http://127.0.0.1:7788/
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const URL_BASE = process.argv[2] || 'http://127.0.0.1:7788/';
const PORT = 9333;
const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));
if (!EDGE) {
  console.error('找不到 msedge.exe');
  process.exit(1);
}

const profile = path.join(os.tmpdir(), 'danmu-chip-probe-' + Date.now());
const child = spawn(
  EDGE,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    'about:blank',
  ],
  { stdio: 'ignore' }
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {}
    await sleep(250);
  }
  throw new Error('连不上调试端口');
}

(async () => {
  const page = await targets();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const waiting = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) {
      const { resolve, reject } = waiting.get(m.id);
      waiting.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    }
  });
  const send = (method, params = {}, ms = 20000) =>
    new Promise((resolve, reject) => {
      const myId = ++id;
      waiting.set(myId, { resolve, reject });
      ws.send(JSON.stringify({ id: myId, method, params }));
      setTimeout(() => {
        if (waiting.has(myId)) {
          waiting.delete(myId);
          reject(new Error(method + ' 超时'));
        }
      }, ms);
    });
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || '页面脚本报错');
    return r.result.value;
  };

  await send('Page.enable');
  await send('Page.navigate', { url: URL_BASE + '#board' });
  await sleep(6000);

  const before = await evaluate(`
    (() => {
      const b = document.querySelector('.follow-chip[data-uid]');
      return b ? { uid: b.dataset.uid, text: b.textContent, on: b.classList.contains('on') } : null;
    })()
  `);
  console.log('点之前:', JSON.stringify(before));

  if (!before) {
    console.error('榜单里没有关注按钮');
    process.exit(2);
  }

  // 只测「已关注 → 取消」这条路径（用户报的就是它）
  if (before.on) {
    await evaluate(`document.querySelector('.follow-chip[data-uid]').click()`);
    await sleep(800);
    const confirmStep = await evaluate(`
      (() => {
        const dlg = document.querySelector('.modal-mask .modal');
        if (!dlg) return 'no-modal';
        const ok = [...dlg.querySelectorAll('button')].find((b) => b.textContent.trim() === '取消关注');
        if (!ok) return 'no-button';
        ok.click();
        return 'clicked';
      })()
    `);
    console.log('确认弹窗:', confirmStep);
    await sleep(1500);
    const after = await evaluate(`
      (() => {
        const b = document.querySelector('.follow-chip[data-uid]');
        return { text: b.textContent, on: b.classList.contains('on') };
      })()
    `);
    console.log('点之后（未刷新）:', JSON.stringify(after));
    const ok = after.text.includes('＋关注') && !after.on;
    console.log(ok ? '✓ 取关后按钮立刻变了，不用刷新' : '✗ 仍然是旧状态');
  } else {
    console.log('第一个不是已关注，跳过（当前没有已关注用户上榜？）');
  }

  ws.close();
  child.kill();
  setTimeout(() => process.exit(0), 300);
})().catch((e) => {
  console.error('探针失败:', e.message);
  child.kill();
  process.exit(1);
});
