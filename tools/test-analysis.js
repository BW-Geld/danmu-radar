'use strict';

/**
 * 分析引擎自测：用合成语料验证「三路召回」与「成分画像」的判定逻辑。
 * 合成语料可以控制信号，从而在没有真实数据积累时也能验证算法。
 *
 *   node tools/test-analysis.js
 */

const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('../server/db');
const analysis = require('../server/analysis');

const DB = path.join(__dirname, '..', 'data', 'test-analysis.db');
for (const f of [DB, DB + '-wal', DB + '-shm']) if (fs.existsSync(f)) fs.unlinkSync(f);

const store = new Store(DB);
store.open();

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

const RID = 900001;
const ROOM = '合成测试房';
store.upsertRoom({ rid: RID, name: ROOM, owner: 'tester', owner_uid: '1', status: 'live' });

// ---------------------------------------------------------------- 造语料
const BG = ['这波操作可以', '主播牛啊', '笑死我了', '下一把了', '装备怎么配', '伤害不够啊'];
const uid = (n) => String(100000 + n);
const nn = (n) => `观众${n}`;

const rows = [];
let t = Date.now() - 3 * 86400000;
const pick = (arr, i) => arr[i % arr.length];

// 30 个「战况窗口」：窗口内 开团 与 打野 强共现，窗口外几乎不出现
for (let w = 0; w < 30; w++) {
  const base = t + w * 40 * 60000; // 每 40 分钟一个窗口
  for (let i = 0; i < 24; i++) {
    const who = (w * 24 + i) % 60;
    let txt;
    if (i % 6 === 0) txt = '开团了开团了';
    else if (i % 6 === 1 || i % 6 === 2) txt = '打野快上';
    else txt = pick(BG, w * 24 + i);
    rows.push({
      rid: RID,
      roomName: ROOM,
      uid: uid(who),
      nn: nn(who),
      txt,
      cst: base + i * 4000,
      level: 20,
      kind: 'chat',
    });
  }
  // 窗口之间的空档，只有背景语料
  for (let i = 0; i < 60; i++) {
    const who = (w * 7 + i) % 60;
    rows.push({
      rid: RID,
      roomName: ROOM,
      uid: uid(who),
      nn: nn(who),
      txt: pick(BG, w * 13 + i),
      cst: base + 5 * 60000 + i * 5000,
      level: 20,
      kind: 'chat',
    });
  }
}

// 复读机器人：同一条内容刷 80 次
for (let i = 0; i < 80; i++) {
  rows.push({ rid: RID, roomName: ROOM, uid: '888888', nn: '复读机', txt: '666', cst: t + 3600000 + i * 3000, level: 3, kind: 'chat' });
}

// 节奏号：攻击性词汇
const AGG = ['傻逼主播', '脑残吧', '这操作真是废物', '小丑一个'];
for (let i = 0; i < 40; i++) {
  rows.push({ rid: RID, roomName: ROOM, uid: '777777', nn: '节奏哥', txt: pick(AGG, i) + i % 3, cst: t + 7200000 + i * 60000, level: 8, kind: 'chat' });
}

store.insertBatch(rows);
store.touchRooms(rows);
console.log(`合成语料 ${rows.length} 条`);

// ---------------------------------------------------------------- 检索
console.log('\n[1] 三路召回');
const r1 = analysis.search(store, { q: '开团', rid: RID, limit: 500 });
check('精确命中可用', r1.counts.exact > 0, `${r1.counts.exact} 条`);
check('强相关词挖到「打野」', r1.cooccurTerms.some((c) => c.term.includes('打野')), JSON.stringify(r1.cooccurTerms.slice(0, 3)));
const dy = r1.cooccurTerms.find((c) => c.term.includes('打野'));
check('lift 显著大于 1', !!dy && dy.lift > 2, dy ? `lift=${dy.lift}` : '未命中');
check('强相关召回有结果', r1.counts.cooccur > 0, `${r1.counts.cooccur} 条`);
check('每条结果都带命中原因', r1.rows.every((r) => !!r.reason), r1.rows[0] && r1.rows[0].reason);

const r2 = analysis.search(store, { q: '牛', rid: RID, limit: 200 });
check('同义/梗词扩展可触发', r2.terms.length >= 1, `terms=${r2.terms.join(',')}`);

// ---------------------------------------------------------------- 画像
console.log('\n[2] 成分画像');
const bot = analysis.profile(store, '888888');
check('复读机样本可画像', bot.ok, `${bot.total} 条`);
check('识别出复读/机器化标签', bot.labels.some((l) => ['repeat', 'bot'].includes(l.key)), bot.labels.map((l) => l.label).join('/'));
check('重复率高', bot.stats.repeatRatio > 0.5, `repeatRatio=${bot.stats.repeatRatio}`);
check('机器化评分偏高', bot.scores.bot >= 50, `bot=${bot.scores.bot}`);

const agg = analysis.profile(store, '777777');
check('节奏号被识别', agg.labels.some((l) => l.key === 'toxic'), agg.labels.map((l) => l.label).join('/'));
check('攻击性评分偏高', agg.scores.aggression >= 35, `aggression=${agg.scores.aggression}`);
check('标签带证据句', (agg.labels[0].evidence || []).length > 0, JSON.stringify(agg.labels[0].evidence[0] || null));

const nobody = analysis.profile(store, '424242');
check('无记录用户有明确空态', nobody.ok === false && nobody.empty === true, nobody.error);

store.close();
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
