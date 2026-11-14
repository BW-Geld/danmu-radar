'use strict';

/**
 * 收藏夹排序的底座：
 *   1) hits / users / plusOne 口径（plusOne = 同说法条数 − 1）；
 *   2) 空 stem 的老数据仍能按 txt 回退命中；
 *   3) 列表不再只返回 200 条 —— 否则「按收藏时间正序」在第 201 条起就是错的。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { Store } = require('../server/db');
const { stem } = require('../server/text');

const tmp = path.join(os.tmpdir(), `danmu-fav-${Date.now()}.db`);
const store = new Store(tmp);
const R = 910001;
let passed = 0;

function ok(name, fn) {
  try {
    fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}\n  ${err.message}`);
    process.exitCode = 1;
  }
}

function put(rid, uid, txt, cst) {
  store.insertBatch([{ rid, uid, txt, cst, kind: 'chat', nn: `u${uid}` }]);
}

const A = '收藏排序测试句甲';
const B = '收藏排序测试句乙';
put(R, 1, A, 1000);
put(R, 2, A, 2000);
put(R, 3, A, 3000);
put(R, 4, B, 4000);

const fa = store.addFavorite({ rid: R, stem: stem(A), txt: A, roomName: '测试房' });
const fb = store.addFavorite({ rid: R, stem: stem(B), txt: B, roomName: '测试房' });
store.db.prepare('UPDATE favorites SET created_at = ? WHERE id = ?').run(1000, fa.id);
store.db.prepare('UPDATE favorites SET created_at = ? WHERE id = ?').run(2000, fb.id);

const list = store.listFavorites({ rid: R });
const gotA = list.find((x) => x.stem === stem(A));
const gotB = list.find((x) => x.stem === stem(B));

ok('收藏列表返回 hits / users / plusOne', () => {
  assert.ok(gotA, '应能查到收藏 A');
  assert.strictEqual(Number(gotA.hits), 3);
  assert.strictEqual(Number(gotA.users), 3);
  assert.strictEqual(Number(gotA.plusOne), 2);
});

ok('plusOne 是 hits − 1，不是直接等于条数', () => {
  assert.strictEqual(Number(gotB.hits), 1);
  assert.strictEqual(Number(gotB.plusOne), 0);
});

ok('服务端默认按收藏时间倒序', () => {
  assert.strictEqual(Number(list[0].id), Number(fb.id));
});

// 空 stem 的老数据：收藏的是说法，查询要退回 txt
const E1 = '空 stem 说法一号';
const E2 = '空 stem 说法二号';
put(R, 5, E1, 5000);
put(R, 6, E1, 6000);
put(R, 7, E2, 7000);
store.db.prepare('UPDATE messages SET stem = ? WHERE txt = ?').run('', E1);
store.db.prepare('UPDATE messages SET stem = ? WHERE txt = ?').run('', E2);
store.addFavorite({ rid: R, stem: E1, txt: E1 });
store.addFavorite({ rid: R, stem: E2, txt: E2 });

const el = store.listFavorites({ rid: R });
const e1 = el.find((x) => x.stem === E1);
const e2 = el.find((x) => x.stem === E2);

ok('空 stem 回退 txt 命中，且不把另一种说法混进来', () => {
  assert.ok(e1 && e2, '应能查到两条空 stem 收藏');
  assert.strictEqual(Number(e1.hits), 2);
  assert.strictEqual(Number(e1.users), 2);
  assert.strictEqual(Number(e1.plusOne), 1);
  assert.strictEqual(Number(e2.hits), 1);
  assert.strictEqual(Number(e2.plusOne), 0);
});

// 第 201 条必须还在：排序需要全量，200 条硬上限会让正序从中间开始
const R2 = 910002;
for (let i = 0; i < 205; i++) {
  store.addFavorite({ rid: R2, stem: `批量收藏-${i}`, txt: `批量收藏-${i}` });
}
const all = store.listFavorites({ rid: R2 });

ok('收藏列表不再截断到 200 条', () => {
  assert.strictEqual(all.length, 205, `应返回 205 条，实际 ${all.length}`);
  assert.ok(all.every((x) => Number(x.plusOne) === 0), '没有弹幕的收藏 plusOne 应为 0');
});

store.close();
try {
  fs.unlinkSync(tmp);
} catch {
  /* ignore */
}

console.log(`\n${passed} 项通过${process.exitCode ? '（有失败）' : ''}`);