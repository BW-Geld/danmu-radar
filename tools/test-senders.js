'use strict';

/**
 * 「谁在发」是跨房间查说法：不能带 rid 前缀的索引，也不能用 COALESCE 表达式
 * （SQLite 用不上索引会全表扫）。这里守住三个语义：
 *   1) 正常 stem 命中，跨房间合并；
 *   2) 老数据 stem 为空时回退到 txt；
 *   3) 空 stem 的回退不能把别的说法算进来。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { Store } = require('../server/db');

const tmp = path.join(os.tmpdir(), `danmu-senders-${Date.now()}.db`);
const store = new Store(tmp);
const BASE = 1800000000000;
let tick = 0;
function put(rid, uid, txt) {
  store.insertBatch([
    { rid, uid, txt, cst: BASE + tick++, kind: 'chat', nn: `u${uid}`, source: 'live' },
  ]);
}
const sum = (rows) => rows.reduce((n, r) => n + Number(r.n), 0);

const P = '跨房间测试句';
put(900101, 1, P);
put(900101, 2, P);
put(900102, 3, P);

const all = store.sendersOfStem(P);
assert.strictEqual(all.length, 3, '跨房间应合并成 3 个人');
assert.strictEqual(sum(all), 3);

const room1 = store.sendersOfStem(P, { rid: 900101 });
assert.strictEqual(room1.length, 2, '带 rid 只应看到该房间的 2 个人');
assert.strictEqual(sum(room1), 2);

const Q = '空stem测试句';
put(900101, 4, Q);
put(900101, 5, Q);
store.db.prepare('UPDATE messages SET stem = ? WHERE txt = ?').run('', Q);

const q = store.sendersOfStem(Q);
assert.strictEqual(q.length, 2, '空 stem 必须回退到 txt');
assert.strictEqual(sum(q), 2);

// 另一个空 stem 的说法不能混进来
const R = '另一个空stem句';
put(900101, 6, R);
store.db.prepare('UPDATE messages SET stem = ? WHERE txt = ?').run('', R);
assert.strictEqual(store.sendersOfStem(Q).length, 2, '空 stem 回退只能命中同一个 txt');

store.close();
try {
  fs.unlinkSync(tmp);
} catch {
  /* ignore */
}
console.log('✓ sendersOfStem：跨房间合并 / rid 隔离 / 空 stem 回退 / 不串说法');