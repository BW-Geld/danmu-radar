'use strict';

/** /api/stats 的 30 秒缓存：缓存期内不重算，fresh 与 invalidateStats 能拿到新数字。 */

const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { Store } = require('../server/db');

const tmp = path.join(os.tmpdir(), `danmu-stats-${Date.now()}.db`);
const store = new Store(tmp);
store.open();

const base = Date.now() - 1000;
const row = (cst) => ({
  rid: 1,
  uid: 1,
  txt: '缓存测试',
  cst,
  kind: 'chat',
  source: 'live',
});

store.insertBatch([row(base)]);
const first = store.stats();
assert.equal(first.total, 1);
assert.ok(first.dbBytes > 0, 'dbBytes 有值');

store.insertBatch([row(base + 1)]);
const cached = store.stats();
assert.equal(cached.total, 1, '缓存期内应返回旧总数');

const fresh = store.stats({ fresh: true });
assert.equal(fresh.total, 2, 'fresh 应强制重算');

store.invalidateStats();
assert.equal(store.stats().total, 2, 'invalidate 后应立即重算');

store.close();
require('node:fs').rmSync(tmp, { force: true });
console.log('✓ stats 缓存 / fresh / invalidateStats 4 项通过');