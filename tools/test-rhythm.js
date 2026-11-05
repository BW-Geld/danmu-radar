'use strict';

/**
 * 节奏词要进「对立倾向」，但不能把阵营标签本身当成攻击：
 *   - 「龙美急了」「反串」「串子」算节奏；
 *   - 「我是龙美」「圣贤今天好强」只是表态，不算；
 *   - 「着急」「紧急」不能因为含「急」就误伤。
 */

const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { Store } = require('../server/db');
const analysis = require('../server/analysis');

const tmp = path.join(os.tmpdir(), `danmu-rhythm-${Date.now()}.db`);
const store = new Store(tmp);
store.open();

const BASE = 1800000000000;
let cst = BASE;
function say(uid, txt) {
  store.insertBatch([{ rid: 9, uid, txt, cst: (cst += 1000), kind: 'chat', nn: `u${uid}`, source: 'live' }]);
}

// 1 号：纯节奏号（骂人不带脏字，全是拱火 + 阵营标签）
const troll = ['龙美急了', '鹰美别叫了', '反串？', '串子出来', '就这？', '乐子人', '你急什么'];
for (const t of troll) say(1001, t);

// 2 号：纯表态，提阵营但不挑事
const fan = ['我是龙美', '圣贤今天好强', '美圣贤牛逼', '鹰美加油', '精冰也很好'];
for (const t of fan) say(1002, t);

// 3 号：正常闲聊，含「急」但不是在挑事
const normal = ['别着急我马上到', '紧急通知看群', '这道题好难啊', '今天天气不错', '主播加油'];
for (const t of normal) say(1003, t);

// 4 号：直接骂人
for (const t of ['傻逼吧', '滚出去', '脑残']) say(1004, t);

const p1 = analysis.profile(store, 1001);
const p2 = analysis.profile(store, 1002);
const p3 = analysis.profile(store, 1003);
const p4 = analysis.profile(store, 1004);

let passed = 0;
let failed = 0;
function ok(name, fn) {
  try {
    fn();
    passed++;
    console.log('✓ ' + name);
  } catch (e) {
    failed++;
    console.log('✗ ' + name + ' — ' + e.message);
  }
}

ok('纯节奏号：aggression 高、节奏条数≥5', () => {
  assert.ok(p1.scores.aggression >= 50, `aggression=${p1.scores.aggression}`);
  assert.ok(p1.hostility.rhythm >= 5, `rhythm=${p1.hostility.rhythm}`);
  // 「急了」本身也在脏话表里，所以 direct 可能占 1–2 条，但不该是全部
  assert.ok(p1.hostility.direct <= 2, `direct=${p1.hostility.direct}`);
});

ok('只说阵营不挑事：不计对立', () => {
  assert.equal(p2.hostility.total, 0, `total=${p2.hostility.total}`);
  assert.ok(p2.scores.aggression < 20, `aggression=${p2.scores.aggression}`);
});

ok('「着急/紧急」不误伤', () => {
  assert.equal(p3.hostility.total, 0, `total=${p3.hostility.total}`);
});

ok('直接骂人单独计数', () => {
  assert.equal(p4.hostility.direct, 3);
  assert.equal(p4.hostility.rhythm, 0);
  assert.ok(p4.scores.aggression >= 50, `aggression=${p4.scores.aggression}`);
});

ok('节奏号会被标「对立性发言偏多」', () => {
  assert.ok(p1.labels.some((l) => l.key === 'toxic'), JSON.stringify(p1.labels.map((l) => l.key)));
});

store.close();
console.log(`\n${passed} 项通过${failed ? ` / ${failed} 项失败` : ''}`);
process.exit(failed ? 1 : 0);
