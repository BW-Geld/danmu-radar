'use strict';

/**
 * 弹幕潮检测的两段式必须挡住两个反例，否则「跟风度」和「共现剔除」都不可信：
 *   1) 跨桶的潮：刷屏从第 8 秒延续到第 13 秒，两个 5 秒桶各自都不够阈值；
 *   2) 同一批人重复：两个桶各有 3 个不同用户，但其实是同 3 个人 —— distinct uid 不可跨桶相加。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { Store } = require('../server/db');
const { stem } = require('../server/text');

const tmp = path.join(os.tmpdir(), `danmu-flood-${Date.now()}.db`);
const store = new Store(tmp);

const BASE = 1800000000000; // 固定在 5000 的整数倍上，方便构造桶边界
function put(rid, uid, txt, cst, nn) {
  store.insertBatch([{ rid, uid, txt, cst, kind: 'chat', nn: nn || `u${uid}`, source: 'live' }]);
}

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

// ---------------------------------------------------------------- 用例 1：跨桶潮
const R1 = 900001;
const PHRASE1 = '雀巢黑咖影之刃零礼盒上市';
// 8 条、6 个人，从第 7 秒铺到第 12.9 秒：5 秒桶 [5000,10000) 拿 4 条，[10000,15000) 拿 4 条
const users1 = [11, 12, 13, 14, 15, 16];
for (let i = 0; i < 8; i++) {
  put(R1, users1[i % 6], PHRASE1, BASE + 7000 + i * 800);
}
let r1 = store.rebuildFloods({ rid: R1, since: BASE - 60000, minUsers: 3, minCount: 6 });
const ev1 = store.listFloods({ rid: R1, limit: 10 });

ok('跨桶潮必须被检出', () => {
  assert.strictEqual(r1.events, 1, `应检出 1 个事件，实际 ${r1.events}`);
  assert.strictEqual(ev1.length, 1);
  assert.strictEqual(ev1[0].phrase, PHRASE1);
});
ok('跨桶潮的条数与人数按整段精确统计（不重复计窗口）', () => {
  assert.strictEqual(Number(ev1[0].msg_count), 8);
  assert.strictEqual(Number(ev1[0].user_count), 6);
});
ok('潮事件带主题分类', () => {
  assert.ok(ev1[0].topic, '应有 topic');
});

// ---------------------------------------------------------------- 用例 2：同一批人重复
const R2 = 900002;
const PHRASE2 = '这波操作真的可以';
// 3 个人 × 4 条，横跨两个 5 秒桶：每桶都是这 3 个人
for (let i = 0; i < 4; i++) {
  for (const u of [21, 22, 23]) {
    put(R2, u, PHRASE2, BASE + 1000 + i * 5000 + u - 21);
  }
}
// 阈值 4 人：真实只有 3 人，若把两个桶的 distinct 相加会得到 6，误判为潮
store.rebuildFloods({ rid: R2, since: BASE - 60000, minUsers: 4, minCount: 6 });
const ev2 = store.listFloods({ rid: R2, limit: 10 });

ok('同一批人连刷不得被判成多人跟风（distinct uid 不可跨桶相加）', () => {
  assert.strictEqual(ev2.length, 0, `应判不出潮，实际 ${ev2.length} 个`);
});

// ---------------------------------------------------------------- 用例 3：首发按房间隔离
const RA = 900011;
const RB = 900012;
const PHRASE3 = '这把稳了别慌';
put(RA, 31, PHRASE3, BASE + 200000);
put(RB, 41, PHRASE3, BASE + 100000);
put(RB, 42, PHRASE3, BASE + 150000);

ok('首发按房间隔离：两个房间各自算自己的最早', () => {
  const a = store.originOf(PHRASE3, { rid: RA });
  const b = store.originOf(PHRASE3, { rid: RB });
  assert.strictEqual(String(a.first.uid), '31');
  assert.strictEqual(String(b.first.uid), '41');
  assert.strictEqual(a.plusOne, 0);
  assert.strictEqual(b.plusOne, 1);
});
ok('不过滤房间时能看到跨房间的全貌', () => {
  const all = store.originOf(PHRASE3, { rid: 0 });
  assert.strictEqual(all.total, 3);
  assert.strictEqual(all.rooms.length, 2);
  assert.strictEqual(String(all.first.uid), '41');
});

// ---------------------------------------------------------------- 用例 4：stem 折叠
ok('stem 折叠重复字符但保留叠词', () => {
  assert.strictEqual(stem('哈哈哈哈哈'), '哈哈');
  assert.strictEqual(stem('妈妈'), '妈妈');
  assert.strictEqual(stem('好的吧'), '好的');
});
ok('stem 把不同长度的复读归成同一个 key', () => {
  assert.strictEqual(stem('哈哈哈哈'), stem('哈哈哈哈哈'));
  assert.strictEqual(store.originOf('这句从没出现过', { rid: 900013 }).total, 0);
});

// ---------------------------------------------------------------- 用例 5：跟风度走事件表
const R3 = 900003;
const PH = '口令礼盒刷起来';
for (let i = 0; i < 9; i++) put(R3, [51, 52, 53, 54][i % 4], PH, BASE + 300000 + i * 700);
store.rebuildFloods({ rid: R3, since: BASE - 60000, minUsers: 3, minCount: 6 });
const share = store.floodShare('51');

ok('跟风度用事件表 join 算出（不再逐条子查询）', () => {
  assert.ok(share.total >= 2, `应有发言，实际 ${share.total}`);
  assert.ok(share.inFlood >= 2, `应落在潮里，实际 ${share.inFlood}`);
});

// ---------------------------------------------------------------- 用例 6：所有长度都要能查、能算潮
const R4 = 900004;
// 一个字
put(R4, 61, '牛', BASE + 400000);
put(R4, 62, '牛', BASE + 405000);
put(R4, 63, '牛', BASE + 410000);
// 纯表情：归一化后什么都不剩，也必须留下可检索的键
put(R4, 71, '🐒', BASE + 500000);
put(R4, 72, '🐒', BASE + 500400);
put(R4, 73, '🐒', BASE + 500800);
put(R4, 74, '🐒', BASE + 501200);
put(R4, 75, '🐒', BASE + 501600);
put(R4, 76, '🐒', BASE + 502000);

ok('单字弹幕同样能查首发与 +1 次数', () => {
  const o = store.originOf('牛', { rid: R4 });
  assert.strictEqual(o.total, 3);
  assert.strictEqual(o.plusOne, 2);
  assert.strictEqual(String(o.first.uid), '61');
});

ok('纯表情弹幕不会被归一化抹掉，仍可检索', () => {
  const rows = store.searchMessages(['🐒'], { rid: R4, limit: 10 });
  assert.strictEqual(rows.length, 6, `应召回 6 条，实际 ${rows.length}`);
});

ok('纯表情刷屏也能算成弹幕潮', () => {
  store.rebuildFloods({ rid: R4, since: BASE - 60000, minUsers: 3, minCount: 6 });
  const evs = store.listFloods({ rid: R4, limit: 10 });
  const emoji = evs.find((e) => e.phrase === '🐒');
  assert.ok(emoji, '表情潮应被检出');
  assert.strictEqual(Number(emoji.msg_count), 6);
  assert.strictEqual(Number(emoji.user_count), 6);
});

// ---------------------------------------------------------------- 清理
store.close();
try {
  fs.unlinkSync(tmp);
} catch {
  /* ignore */
}

console.log(`\n${passed} 项通过${process.exitCode ? '（有失败）' : ''}`);
