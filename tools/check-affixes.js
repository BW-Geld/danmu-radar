'use strict';
// 一次性检查：前后缀折叠是否真的落到了 stem 上
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('E:/弹幕插件/data/danmaku.db');
const all = (sql, ...a) => db.prepare(sql).all(...a);

const one = (sql, ...a) => all(sql, ...a)[0];

console.log('stem 里还残留 desuwa：', one(`SELECT COUNT(*) c FROM messages WHERE stem LIKE '%desuwa%'`).c);
console.log('stem 里还残留 喵：', one(`SELECT COUNT(*) c FROM messages WHERE stem LIKE '%喵%'`).c);

const rows = all(
  `SELECT stem, COUNT(*) c, COUNT(DISTINCT txt) t
     FROM messages WHERE txt LIKE '%desuwa%'
    GROUP BY stem ORDER BY c DESC LIMIT 6`
);
for (const r of rows) console.log('  ', JSON.stringify(r.stem), 'count=' + r.c, 'distinct=' + r.t);

const top = all(
  `SELECT txt, COUNT(*) c FROM messages WHERE txt LIKE '%desuwa%' GROUP BY txt ORDER BY c DESC LIMIT 4`
);
for (const r of top) console.log('  raw', JSON.stringify(r.txt), r.c);
db.close();
