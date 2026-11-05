'use strict';

/**
 * 协议层与存储层的单元测试：时间戳解析、弹幕去重、FTS5 能力。
 * 运行：node tools/test-protocol.js
 */

const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { toMs } = require('../server/douyu');
const { Store } = require('../server/db');

let pass = 0;
let fail = 0;

function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (err) {
    fail++;
    console.log(`✗ ${name}\n    ${err.message}`);
  }
}

// ---------- 1. 时间戳 ----------
const T = 1793783760; // 2026-11-04 前后的秒级时间戳
check('10 位字符串 = 秒', () => assert.strictEqual(toMs('1793783760'), T * 1000));
check('13 位字符串 = 毫秒', () => assert.strictEqual(toMs('1793783760068'), 1793783760068));
check('10 位数字 = 秒', () => assert.strictEqual(toMs(1793783760), T * 1000));
check('13 位数字 = 毫秒', () => assert.strictEqual(toMs(1793783760068), 1793783760068));
check('空值退回当前时间', () => {
  const now = Date.now();
  assert.ok(Math.abs(toMs('') - now) < 2000);
  assert.ok(Math.abs(toMs(undefined) - now) < 2000);
});
check('永远不产出 1970 年', () => {
  for (const v of ['0', 0, 'abc', null, '', '1793783760', 1793783760]) {
    assert.ok(toMs(v) > 1600000000000, `${v} → ${toMs(v)}`);
  }
});

// ---------- 2. 去重 ----------
const tmp = path.join(os.tmpdir(), `danmu-test-${Date.now()}.db`);
const store = new Store(tmp);
const row = {
  rid: 1,
  roomName: 't',
  uid: '42',
  nn: '张三',
  txt: '哈哈哈哈',
  cst: 1793783760068,
  kind: 'chat',
  source: 'live',
};

check('第一次写入入库', () => {
  const r = store.insertBatch([row]);
  assert.strictEqual(r.inserted, 1);
  assert.strictEqual(r.dupes, 0);
});
check('同一行的重复投递被忽略', () => {
  const r = store.insertBatch([row]);
  assert.strictEqual(r.inserted, 0);
  assert.strictEqual(r.dupes, 1);
});
check('同一个人同一毫秒发同样的话只算一条', () => {
  store.insertBatch([{ ...row, cst: row.cst + 1 }]);
  assert.strictEqual(store.stats().total, 2);
});
check('不同房间相同内容不互相吞掉', () => {
  store.insertBatch([{ ...row, rid: 2 }]);
  assert.strictEqual(store.stats().total, 3);
});
check('批量里夹带重复只写一次', () => {
  const r = store.insertBatch([{ ...row, cst: 999 }, { ...row, cst: 999 }, { ...row, cst: 999 }]);
  assert.strictEqual(r.inserted, 1);
  assert.strictEqual(r.dupes, 2);
});

// ---------- 3. 迁移幂等 ----------
check('重复打开同一个库不会重复迁移', () => {
  store.close();
  const again = new Store(tmp);
  assert.strictEqual(again.stats().total, 4);
  again.close();
});

// ---------- 4. 录播时间轴（sts/tl 与实时 cst 是两套语义，必须分开） ----------
const { toMessageRows } = require('../server/vod');

check('录播常规回放：cst = sts * 1000', () => {
  const rows = toMessageRows(
    { roomId: 1, title: 'x', uniformSts: false, baseTime: 0 },
    [{ ctt: '你好', uid: '1', sts: 1793460279, tl: 123000, nn: 'a' }]
  );
  assert.strictEqual(rows[0].cst, 1793460279000);
});
check('录播剪辑片段：cst = baseTime + tl（sts 全场同一值）', () => {
  const base = 1793460000000;
  const rows = toMessageRows(
    { roomId: 1, title: 'x', uniformSts: true, baseTime: base },
    [{ ctt: '你好', uid: '1', sts: 1793460279, tl: 123000, nn: 'a' }]
  );
  assert.strictEqual(rows[0].cst, base + 123000);
});
check('录播缺 sts 时退回 baseTime + tl，不写 1970', () => {
  const rows = toMessageRows(
    { roomId: 1, title: 'x', uniformSts: false, baseTime: 1793460000000 },
    [{ ctt: '你好', uid: '1', tl: 5000, nn: 'a' }]
  );
  assert.ok(rows[0].cst > 1600000000000);
});
check('录播行带 ext 与 source=vod', () => {
  const rows = toMessageRows(
    { showId: 'ABC123456789', roomId: 1, title: 'x', uniformSts: false, baseTime: 0 },
    [{ ctt: '你好', uid: '1', sts: 1793460279, tl: 0, nn: 'a', sid: 42 }]
  );
  assert.strictEqual(rows[0].source, 'vod');
  assert.ok(String(rows[0].ext).startsWith('vod:ABC123456789:'));
});

// ---------- 5. 重连补发的窗口去重 ----------
check('重连窗口内：同样内容第二次出现被当作补发', () => {
  const { Collector } = require('../server/collector');
  const c = new Collector({}, {});
  c.replayUntil.set(1, Date.now() + 60_000);
  const msg = { rid: 1, uid: 'u1', txt: '哈哈哈哈', cst: Date.now() };
  assert.strictEqual(c._isReplay({ ...msg }), false, '第一次应放行');
  assert.strictEqual(c._isReplay({ ...msg, cst: msg.cst + 7 }), true, '时间戳被重打也要拦住');
  assert.strictEqual(c.replayDropped, 1);
  clearInterval(c.timer);
});
check('窗口外：同一句话刷两次仍然放行', () => {
  const { Collector } = require('../server/collector');
  const c = new Collector({}, {});
  const msg = { rid: 2, uid: 'u2', txt: '666', cst: Date.now() };
  assert.strictEqual(c._isReplay({ ...msg }), false);
  assert.strictEqual(c._isReplay({ ...msg, cst: msg.cst + 3000 }), false, '正常连刷不能被误杀');
  clearInterval(c.timer);
});
check('窗口只作用于对应房间', () => {
  const { Collector } = require('../server/collector');
  const c = new Collector({}, {});
  c.replayUntil.set(1, Date.now() + 60_000);
  const msg = { rid: 1, uid: 'u3', txt: '来了', cst: Date.now() };
  c._isReplay({ ...msg });
  assert.strictEqual(c._isReplay({ ...msg, rid: 9 }), false);
  clearInterval(c.timer);
});

// ---------- 6. 弹幕潮：连发不误杀、被拦的连发要留档 ----------
check('弹幕潮（≥3 人复读同一句）时，重连窗口内不按补发丢弃', () => {
  const { Collector } = require('../server/collector');
  const c = new Collector({}, {});
  c.replayUntil.set(1, Date.now() + 60_000);
  const t = Date.now();
  for (const uid of ['a', 'b', 'c']) c._isReplay({ rid: 1, uid, txt: '666', cst: t });
  const again = c._isReplay({ rid: 1, uid: 'a', txt: '666', cst: t + 500 });
  assert.strictEqual(again, false, '弹幕潮期间不能删掉连发');
  assert.strictEqual(c.floodKept, 1);
  clearInterval(c.timer);
});
check('只有 1 个用户在刷时，重连窗口内仍按补发丢弃', () => {
  const { Collector } = require('../server/collector');
  const c = new Collector({}, {});
  c.replayUntil.set(2, Date.now() + 60_000);
  const t = Date.now();
  c._isReplay({ rid: 2, uid: 'solo', txt: '哈哈', cst: t });
  assert.strictEqual(c._isReplay({ rid: 2, uid: 'solo', txt: '哈哈', cst: t + 200 }), true);
  assert.strictEqual(c.replayDropped, 1);
  assert.strictEqual(c.dupes.length, 1, '被拦下的那条要进 dupes 缓冲');
  assert.strictEqual(c.dupes[0].reason, 'replay');
  assert.strictEqual(c.dupes[0].delta, 200);
  clearInterval(c.timer);
});
check('dupes 表写入与计数', () => {
  const file = path.join(os.tmpdir(), `dy-dupes-${process.pid}.db`);
  const s = new Store(file);
  s.open();
  const n = s.insertDupes([
    { rid: 1, uid: 'u1', txt: '666', cst: Date.now(), reason: 'replay', delta: 0 },
    { rid: 1, uid: 'u1', txt: '666', cst: Date.now(), reason: 'replay', delta: 12 },
  ]);
  assert.strictEqual(n, 2);
  assert.strictEqual(s.dupesCount(0), 2);
  s.close();
  fs.rmSync(file, { force: true });
  fs.rmSync(file + '-wal', { force: true });
  fs.rmSync(file + '-shm', { force: true });
});
// ---------- 7. FTS5 ----------
check('FTS5 trigram 对 ≥3 字的中文查询有效', () => {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE VIRTUAL TABLE t USING fts5(body, tokenize='trigram')");
  db.exec("INSERT INTO t(body) VALUES ('今天打野快上啊兄弟们')");
  const hit = db.prepare("SELECT body FROM t WHERE t MATCH '打野快'").all();
  assert.strictEqual(hit.length, 1);
  const miss = db.prepare("SELECT body FROM t WHERE t MATCH '打野'").all();
  assert.strictEqual(miss.length, 0, 'trigram 需要 ≥3 字符，2 字查询匹配不到');
  db.close();
});

fs.rmSync(tmp, { force: true, maxRetries: 3, retryDelay: 100 });
fs.rmSync(tmp + '-wal', { force: true, maxRetries: 3, retryDelay: 100 });
fs.rmSync(tmp + '-shm', { force: true, maxRetries: 3, retryDelay: 100 });

console.log(`\n${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
