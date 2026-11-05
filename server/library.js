'use strict';

/**
 * 弹幕库的分发：导出一个可以独立打开的 .db 库包，或者把别人给的库包合并进来。
 *
 * 设计要点：
 *  1. 库包就是 SQLite 文件，用任何 SQLite 工具都能打开检查，`lib_meta` 里是元信息。
 *  2. 合并靠 `messages.hkey`（房间+毫秒+正文+类型的哈希）做幂等，导入两遍不会重复。
 *  3. 默认导出匿名包：uid 抹成 0、昵称变「匿名」。要带用户标识必须显式选择。
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const LIB_VERSION = '1';

const PKG_SCHEMA = `
PRAGMA journal_mode = DELETE;

CREATE TABLE IF NOT EXISTS lib_meta (
  k TEXT PRIMARY KEY,
  v TEXT
);

CREATE TABLE IF NOT EXISTS rooms (
  rid         INTEGER PRIMARY KEY,
  name        TEXT,
  owner       TEXT,
  avatar      TEXT,
  cate        TEXT,
  status      TEXT,
  added_at    INTEGER,
  last_msg_at INTEGER
);

CREATE TABLE IF NOT EXISTS messages (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  rid       INTEGER NOT NULL,
  room_name TEXT,
  uid       INTEGER,
  nn        TEXT,
  txt       TEXT,
  ntxt      TEXT,
  cst       INTEGER,
  level     INTEGER,
  bnn       TEXT,
  bl        INTEGER,
  brid      TEXT,
  kind      TEXT,
  gfid      TEXT,
  gfcnt     INTEGER,
  source    TEXT,
  ext       TEXT,
  hkey      TEXT,
  topic     TEXT,
  stem      TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pkg_hkey ON messages(hkey) WHERE hkey IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pkg_cst ON messages(cst);
`;

const MSG_COLS = [
  'rid', 'room_name', 'uid', 'nn', 'txt', 'ntxt', 'cst', 'level',
  'bnn', 'bl', 'brid', 'kind', 'gfid', 'gfcnt', 'source', 'ext', 'hkey', 'topic', 'stem',
];

function metaPut(db, k, v) {
  db.prepare('INSERT INTO lib_meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, String(v));
}

function metaMap(db) {
  const out = {};
  for (const r of db.prepare('SELECT k, v FROM lib_meta').all()) out[r.k] = r.v;
  return out;
}

// 临时库放在 data\tmp\ 而不是系统临时目录：
// 便携版可能在受限账户/沙箱里跑，%TEMP% 未必可写（实测 node:sqlite 直接报
// 「unable to open database file」）；data 目录一定是可写的，同盘复制也更快。
function tempPath(storePath, tag) {
  const dir = path.join(path.dirname(storePath), 'tmp');
  fs.mkdirSync(dir, { recursive: true });
  // 顺手清掉上次没删干净的（超过 1 天的）
  try {
    const cutoff = Date.now() - 86400000;
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { force: true });
    }
  } catch {
    /* 清理失败不影响导出 */
  }
  return path.join(dir, `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
}

/**
 * 导出一个库包。
 * @param {import('./db').Store} store
 * @param {{rid?:number, from?:number, to?:number, anon?:boolean, name?:string}} opts
 */
function exportLibrary(store, opts = {}) {
  const rid = Number(opts.rid) || 0;
  const from = Number(opts.from) || 0;
  const to = Number(opts.to) || 0;
  const anon = opts.anon !== false; // 默认匿名

  const file = tempPath(store.path, 'export');
  const db = new DatabaseSync(file);
  db.exec(PKG_SCHEMA);
  db.exec(`ATTACH DATABASE '${store.path.replace(/'/g, "''")}' AS src`);

  const where = ["kind = 'chat'"];
  const args = [];
  if (rid) {
    where.push('rid = ?');
    args.push(rid);
  }
  if (from) {
    where.push('cst >= ?');
    args.push(from);
  }
  if (to) {
    where.push('cst < ?');
    args.push(to);
  }
  const cond = where.join(' AND ');

  // 匿名导出：uid 抹成 0、昵称变「匿名」；hkey 本来就是不含 uid 的（v2 指纹），不用重算
  const uidExpr = anon ? '0' : 'uid';
  const nnExpr = anon ? `'匿名'` : 'nn';

  db.exec('BEGIN IMMEDIATE');
  db.prepare(`
    INSERT INTO messages(${MSG_COLS.join(',')})
    SELECT rid, room_name, ${uidExpr}, ${nnExpr}, txt, ntxt, cst, level,
           bnn, bl, brid, kind, gfid, gfcnt, 'import', ext, hkey, topic, stem
      FROM src.messages
     WHERE ${cond}
     ORDER BY cst ASC
  `).run(...args);
  db.exec('COMMIT');

  // rooms：只带库包里出现过的房间
  db.exec(`
    INSERT INTO rooms(rid, name, owner, avatar, cate, status, added_at, last_msg_at)
    SELECT DISTINCT m.rid, r.name, r.owner, r.avatar, r.cate, 'saved', r.added_at, r.last_msg_at
      FROM messages m LEFT JOIN src.rooms r ON r.rid = m.rid
  `);

  const rows = db.prepare('SELECT COUNT(*) AS c FROM messages').get().c;
  // 用户数按**源库**统计：匿名包里 uid 全是 0，从包里数会得到 0，没意义
  const users = db
    .prepare(`SELECT COUNT(DISTINCT uid) AS c FROM src.messages WHERE ${cond}`)
    .get(...args).c;
  const roomCount = db.prepare('SELECT COUNT(*) AS c FROM rooms').get().c;
  const range = db.prepare('SELECT MIN(cst) AS a, MAX(cst) AS b FROM messages').get();

  metaPut(db, 'format', 'danmu-radar-library');
  metaPut(db, 'version', LIB_VERSION);
  metaPut(db, 'exported_at', Date.now());
  metaPut(db, 'anon', anon ? '1' : '0');
  metaPut(db, 'rows', rows);
  metaPut(db, 'users', users);
  metaPut(db, 'rooms', roomCount);
  metaPut(db, 'from', from || range.a || 0);
  metaPut(db, 'to', to || (range.b ? range.b + 1 : 0));
  metaPut(db, 'name', opts.name || '');

  db.exec('DETACH DATABASE src');
  db.exec('PRAGMA optimize');
  db.close();

  return {
    file,
    rows,
    users,
    rooms: roomCount,
    anon,
    bytes: fs.statSync(file).size,
    from: from || range.a || 0,
    to: to || (range.b ? range.b + 1 : 0),
  };
}

/**
 * 把库包合并进主库。hkey 幂等，所以可以反复导入同一个包。
 * @param {import('./db').Store} store
 * @param {string} file 已落盘的 .db
 * @param {{onProgress?:(p:object)=>void}} opts
 */
function importLibrary(store, file, opts = {}) {
  const say = (p) => opts.onProgress && opts.onProgress(p);

  const pkg = new DatabaseSync(file);
  let meta;
  try {
    meta = metaMap(pkg);
  } catch {
    pkg.close();
    throw new Error('不是弹幕雷达的库包（缺少 lib_meta）');
  }
  if (meta.format !== 'danmu-radar-library') {
    pkg.close();
    throw new Error('不是弹幕雷达的库包（format 不对）');
  }
  if (Number(meta.version) > Number(LIB_VERSION)) {
    pkg.close();
    throw new Error(`库包版本 ${meta.version} 比当前程序新，请先升级程序`);
  }

  const total = Number(meta.rows) || pkg.prepare('SELECT COUNT(*) AS c FROM messages').get().c;
  say({ phase: 'read', total });

  pkg.close();
  const db = store.db;
  db.exec(`ATTACH DATABASE '${file.replace(/'/g, "''")}' AS pkg`);

  try {
    const before = db.prepare('SELECT COUNT(*) AS c FROM messages').get().c;
    db.exec('BEGIN IMMEDIATE');
    db.exec(`
      INSERT OR IGNORE INTO messages(${MSG_COLS.join(',')})
      SELECT ${MSG_COLS.join(',')} FROM pkg.messages
    `);
    db.exec('COMMIT');
    const after = db.prepare('SELECT COUNT(*) AS c FROM messages').get().c;
    const inserted = after - before;

    // 房间：有就更新名字，没有就补一条（不自动开始采集）
    const rooms = db.prepare('SELECT COUNT(*) AS c FROM pkg.rooms').get().c;
    db.exec(`
      INSERT INTO rooms(rid, name, owner, avatar, cate, status, added_at, last_msg_at, auto_start)
      SELECT rid, name, owner, avatar, cate, 'saved', added_at, last_msg_at, 0 FROM pkg.rooms
      WHERE rid NOT IN (SELECT rid FROM main.rooms)
    `);
    say({ phase: 'merged', inserted, dupes: total - inserted, rooms, total });

    // 重算：词条分类 + 弹幕潮（导入的行 topic/stem 可能来自旧版本口径）
    say({ phase: 'recompute', step: 'topics' });
    let n = 0;
    while (true) {
      const done = store.backfillTopics(4000);
      n += done;
      if (done < 4000) break;
      say({ phase: 'recompute', step: 'topics', done: n });
    }
    say({ phase: 'recompute', step: 'floods' });
    const f = store.rebuildFloods({ since: 0 });
    say({ phase: 'done', inserted, dupes: total - inserted, rooms, topics: n, floods: f.events });
    return { ok: true, inserted, dupes: total - inserted, rooms, topics: n, floods: f.events, meta };
  } finally {
    try {
      db.exec('DETACH DATABASE pkg');
    } catch {
      /* ignore */
    }
  }
}

module.exports = { exportLibrary, importLibrary, LIB_VERSION };
