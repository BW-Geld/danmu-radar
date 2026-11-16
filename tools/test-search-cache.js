'use strict';

/**
 * 检索/用户索引的三处加速不能改变结果：
 *   1) countSearchTerms 一次扫完的三路计数 = 原来三次 countByTerms；
 *   2) coverage(known) = 不带 known 的全表统计；
 *   3) findUsers 的内存索引 = 按 uid/昵称查得到同样的人；
 *   4) 同一条件第二次检索走缓存（cached=true, took=0）。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { Store } = require('../server/db');
const { normalize, keyOf } = require('../server/text');
const { search } = require('../server/analysis');

const tmp = path.join(os.tmpdir(), `danmu-search-cache-${Date.now()}.db`);
const store = new Store(tmp);
const R = 920001;
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

function put(uid, txt, cst, nn = `用户${uid}`) {
  store.insertBatch([{ rid: R, uid, txt, cst, kind: 'chat', nn }]);
}

put(1, '哈哈', 1000);
put(2, '哈哈', 2000);
put(3, '哈哈', 3000);
put(4, '哈哈哈', 4000);
put(5, '笑死', 5000);
put(6, '呵呵', 6000);
put(7, '缓存测试词xyz', 7000, '缓存用户');

const exact = keyOf('哈哈');
const syn = keyOf('呵呵');
const cooc = keyOf('笑死');

ok('三路计数与三次 countByTerms 一致', () => {
  const got = store.countSearchTerms({
    exact,
    synonyms: [syn],
    cooccur: [cooc],
  });
  assert.strictEqual(got.exact, store.countByTerms([exact]));
  assert.strictEqual(got.synonym, store.countByTerms([syn], { exclude: [exact] }));
  assert.strictEqual(got.cooccur, store.countByTerms([cooc], { exclude: [exact, syn] }));
  assert.strictEqual(got.exact, 4);
  assert.strictEqual(got.synonym, 1);
  assert.strictEqual(got.cooccur, 1);
});

const totals = store.userTotals(2);
ok('coverage 带 known 与全表统计结果一致', () => {
  const a = store.coverage({ from: Number(totals.first), to: Number(totals.last) });
  const b = store.coverage({ from: Number(totals.first), to: Number(totals.last), known: totals });
  assert.strictEqual(b.first, a.first);
  assert.strictEqual(b.last, a.last);
  assert.strictEqual(b.messages, a.messages);
  assert.strictEqual(b.spanMs, a.spanMs);
  assert.strictEqual(b.effectiveMs, a.effectiveMs);
});

ok('用户索引能按空查询/昵称/UID 查到同样的人', () => {
  const all = store.findUsers('', 20);
  assert.strictEqual(all.length, 7);
  assert.ok(all.some((u) => u.uid === '1'));
  assert.deepStrictEqual(store.findUsers('缓存用户', 5).map((u) => u.uid), ['7']);
  assert.deepStrictEqual(store.findUsers('7', 5).map((u) => u.uid), ['7']);
});

let first;
ok('首次检索不是缓存，第二次同条件命中缓存', () => {
  first = search(store, { q: '缓存测试词xyz', limit: 10, synonym: false, cooccur: false });
  const second = search(store, { q: '缓存测试词xyz', limit: 10, synonym: false, cooccur: false });
  assert.strictEqual(first.cached, undefined);
  assert.strictEqual(second.cached, true);
  assert.strictEqual(second.took, 0);
  assert.strictEqual(second.total, first.total);
  assert.strictEqual(second.groups.length, first.groups.length);
});

store.close();
try {
  fs.unlinkSync(tmp);
} catch {
  /* ignore */
}

console.log(`\n${passed} 项通过${process.exitCode ? '（有失败）' : ''}`);