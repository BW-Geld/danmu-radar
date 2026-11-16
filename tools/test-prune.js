'use strict';

/** 保留策略分批删除：超过 5000 条也要删干净，缓存要跟着失效。 */

const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { Store } = require('../server/db');

(async () => {
  const tmp = path.join(os.tmpdir(), `danmu-prune-${Date.now()}.db`);
  const store = new Store(tmp);
  store.open();

  const now = Date.now();
  const old = now - 3 * 86400000;
  const rows = [];
  for (let i = 0; i < 5001; i++) {
    rows.push({ rid: 1, uid: 1, txt: `旧弹幕${i}`, cst: old + i, kind: 'chat', source: 'live' });
  }
  rows.push({ rid: 1, uid: 1, txt: '新弹幕A', cst: now - 1000, kind: 'chat', source: 'live' });
  rows.push({ rid: 1, uid: 1, txt: '新弹幕B', cst: now - 900, kind: 'chat', source: 'live' });
  store.insertBatch(rows);
  assert.equal(store.stats({ fresh: true }).total, 5003);

  const removed = await store.prune(1);
  assert.equal(removed, 5001, `应删 5001 条，实际 ${removed}`);
  assert.equal(store.stats().total, 2, '缓存应已失效，只剩 2 条');

  store.close();
  require('node:fs').rmSync(tmp, { force: true });
  console.log('✓ prune 分批删除 / 统计缓存失效 2 项通过');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});