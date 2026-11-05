'use strict';
const { DatabaseSync } = require('node:sqlite');
const d = new DatabaseSync('data/danmaku.db', { readOnly: true });

const rows = d
  .prepare("SELECT cst, txt FROM messages WHERE rid = 475252 AND kind='chat' ORDER BY cst DESC LIMIT 400")
  .all();

let shown = 0;
for (let i = 0; i < rows.length - 1 && shown < 6; i++) {
  const gap = Number(rows[i].cst) - Number(rows[i + 1].cst);
  if (gap >= 15000) {
    const f = (t) => new Date(Number(t)).toLocaleTimeString('zh-CN');
    console.log(`空档 ${Math.round(gap / 1000)}s：${f(rows[i + 1].cst)} → ${f(rows[i].cst)}`);
    shown++;
  }
}
if (!shown) console.log('最近 400 条里没有 ≥15 秒的空档');

const last = rows[0];
console.log('最新一条：', new Date(Number(last.cst)).toLocaleTimeString('zh-CN'), String(last.txt).slice(0, 30));
