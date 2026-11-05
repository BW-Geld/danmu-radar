'use strict';

/**
 * 断网观测：等 WS 掉线 → 重连 → 补发，把四个计数的变化逐条打出来。
 * 用法：node tools/watch-drop.js [秒数]
 */

const http = require('node:http');

const SECONDS = Number(process.argv[2]) || 180;

function get(path) {
  return new Promise((res, rej) => {
    const req = http.get({ host: '127.0.0.1', port: 7788, path, timeout: 4000 }, (r) => {
      let b = '';
      r.on('data', (c) => (b += c));
      r.on('end', () => {
        try {
          res(JSON.parse(b));
        } catch {
          rej(new Error('bad json'));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', rej);
  });
}

const t0 = Date.now();
let prev = null;

(async () => {
  while (Date.now() - t0 < SECONDS * 1000) {
    let s;
    try {
      s = await get('/api/stats');
    } catch (err) {
      console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] 本机接口不可用：${err.message}`);
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    const r = s.runtime || {};
    const cur = {
      late: r.lateFrames,
      replay: r.replayDropped,
      dropped: r.dropped,
      dupes: r.dupesStored,
      flood: r.floodKept,
      total: s.total,
      buf: r.buffered,
    };
    const changed = !prev || Object.keys(cur).some((k) => cur[k] !== prev[k]);
    if (changed) {
      const d = (k) => (prev ? `(+${cur[k] - prev[k]})` : '');
      console.log(
        `[${((Date.now() - t0) / 1000).toFixed(0)}s] total=${cur.total}${d('total')} ` +
          `late=${cur.late}${d('late')} replay=${cur.replay}${d('replay')} ` +
          `dropped=${cur.dropped}${d('dropped')} dupes=${cur.dupes}${d('dupes')} flood=${cur.flood}`
      );
      prev = cur;
    }
    await new Promise((r2) => setTimeout(r2, 2000));
  }
  console.log('观测结束');
})();
