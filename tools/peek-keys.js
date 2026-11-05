'use strict';
const { DatabaseSync } = require('node:sqlite');
const d = new DatabaseSync(process.argv[2] || 'data/danmaku.db', { readOnly: true });

const rows = d
  .prepare(
    `SELECT txt, ntxt, stem, topic FROM messages
     WHERE length(ntxt) <= 2 AND ntxt GLOB '*[^0-9a-zA-Z]*'
     ORDER BY id DESC LIMIT 12`
  )
  .all();
for (const r of rows) {
  console.log(JSON.stringify({ txt: r.txt, ntxt: r.ntxt, stem: r.stem, topic: r.topic }));
}

const emoji = d
  .prepare("SELECT COUNT(*) AS c FROM messages WHERE ntxt = '\u{1F412}'")
  .get();
console.log('ntxt 恰为 🐒 的行数:', emoji.c);

const dist = d
  .prepare(
    `SELECT ntxt, COUNT(*) AS c FROM messages WHERE length(ntxt) <= 1
     GROUP BY ntxt ORDER BY c DESC LIMIT 10`
  )
  .all();
console.log('单字符键分布:', dist);
