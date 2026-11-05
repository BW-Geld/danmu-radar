'use strict';

/**
 * 挂机观测：每分钟采样 /api/stats，记录内存、WAL、缓冲、去重丢弃数。
 * 用法：node tools/soak.js http://127.0.0.1:7788 [分钟数]
 * 输出：data/soak.log（追加），结束后打印首末对比。
 */

const fs = require('node:fs');
const path = require('node:path');

const BASE = process.argv[2] || 'http://127.0.0.1:7788';
const MINUTES = Number(process.argv[3]) || 120;
const LOG = path.join(__dirname, '..', 'data', 'soak.log');

const mb = (n) => (n / 1048576).toFixed(1) + 'MB';

function line(s) {
  fs.appendFileSync(LOG, s + '\n');
  console.log(s);
}

async function sample(i) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/stats`);
  const s = await res.json();
  const r = s.runtime || {};
  const ms = Date.now() - t0;
  line(
    [
      new Date().toISOString().slice(11, 19),
      `#${i}`,
      `total=${s.total}`,
      `today=${s.today}`,
      `rss=${mb(r.rssBytes || 0)}`,
      `heap=${mb(r.heapUsed || 0)}`,
      `wal=${mb(r.walBytes || 0)}`,
      `buf=${r.buffered ?? '?'}`,
      `dup=${r.dropped ?? '?'}`,
      `replay=${r.replayDropped ?? '?'}`,
      `late=${r.lateFrames ?? '?'}`,
      `sse=${r.sseClients ?? '?'}`,
      `api=${ms}ms`,
    ].join(' ')
  );
  return s;
}

(async () => {
  line(`\n=== soak start ${new Date().toISOString()} ${BASE} ${MINUTES}min ===`);
  const first = await sample(0);
  for (let i = 1; i < MINUTES; i++) {
    await new Promise((r) => setTimeout(r, 60_000));
    try {
      await sample(i);
    } catch (err) {
      line(`${new Date().toISOString().slice(11, 19)} #${i} 采样失败 ${err.message}`);
    }
  }
  const last = await sample(MINUTES);
  const f = first.runtime || {};
  const l = last.runtime || {};
  line(
    `=== soak end 内存 ${mb(f.rssBytes || 0)} → ${mb(l.rssBytes || 0)}，` +
      `WAL ${mb(f.walBytes || 0)} → ${mb(l.walBytes || 0)}，` +
      `弹幕 ${first.total} → ${last.total}，重复丢弃 ${f.dropped || 0} → ${l.dropped || 0} ===`
  );
})();
