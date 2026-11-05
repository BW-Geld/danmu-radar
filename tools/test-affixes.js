'use strict';

/**
 * 口癖前后缀折叠的边界：
 *   1) 「…desuwa」「…喵」要并到同一句，否则「被 +1」永远统计不出来；
 *   2) 但不能把 new 剥成 ne（单字母不做后缀），也不能把「喵」剥成空；
 *   3) 配置持久化 + 历史重算，否则只有新弹幕生效，同一句话会停在两个 stem 上。
 */

const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { Store } = require('../server/db');
const { stripAffixes, setAffixes, stemOf } = require('../server/text');

let passed = 0;
let failed = 0;
function ok(name, fn) {
  try {
    fn();
    passed++;
    console.log('✓ ' + name);
  } catch (err) {
    failed++;
    console.log('✗ ' + name + ' — ' + err.message);
  }
}

// --- 纯函数 ---------------------------------------------------------------

setAffixes({ prefixes: [], suffixes: ['desuwa', '喵'] });

ok('后缀 desuwa 被剥掉', () => {
  assert.equal(stripAffixes('绝不认输desuwa'), '绝不认输');
});

ok('中文后缀同样生效', () => {
  assert.equal(stripAffixes('这也太真实了喵'), '这也太真实了');
});

ok('剥完只剩一个字就不剥', () => {
  assert.equal(stripAffixes('喵'), '喵');
  assert.equal(stripAffixes('好喵'), '好喵');
});

ok('没配置的口癖不动', () => {
  assert.equal(stripAffixes('绝不认输nya'), '绝不认输nya');
});

setAffixes({ prefixes: ['草'], suffixes: ['w'] });

ok('单字母后缀不生效（new 不能变 ne）', () => {
  assert.equal(stripAffixes('new'), 'new');
});

ok('前缀可剥、且剥完至少剩两个字', () => {
  assert.equal(stripAffixes('草 这也能输'), '这也能输');
  assert.equal(stripAffixes('草好'), '草好');
});

setAffixes({ prefixes: [], suffixes: ['desuwa'] });

ok('回覆前缀与口癖可以叠加', () => {
  assert.equal(stemOf('@小明: 绝不认输desuwa'), stemOf('绝不认输'));
});

// --- 落库与重算 -----------------------------------------------------------

const tmp = path.join(os.tmpdir(), `danmu-affix-${Date.now()}.db`);
const store = new Store(tmp);
store.open();
setAffixes({ prefixes: [], suffixes: [] }); // 模拟"用户还没配置"的初始状态

const rows = [
  { rid: 1, uid: 10, txt: '绝不认输', cst: 1800000000000, kind: 'chat', nn: 'a', source: 'live' },
  { rid: 1, uid: 11, txt: '绝不认输desuwa', cst: 1800000001000, kind: 'chat', nn: 'b', source: 'live' },
  { rid: 1, uid: 12, txt: '@a: 绝不认输desuwa', cst: 1800000002000, kind: 'chat', nn: 'c', source: 'live' },
];
store.insertBatch(rows);

ok('未配置时「绝不认输」与「…desuwa」是两个说法', () => {
  const g = store.groupByTerms(['绝不认输']);
  assert.ok(g.length >= 2, `应当至少两组，实际 ${g.length}`);
});

const res = store.applyAffixes({ prefixes: [], suffixes: ['desuwa'] });

ok('applyAffixes 会重算历史并返回改动数', () => {
  assert.ok(res.changed >= 1, `changed=${res.changed}`);
  assert.deepEqual(res.suffixes, ['desuwa']);
});

ok('重算后三句话并成一组', () => {
  const g = store.groupByTerms(['绝不认输']);
  assert.equal(g.length, 1, `应当 1 组，实际 ${g.length}`);
  assert.equal(g[0].n, 3);
  assert.equal(g[0].users, 3);
  assert.equal(g[0].disp, '绝不认输');
});

ok('配置写进了 meta，重启后仍生效', () => {
  assert.deepEqual(store.getAffixes().suffixes, ['desuwa']);
  const again = new Store(tmp);
  again.open();
  assert.deepEqual(again.getAffixes().suffixes, ['desuwa']);
  const g = again.groupByTerms(['绝不认输']);
  assert.equal(g.length, 1);
  again.close();
});

store.close();

console.log(`\n${passed} 项通过${failed ? ` / ${failed} 项失败` : ''}`);
process.exit(failed ? 1 : 0);
