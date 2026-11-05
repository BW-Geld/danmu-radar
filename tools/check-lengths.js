'use strict';
const { DatabaseSync } = require('node:sqlite');

const d = new DatabaseSync(process.argv[2] || 'data/danmaku.db', { readOnly: true });
const q = (sql) => d.prepare(sql).get();

console.log('总条数        ', q('SELECT COUNT(*) c FROM messages').c);
console.log('归一化后为空  ', q("SELECT COUNT(*) c FROM messages WHERE ntxt = ''").c);
console.log('1 个字符      ', q("SELECT COUNT(*) c FROM messages WHERE length(ntxt) = 1").c);
console.log('2 个字符      ', q("SELECT COUNT(*) c FROM messages WHERE length(ntxt) = 2").c);
console.log('≥3 个字符     ', q("SELECT COUNT(*) c FROM messages WHERE length(ntxt) >= 3").c);
console.log('stem 为空     ', q("SELECT COUNT(*) c FROM messages WHERE stem IS NULL OR stem = ''").c);

const top1 = d
  .prepare(
    `SELECT ntxt, COUNT(*) c, COUNT(DISTINCT uid) u FROM messages
     WHERE length(ntxt) = 1 GROUP BY ntxt ORDER BY c DESC LIMIT 8`
  )
  .all();
console.log('\n最多的单字弹幕：');
for (const r of top1) console.log(`  ${r.ntxt}  ${r.c} 条 / ${r.u} 人`);
