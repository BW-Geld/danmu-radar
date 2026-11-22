'use strict';

/**
 * 用户名不是身份，UID 才是。这里锁三件事：
 *   1) 用户索引显示最近一次使用的昵称，而不是 MAX(nn) 的字典序最大名；
 *   2) 画像能列出曾用名及各自的时间范围；
 *   3) 搜索候选按「完全同名优先」排序，limit=0 返回全部、正数 limit 生效。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { Store } = require('../server/db');
const { profile } = require('../server/analysis');

const tmp = path.join(os.tmpdir(), `danmu-user-names-${Date.now()}.db`);
const store = new Store(tmp);
const BASE = 1800000000000;

function put(uid, nn, txt, cst, level = 1) {
  store.insertBatch([{ rid: 900001, uid, nn, txt, cst, level, kind: 'chat', source: 'live' }]);
}

// UID 100：旧名「旧昵称甲」→ 新名「新昵称乙」
put('100', '旧昵称甲', '旧名发言', BASE);
put('100', '旧昵称甲', '旧名发言 2', BASE + 1000);
put('100', '新昵称乙', '新名发言', BASE + 2000);
put('100', '新昵称乙', '新名发言 2', BASE + 3000);
// UID 200：完全同名，但发言更多，用来验证完全同名优先于发言量
put('200', '旧昵称甲', '同名但更多 1', BASE + 4000);
put('200', '旧昵称甲', '同名但更多 2', BASE + 5000);
put('200', '旧昵称甲', '同名但更多 3', BASE + 6000);
// UID 300：模糊匹配
put('300', '旧昵称甲粉丝', '模糊匹配', BASE + 7000);
// UID 401-420：20 个模糊匹配，用来验证 limit=0 返回全部、limit=15 只给 15 个
for (let i = 1; i <= 20; i++) {
  put(String(400 + i), `候补${String(i).padStart(2, '0')}`, `候补发言 ${i}`, BASE + 8000 + i * 1000);
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

ok('用户索引显示最近使用的昵称', () => {
  const list = store.findUsers('新昵称', 15);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].uid, '100');
  assert.strictEqual(list[0].nn, '新昵称乙');
  assert.strictEqual(list[0].level, 1);
});

ok('完全同名优先于发言量', () => {
  const list = store.findUsers('旧昵称甲', 15);
  assert.strictEqual(list[0].uid, '200');
  assert.strictEqual(list[0].nn, '旧昵称甲');
  assert.ok(list.some((u) => u.uid === '300'));
  // 100 已改名为「新昵称…」，当前按当前昵称检索，旧名不参与匹配
  assert.ok(!list.some((u) => u.uid === '100'));
});

ok('limit 生效且截断', () => {
  assert.strictEqual(store.findUsers('旧昵称甲', 1).length, 1);
});

ok('limit=0 返回全部候选，limit=15 只给 15 个', () => {
  assert.strictEqual(store.findUsers('候补', 0).length, 20);
  assert.strictEqual(store.findUsers('候补', 15).length, 15);
});

ok('曾用名按最近使用倒序并带时间范围', () => {
  const names = store.userNames('100', 12);
  assert.strictEqual(names.length, 2);
  assert.strictEqual(names[0].nn, '新昵称乙');
  assert.strictEqual(names[1].nn, '旧昵称甲');
  assert.strictEqual(Number(names[1].n), 2);
  assert.ok(Number(names[1].first) < Number(names[1].last));
});

ok('画像当前名 + 曾用名结构', () => {
  const p = profile(store, '100');
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.currentName, '新昵称乙');
  assert.strictEqual(p.names[0], '新昵称乙');
  assert.ok(p.nameHistory.some((x) => x.nn === '旧昵称甲'));
});

ok('latestName 不按字典序取', () => {
  assert.strictEqual(store.latestName('100'), '新昵称乙');
});

try {
  store.close();
} catch {}
try {
  fs.unlinkSync(tmp);
} catch {}

console.log(`\n${passed}/7 通过`);
if (process.exitCode) process.exit(process.exitCode);