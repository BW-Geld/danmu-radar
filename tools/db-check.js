'use strict';

/** 直接查库核对：各来源条数、某词命中数。 */

const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(process.argv[2] || 'data/test.db');
const kw = process.argv[3] || '哈哈';

const q = (label, sql, ...args) => {
  console.log(label, JSON.stringify(db.prepare(sql).all(...args)));
};

q('按来源:', 'SELECT source, COUNT(*) n FROM messages GROUP BY source');
q('按房间:', 'SELECT rid, room_name, COUNT(*) n FROM messages GROUP BY rid');
q(`含"${kw}"总数:`, 'SELECT COUNT(*) n FROM messages WHERE ntxt LIKE ?', `%${kw}%`);
q(`含"${kw}"按来源:`, 'SELECT source, COUNT(*) n FROM messages WHERE ntxt LIKE ? GROUP BY source', `%${kw}%`);
q(`"${kw}"样例:`, 'SELECT rid, uid, txt FROM messages WHERE ntxt LIKE ? LIMIT 5', `%${kw}%`);
db.close();
