'use strict';

/**
 * 采集缺口（gaps）的记账规则：
 *   1) 抖动不留痕：短于 10 秒的空档不写表，否则时间轴全是碎片；
 *   2) 连续抖动要合并：相邻两条缺口合成一条，重试次数累加；
 *   3) 缺口要能从「采集时长」里扣掉：否则画像会把「没采到」算成「没说话」；
 *   4) 缺口被录播补上后（filled_by），不再计入盲区。
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { Store } = require('../server/db');

const tmp = path.join(os.tmpdir(), `danmu-gap-${Date.now()}.db`);
const store = new Store(tmp);

const RID = 700001;
const T0 = 1800000000000;

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

// 造两条消息，中间留出可测的跨度
function put(rid, uid, txt, cst) {
  store.insertBatch([{ rid, uid, txt, cst, kind: 'chat', nn: `u${uid}`, source: 'live' }]);
}

put(RID, 1, '开头', T0);
put(RID, 2, '结尾', T0 + 3600000); // 跨度 60 分钟

ok('短于 10 秒的抖动不写表', () => {
  const g = store.addGap({ rid: RID, from: T0 + 1000, to: T0 + 4000, retries: 1 });
  if (g !== null) throw new Error(`应当丢弃，却返回 ${JSON.stringify(g)}`);
  const t = store.gapTotal({ rid: RID });
  if (t.count !== 0) throw new Error(`缺口数应为 0，实际 ${t.count}`);
});

ok('超过 10 秒的缺口要入账', () => {
  const g = store.addGap({ rid: RID, from: T0 + 10000, to: T0 + 40000, retries: 2 });
  if (!g || g.merged) throw new Error('应当新建一条');
  if (g.durMs !== 30000) throw new Error(`时长应为 30000，实际 ${g.durMs}`);
  const row = store.listGaps({ rid: RID })[0];
  if (Number(row.retries) !== 2) throw new Error(`重试次数应为 2，实际 ${row.retries}`);
});

ok('相邻缺口合并成一条，重试次数累加', () => {
  // 与上一条只隔 5 秒（< mergeMs=10s）→ 合并
  const g = store.addGap({ rid: RID, from: T0 + 45000, to: T0 + 75000, retries: 3 });
  if (!g || !g.merged) throw new Error('应当合并到上一条');
  const list = store.listGaps({ rid: RID });
  if (list.length !== 1) throw new Error(`应仍为 1 条，实际 ${list.length}`);
  const row = list[0];
  if (Number(row.from_cst) !== T0 + 10000) throw new Error('起点应保持最早的');
  if (Number(row.to_cst) !== T0 + 75000) throw new Error('终点应延伸到最后一次');
  if (Number(row.retries) !== 5) throw new Error(`重试次数应为 5，实际 ${row.retries}`);
  if (Number(row.dur_ms) !== 65000) throw new Error(`时长应为 65000，实际 ${row.dur_ms}`);
});

ok('相距很远的缺口各自独立', () => {
  store.addGap({ rid: RID, from: T0 + 600000, to: T0 + 660000, retries: 1 });
  const list = store.listGaps({ rid: RID });
  if (list.length !== 2) throw new Error(`应为 2 条，实际 ${list.length}`);
});

ok('coverage 把缺口从跨度里扣掉', () => {
  const c = store.coverage({ rid: RID });
  if (c.spanMs !== 3600000) throw new Error(`跨度应为 3600000，实际 ${c.spanMs}`);
  // 缺口 65 秒 + 60 秒 = 125 秒
  const expectGap = 65000 + 60000;
  if (c.gapMs !== expectGap) throw new Error(`缺口应为 ${expectGap}，实际 ${c.gapMs}`);
  if (c.effectiveMs !== c.spanMs - expectGap) throw new Error('有效时长 = 跨度 − 缺口');
  if (c.messages !== 2) throw new Error(`消息数应为 2，实际 ${c.messages}`);
});

ok('被录播补上的缺口不再算盲区', () => {
  store.markGapFilled(RID, T0 + 650000, T0 + 660000, 'r90XWgRkpjwMgk25');
  const t = store.gapTotal({ rid: RID });
  if (t.count !== 1) throw new Error(`未填充缺口应为 1，实际 ${t.count}`);
  const all = store.gapTotal({ rid: RID, includeFilled: true });
  if (all.count !== 2) throw new Error(`全部缺口应为 2，实际 ${all.count}`);
  const c = store.coverage({ rid: RID });
  if (c.gapMs !== 65000) throw new Error(`有效缺口应为 65000，实际 ${c.gapMs}`);
});

ok('缺口按房间隔离', () => {
  const other = store.gapTotal({ rid: 999999 });
  if (other.count !== 0) throw new Error('别的房间不该看到这条缺口');
});

ok('停机缺口标 reason=downtime，和重连缺口分开', () => {
  const g = store.addGap({
    rid: RID,
    from: T0 + 7200000,
    to: T0 + 7260000,
    reason: 'downtime',
  });
  if (!g || g.reason !== 'downtime') throw new Error(`reason 应为 downtime，实际 ${g && g.reason}`);
  const list = store.listGaps({ rid: RID });
  const row = list.find((x) => Number(x.from_cst) === T0 + 7200000);
  if (!row) throw new Error('没写进去');
  if (row.reason !== 'downtime') throw new Error(`库里 reason 应为 downtime，实际 ${row.reason}`);
  const reconnect = list.find((x) => Number(x.from_cst) === T0 + 10000);
  if (reconnect.reason !== 'reconnect') throw new Error('重连缺口不该被改成 downtime');
});

ok('lastMessageAt 取该房间最后一条聊天时间', () => {
  const t = store.lastMessageAt(RID);
  if (t !== T0 + 3600000) throw new Error(`应为 ${T0 + 3600000}，实际 ${t}`);
  if (store.lastMessageAt(999999) !== 0) throw new Error('空房间应返回 0');
});

console.log(`\n${passed}/9 通过`);
store.close();
try {
  fs.unlinkSync(tmp);
  fs.unlinkSync(tmp + '-wal');
} catch {
  /* 忽略清理失败 */
}
