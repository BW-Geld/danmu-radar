'use strict';

/**
 * 排行榜性能改动的回归：
 *   - 全部时间/全部房间的发言榜走用户索引，必须和 SQL 口径一致；
 *   - 用户索引里的 chat 统计不能把「进入直播间」等非聊天消息算进去；
 *   - 说法榜的 60 秒缓存要能命中，也要能被 fresh 绕过。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { Store } = require('../server/db');

const tmp = path.join(os.tmpdir(), `danmu-board-${Date.now()}.db`);
const store = new Store(tmp);
const BASE = 1800000000000;
const R1 = 900001;
const R2 = 900002;

function put(rid, uid, txt, cst, extra = {}) {
  return store.insertBatch([{
    rid,
    uid,
    txt,
    cst,
    kind: extra.kind || 'chat',
    nn: extra.nn || `u${uid}`,
    source: 'live',
    level: extra.level || 0,
  }]);
}

let passed = 0;
async function ok(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}\n  ${err.message}`);
    process.exitCode = 1;
  }
}

(async () => {
  // 101：3 条聊天；102：跨两个房间各 1 条；103：1 条；104：只有进入直播间
  put(R1, 101, '哈哈', BASE + 1000, { nn: '甲', level: 10 });
  put(R1, 101, '哈哈', BASE + 2000, { nn: '甲', level: 10 });
  put(R1, 101, '哈哈', BASE + 3000, { nn: '甲', level: 10 });
  put(R1, 102, '哈哈', BASE + 4000, { nn: '乙', level: 5 });
  put(R2, 102, '哈哈', BASE + 5000, { nn: '乙', level: 5 });
  put(R2, 103, '测试', BASE + 6000, { nn: '丙' });
  put(R1, 104, '进入了直播间', BASE + 7000, { kind: 'enter', nn: '丁' });
  put(R1, 104, '进入了直播间', BASE + 8000, { kind: 'enter', nn: '丁' });

  await store.warmUserIndex({ force: true });

  await ok('全部时间/全部房间的发言榜走索引，口径与聊天消息一致', () => {
    const rows = store.topSenders({ limit: 10 });
    assert.deepStrictEqual(rows.map((r) => [r.uid, r.n]), [['101', 3], ['102', 2], ['103', 1]]);
    const top = rows[0];
    assert.strictEqual(top.nn, '甲');
    assert.strictEqual(top.rooms, 1);
    assert.strictEqual(top.level, 10);
    assert.strictEqual(top.first, BASE + 1000);
    assert.strictEqual(top.last, BASE + 3000);
  });

  await ok('非聊天消息不进入发言榜', () => {
    const rows = store.topSenders({ limit: 10 });
    assert.ok(!rows.some((r) => r.uid === '104'), '104 只有 enter，不应上榜');
  });

  await ok('带时间范围的发言榜仍走 SQL，且与索引结果一致', () => {
    const rows = store.topSenders({ from: BASE - 1000, to: BASE + 10000, limit: 10 });
    assert.deepStrictEqual(rows.map((r) => [r.uid, r.n]), [['101', 3], ['102', 2], ['103', 1]]);
  });

  await ok('指定房间的发言榜只统计该房间', () => {
    const rows = store.topSenders({ rid: R1, limit: 10 });
    assert.deepStrictEqual(rows.map((r) => [r.uid, r.n]), [['101', 3], ['102', 1]]);
  });

  await ok('用户搜索仍保留原有口径，且不泄漏索引内部字段', () => {
    const rows = store.findUsers('', 10);
    assert.ok(rows.some((r) => r.uid === '104'), '104 虽只 enter，但 users 列表原来就包含它');
    assert.ok(!('chatN' in rows[0]), '接口结果不应带 chatN');
  });

  await ok('说法分组按房间拆开，并带回本房间最早的人', () => {
    const groups = store.groupByTerms(['哈哈'], { limit: 10 });
    const r1 = groups.find((g) => Number(g.rid) === R1);
    const r2 = groups.find((g) => Number(g.rid) === R2);
    assert.ok(r1 && r2, '两个房间应各有一组');
    assert.strictEqual(r1.firstUid, '101');
    assert.strictEqual(r1.firstNn, '甲');
    assert.strictEqual(r1.firstCst, BASE + 1000);
    assert.strictEqual(r2.firstUid, '102');
    assert.strictEqual(r2.firstCst, BASE + 5000);
  });

  // 说法榜：先建缓存，再插一条新消息，第二次应读到缓存；fresh 才重新统计
  put(R1, 101, '哈哈', BASE + 9000, { nn: '甲', level: 10 });
  put(R1, 102, '测试一下', BASE + 9100, { nn: '乙', level: 5 });
  const first = store.topPlusOne({ limit: 10 });
  const firstHaha = first.find((r) => r.phrase === '哈哈');
  assert.ok(firstHaha, '应该统计到哈哈');

  await ok('说法榜 60 秒内命中缓存', () => {
    put(R1, 103, '哈哈', BASE + 9200, { nn: '丙' });
    const cached = store.topPlusOne({ limit: 10 });
    const haha = cached.find((r) => r.phrase === '哈哈');
    assert.strictEqual(haha.n, firstHaha.n, '缓存内不应看到新插入的哈哈');
    assert.strictEqual(store._phraseCache.size, 1, '应只缓存一条参数组合');
  });

  await ok('fresh 绕过说法榜缓存并刷新结果', () => {
    const fresh = store.topPlusOne({ limit: 10, fresh: true });
    const haha = fresh.find((r) => r.phrase === '哈哈');
    assert.strictEqual(haha.n, firstHaha.n + 1, 'fresh 应看到新插入的哈哈');
  });

  store.close();
  try {
    fs.unlinkSync(tmp);
  } catch {
    /* ignore */
  }

  console.log(`\n${passed} 项通过${process.exitCode ? '（有失败）' : ''}`);
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});