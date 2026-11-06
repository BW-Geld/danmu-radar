'use strict';

/** SQLite 存储层：建表、批量写入、检索与聚合查询。 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { normalize, stem, keyOf, stemOf, stripMention, stripAffixes, setAffixes, getAffixes } = require('./text');
const { classify } = require('./topics');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = process.env.DANMU_DB || path.join(DATA_DIR, 'danmaku.db');

/**
 * 弹幕指纹。斗鱼的 chatmsg 里没有唯一 ID（实测字段只有 uid/nn/txt/cst/level/bnn/bl/brid/col/ic），
 * 所以用「房间 + 毫秒时间 + 正文 + 类型」拼一个 key：
 * 同一房间同一毫秒出现两条一模一样的话，现实中不存在，可以安全当作重复。
 *
 * 为什么**不含 uid**：导出的库包默认是匿名的（uid 抹成 0），如果指纹里掺了 uid，
 * 同一条弹幕在匿名包和实名包里会算出两个 key，导入去重就失效了。
 * 而且指纹本身就是「房间+时间+正文」的哈希，从匿名包里反向猜出 uid 是可行的（uid 空间可枚举），
 * 所以匿名包里也不该留一个「由 uid 派生」的值。
 *
 * 代价：同一毫秒、两个不同用户发完全相同的话，会被当成一条。概率极低，且少算一条
 * 比「匿名包和实名包对不上、同一条算两次」轻得多。
 */
function messageKey(r) {
  const raw = `${r.rid}|${r.cst}|${r.kind || 'chat'}|${r.txt}|${r.gfid || ''}`;
  return crypto.createHash('sha1').update(raw).digest('base64url').slice(0, 22);
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA temp_store = MEMORY;

CREATE TABLE IF NOT EXISTS rooms (
  rid         INTEGER PRIMARY KEY,
  name        TEXT,
  owner       TEXT,
  owner_uid   TEXT,
  avatar      TEXT,
  cate        TEXT,
  status      TEXT,
  added_at    INTEGER,
  last_msg_at INTEGER,
  msg_count   INTEGER DEFAULT 0,
  auto_start  INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS messages (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  rid       INTEGER NOT NULL,
  room_name TEXT,
  uid       TEXT NOT NULL,
  nn        TEXT,
  txt       TEXT NOT NULL,
  ntxt      TEXT NOT NULL,
  cst       INTEGER NOT NULL,
  level     INTEGER DEFAULT 0,
  bnn       TEXT,
  bl        INTEGER DEFAULT 0,
  brid      INTEGER DEFAULT 0,
  kind      TEXT NOT NULL DEFAULT 'chat',
  gfid      TEXT,
  gfcnt     INTEGER DEFAULT 0,
  source    TEXT NOT NULL DEFAULT 'live',
  ext       TEXT,
  hkey      TEXT
);

CREATE INDEX IF NOT EXISTS idx_msg_rid_cst ON messages(rid, cst);
CREATE INDEX IF NOT EXISTS idx_msg_uid_cst ON messages(uid, cst);
CREATE INDEX IF NOT EXISTS idx_msg_cst     ON messages(cst);
CREATE INDEX IF NOT EXISTS idx_msg_rid_ntxt ON messages(rid, ntxt, cst);

CREATE TABLE IF NOT EXISTS vod_imports (
  show_id     TEXT PRIMARY KEY,
  vid         TEXT,
  title       TEXT,
  room_id     INTEGER,
  duration    INTEGER,
  total       INTEGER,
  imported    INTEGER,
  imported_at INTEGER
);

CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT
);

-- 收藏：按「房间 + 说法（stem）」收藏一句弹幕，同一句在同一房间只能收一次
CREATE TABLE IF NOT EXISTS favorites (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  rid        INTEGER NOT NULL,
  stem       TEXT NOT NULL,
  txt        TEXT NOT NULL,
  room_name  TEXT,
  uid        TEXT,
  nn         TEXT,
  cst        INTEGER,
  note       TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (rid, stem)
);

CREATE TABLE IF NOT EXISTS follows (
  uid        TEXT PRIMARY KEY,
  nn         TEXT,
  note       TEXT,
  created_at INTEGER NOT NULL,
  special    INTEGER NOT NULL DEFAULT 0
);

-- 被去重层拦下的重复弹幕不直接丢掉：连发本身是「弹幕潮 / 复读」的信号，保留下来备查
CREATE TABLE IF NOT EXISTS dupes (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  rid    INTEGER NOT NULL,
  uid    TEXT NOT NULL,
  nn     TEXT,
  txt    TEXT NOT NULL,
  ntxt   TEXT,
  cst    INTEGER,
  level  INTEGER,
  bnn    TEXT,
  bl     INTEGER,
  kind   TEXT,
  reason TEXT,
  delta  INTEGER,
  at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_dupes_rid_at ON dupes(rid, at);
CREATE INDEX IF NOT EXISTS idx_dupes_cst    ON dupes(cst);

-- 弹幕潮事件表：10 秒窗内同一句话被 ≥3 个不同用户刷出来，按「事件」而非「桶」记账。
-- 它有两个用途：①画像里算跟风度；②检索的共现挖掘里**剔除**刷屏窗口（不是加权）。
CREATE TABLE IF NOT EXISTS flood_events (
  rid         INTEGER NOT NULL,
  event_start INTEGER NOT NULL,
  phrase      TEXT NOT NULL,
  stem        TEXT,
  room_name   TEXT,
  msg_count   INTEGER,
  user_count  INTEGER,
  dur_ms      INTEGER,
  topic       TEXT,
  first_uid   TEXT,
  first_nn    TEXT,
  first_at    INTEGER,
  updated_at  INTEGER,
  PRIMARY KEY (rid, event_start, phrase)
);
CREATE INDEX IF NOT EXISTS idx_flood_rid_time ON flood_events(rid, event_start);
CREATE INDEX IF NOT EXISTS idx_flood_phrase   ON flood_events(phrase);
CREATE INDEX IF NOT EXISTS idx_flood_stem     ON flood_events(rid, stem);

-- 采集缺口：断线期间的数据是**永久丢失**的（实测斗鱼不补发），所以必须记下来。
-- 只在「重连成功」时写一条，from=断线前最后一条消息的时间，to=重连成功的时间。
-- 它存在的意义不是画虚线，而是让画像把缺口从「采集时长」分母里扣掉。
-- filled_by：将来用录播回放补上这段时，记下 showId，表示这段不再是盲区。
CREATE TABLE IF NOT EXISTS gaps (
  id         INTEGER PRIMARY KEY,
  rid        INTEGER NOT NULL,
  from_cst   INTEGER NOT NULL,
  to_cst     INTEGER NOT NULL,
  dur_ms     INTEGER NOT NULL,
  retries    INTEGER NOT NULL DEFAULT 0,
  filled_by  TEXT,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_gaps_rid ON gaps(rid, from_cst);
`;

function open(dbPath = DB_PATH) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);

  // 老库迁移：补 source / ext 两列（CREATE TABLE IF NOT EXISTS 不会改已存在的表）
  const cols = new Set(db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name));
  if (!cols.has('source')) {
    db.exec("ALTER TABLE messages ADD COLUMN source TEXT NOT NULL DEFAULT 'live'");
  }
  if (!cols.has('ext')) {
    db.exec('ALTER TABLE messages ADD COLUMN ext TEXT');
  }
  if (!cols.has('hkey')) {
    db.exec('ALTER TABLE messages ADD COLUMN hkey TEXT');
  }
  if (!cols.has('topic')) {
    db.exec('ALTER TABLE messages ADD COLUMN topic TEXT');
  }
  if (!cols.has('stem')) {
    db.exec('ALTER TABLE messages ADD COLUMN stem TEXT');
  }
  const gapCols = new Set(db.prepare('PRAGMA table_info(gaps)').all().map((c) => c.name));
  if (!gapCols.has('reason')) {
    // reconnect = 运行中重连；downtime = 程序没开（关窗、重启、崩溃）
    db.exec("ALTER TABLE gaps ADD COLUMN reason TEXT NOT NULL DEFAULT 'reconnect'");
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_msg_topic ON messages(rid, topic, cst)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_msg_stem  ON messages(rid, stem, cst)');
  // 唯一索引放在迁移之后建：老库此时才刚补上 ext 列
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_ext ON messages(ext) WHERE ext IS NOT NULL');

  migrateDedupe(db);
  const dedupedByHkey = migrateHkeyV2(db);
  if (dedupedByHkey > 0) {
    // 指纹去掉 uid 之后，同毫秒同内容的重复行会合并；这里只做提示，不打断启动
    console.log(`[迁移] 指纹 v2 重算完成，合并了 ${dedupedByHkey} 条同毫秒同内容的弹幕`);
  }
  migrateStemV2(db);
  migrateTopicV2(db);
  migrateFollowSpecial(db);
  loadAffixes(db);

  db.exec('PRAGMA optimize');
  return db;
}

/**
 * 指纹改过一次：v1 掺了 uid，v2 去掉了。
 * 去 uid 是因为导出的匿名包会把 uid 抹成 0，掺 uid 的指纹会让「同一条弹幕」在
 * 匿名包和实名包里算出两个 key，导入去重直接失效；而且匿名包里留一个由 uid 派生的值，
 * 本身就有被反推的风险。
 *
 * 重算之后可能出现新的重复（两个不同用户在同一毫秒发了同样的话），按「留最早一行」清掉。
 */
function migrateHkeyV2(db) {
  const done = db.prepare('SELECT v FROM meta WHERE k = ?').get('hkey_v2');
  if (done && done.v === '1') return 0;

  const hasMeta = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").get();
  if (!hasMeta) return 0;

  const rows = db.prepare('SELECT id, rid, uid, cst, kind, txt, gfid FROM messages').all();
  const upd = db.prepare('UPDATE messages SET hkey = ? WHERE id = ?');

  db.exec('DROP INDEX IF EXISTS idx_msg_hkey');
  db.exec('BEGIN IMMEDIATE');
  for (const r of rows) upd.run(messageKey(r), r.id);
  db.exec('COMMIT');

  const before = rows.length;
  db.exec(`
    DELETE FROM messages
     WHERE hkey IS NOT NULL
       AND id NOT IN (SELECT MIN(id) FROM messages WHERE hkey IS NOT NULL GROUP BY hkey)
  `);
  const after = db.prepare('SELECT COUNT(*) AS c FROM messages').get().c;
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_hkey ON messages(hkey) WHERE hkey IS NOT NULL');
  db.prepare('INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run('hkey_v2', '1');
  return before - after;
}

/** 老版本的一次性迁移：补 hkey、清重复、建索引（v1，含 uid） */
function migrateDedupe(db) {
  const done = db.prepare('SELECT v FROM meta WHERE k = ?').get('dedupe_v1');
  if (done && done.v === '1') return;

  const hasMeta = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").get();
  if (!hasMeta) return;

  const rows = db.prepare('SELECT id, rid, uid, cst, kind, txt, gfid FROM messages WHERE hkey IS NULL').all();
  if (rows.length) {
    const upd = db.prepare('UPDATE messages SET hkey = ? WHERE id = ?');
    db.exec('BEGIN IMMEDIATE');
    for (const r of rows) upd.run(messageKey(r), r.id);
    db.exec('COMMIT');
  }

  // 同一 hkey 只留最早的一行
  db.exec(`
    DELETE FROM messages
     WHERE hkey IS NOT NULL
       AND id NOT IN (SELECT MIN(id) FROM messages WHERE hkey IS NOT NULL GROUP BY hkey)
  `);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_hkey ON messages(hkey) WHERE hkey IS NOT NULL');
  db.prepare('INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run('dedupe_v1', '1');
}

/**
 * 用户配置的前后缀在进程启动时就要生效：stem 是入库时算的，
 * 如果在迁移之后才 set，新老数据会用两套口径，聚合结果就错位了。
 */
function loadAffixes(db) {
  try {
    const row = db.prepare('SELECT v FROM meta WHERE k = ?').get('affixes');
    if (row && row.v) setAffixes(JSON.parse(row.v));
  } catch {
    /* 配坏了就当没有 */
  }
}

/**
 * stem v2：剥掉开头的「@某人:」回覆前缀再折叠。
 * 不这么做的后果很直观——同一句刷屏因为回覆对象不同被拆成几十个 stem，
 * 列表里会出现一堆字面完全一样的行，各自标着 ×9 / ×8 / ×5，看着像去重失败。
 * 只重算 stem，不动 ntxt（检索仍按原文匹配，回复前缀也是原文的一部分）。
 */
/**
 * 词条分类表更新后（比如把「反串/圣贤」归进对立嘲讽），历史数据的 topic 要重算，
 * 否则只有新弹幕会用新表，画像里「发得最多的一类」会长期停在旧口径上。
 * 这里只把 topic 清空，真正的重算交给启动后的 backfillTopics 分批做。
 */
function migrateTopicV2(db) {
  const done = db.prepare('SELECT v FROM meta WHERE k = ?').get('topic_v2');
  if (done && done.v === '1') return;
  const hasMeta = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").get();
  if (!hasMeta) return;
  db.exec("UPDATE messages SET topic = NULL WHERE kind = 'chat'");
  db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run('topic_v2', '1');
}

/** 老库的 follows 没有 special 列：补上（特别关注 = 置顶分组，不改采集行为） */
function migrateFollowSpecial(db) {
  const cols = db.prepare('PRAGMA table_info(follows)').all();
  if (!cols.length) return;
  if (cols.some((c) => c.name === 'special')) return;
  db.exec('ALTER TABLE follows ADD COLUMN special INTEGER NOT NULL DEFAULT 0');
}

function migrateStemV2(db) {
  const done = db.prepare('SELECT v FROM meta WHERE k = ?').get('stem_v2');
  if (done && done.v === '1') return;
  const hasMeta = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").get();
  if (!hasMeta) return;

  const rows = db.prepare("SELECT id, txt, stem FROM messages WHERE kind = 'chat'").all();
  const upd = db.prepare('UPDATE messages SET stem = ? WHERE id = ?');
  let changed = 0;
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const s = stemOf(r.txt);
      if (s !== r.stem) {
        upd.run(s, r.id);
        changed++;
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  db.prepare('INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run('stem_v2', '1');
  if (changed) console.log(`[迁移] 重算 ${changed} 条弹幕的聚合键（去掉 @回覆 前缀）`);
}

class Store {
  constructor(dbPath = DB_PATH) {
    this.path = dbPath;
    this.db = open(dbPath);
    this._cache = new Map();
  }

  /** 兼容外部显式初始化调用 */
  open() {
    return this;
  }

  /**
   * 库文件被外部删掉/挪走时，SQLite 会**静默**新建一个空库继续写：历史没了，界面却一切正常。
   * 每次落库前先确认文件还在，不在就抛错让采集器停下来报警（错误码 DB_FILE_GONE）。
   */
  assertDbFile() {
    if (!this.path) return;
    if (fs.existsSync(this.path)) return;
    const err = new Error('数据库文件不见了：' + this.path);
    err.code = 'DB_FILE_GONE';
    throw err;
  }

  close() {
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      /* ignore */
    }
    this.db.close();
  }

  /** 某房间（或全局）最近 N 条聊天弹幕，按时间正序返回便于前端直接追加 */
  recentMessages(rid, limit = 100) {
    const n = Math.min(Number(limit) || 100, 500);
    const rows = rid
      ? this.stmt(
          `SELECT id, rid, room_name, uid, nn, txt, cst, level, bnn, bl, source FROM messages
           WHERE rid = ? AND kind = 'chat' ORDER BY cst DESC LIMIT ?`
        ).all(Number(rid), n)
      : this.stmt(
          `SELECT id, rid, room_name, uid, nn, txt, cst, level, bnn, bl, source FROM messages
           WHERE kind = 'chat' ORDER BY cst DESC LIMIT ?`
        ).all(n);
    return rows.reverse();
  }

  /** 某房间最后一条聊天的时间戳（毫秒）；没有则 0。用于开机补记 downtime 缺口。 */
  lastMessageAt(rid) {
    const row = this.stmt(
      "SELECT MAX(cst) AS cst FROM messages WHERE rid = ? AND kind = 'chat' AND source = 'live'"
    ).get(Number(rid));
    return Number(row && row.cst) || 0;
  }

  stmt(sql) {
    let s = this._cache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this._cache.set(sql, s);
    }
    return s;
  }

  exec(sql) {
    this.db.exec(sql);
  }

  // ---------- 房间 ----------

  upsertRoom(info) {
    const now = Date.now();
    this.stmt(
      `INSERT INTO rooms (rid, name, owner, owner_uid, avatar, cate, status, added_at, auto_start)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(rid) DO UPDATE SET
         name=excluded.name, owner=excluded.owner, owner_uid=excluded.owner_uid,
         avatar=excluded.avatar, cate=excluded.cate, status=excluded.status`
    ).run(
      Number(info.rid),
      info.name || String(info.rid),
      info.owner || '',
      info.ownerUid || '',
      info.avatar || '',
      info.cate || '',
      info.status || 'unknown',
      now
    );
  }

  listRooms() {
    return this.stmt(
      `SELECT r.*, (SELECT COUNT(*) FROM messages m WHERE m.rid = r.rid) AS stored
       FROM rooms r ORDER BY r.added_at ASC`
    ).all();
  }

  getRoom(rid) {
    return this.stmt('SELECT * FROM rooms WHERE rid = ?').get(Number(rid));
  }

  /** 录播导入用的占位房间：已存在（在采）就不动它，不存在则记一条 status='vod' 且不自动采集的记录 */
  ensureVodRoom({ rid, name, owner }) {
    if (!rid) return;
    this.stmt(
      `INSERT INTO rooms (rid, name, owner, owner_uid, avatar, cate, status, added_at, auto_start)
       VALUES (?, ?, ?, '', '', '', 'vod', ?, 0)
       ON CONFLICT(rid) DO NOTHING`
    ).run(Number(rid), name || `房间 ${rid}`, owner || '');
  }

  removeRoom(rid) {
    this.stmt('DELETE FROM rooms WHERE rid = ?').run(Number(rid));
  }

  /**
   * 删除房间 = 停止采集 + 删数据。以前只删 rooms 行，弹幕还留着，
   * 结果房间在「仅历史」里又冒出来——用户点了删除就该真的没了。
   */
  deleteRoomData(rid) {
    const id = Number(rid);
    let removed = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      removed = Number(this.stmt('DELETE FROM messages WHERE rid = ?').run(id).changes) || 0;
      this.stmt('DELETE FROM dupes WHERE rid = ?').run(id);
      this.stmt('DELETE FROM gaps WHERE rid = ?').run(id);
      this.stmt('DELETE FROM flood_events WHERE rid = ?').run(id);
      this.stmt('DELETE FROM rooms WHERE rid = ?').run(id);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return removed;
  }

  /** 录播导入记录按房间清理（删房间时用）。 */
  removeVodImportsByRoom(rid) {
    return Number(this.stmt('DELETE FROM vod_imports WHERE room_id = ?').run(Number(rid)).changes) || 0;
  }

  setRoomStatus(rid, status, { keepAuto = false } = {}) {
    // 停止 = 用户不想采了，必须把 auto_start 也关掉，否则重启程序又自己连上去，
    // 用户看到的就是「我明明停了，它怎么又开始了」。
    // keepAuto：程序整体退出时的批量停止，此时不该动 auto_start。
    if (status === 'stopped' && !keepAuto) {
      this.stmt("UPDATE rooms SET status = ?, auto_start = 0 WHERE rid = ?").run(status, Number(rid));
      return;
    }
    if (status === 'online' || status === 'starting' || status === 'connecting' || status === 'live' || status === 'reconnecting') {
      this.stmt('UPDATE rooms SET status = ?, auto_start = 1 WHERE rid = ?').run(status, Number(rid));
      return;
    }
    this.stmt('UPDATE rooms SET status = ? WHERE rid = ?').run(status, Number(rid));
  }

  // ---------- 写入 ----------

  /** rows: {rid, roomName, uid, nn, txt, cst, level, bnn, bl, brid, kind, gfid, gfcnt, source, ext} */
  /**
   * 默认用 OR IGNORE：重复弹幕（重连补发、录播翻页重叠）靠 hkey / ext 的唯一索引挡掉，
   * 冲突不是错误，是预期行为。
   */
  insertBatch(rows, { ignore = true } = {}) {
    if (!rows.length) return { attempted: 0, inserted: 0, dupes: 0 };
    this.assertDbFile();
    const ins = this.stmt(
      `INSERT ${ignore ? 'OR IGNORE' : ''} INTO messages
         (rid, room_name, uid, nn, txt, ntxt, cst, level, bnn, bl, brid, kind, gfid, gfcnt, source, ext, hkey, topic, stem)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    let inserted = 0;
    this.exec('BEGIN IMMEDIATE');
    try {
      for (const r of rows) {
        // 纯表情 / 纯符号的弹幕归一化后是空串，退回原文，否则它既搜不到也算不进潮
        const ntxt = keyOf(r.txt);
        const res = ins.run(
          Number(r.rid),
          r.roomName || '',
          String(r.uid || ''),
          r.nn || '',
          String(r.txt || '').slice(0, 500),
          ntxt.slice(0, 500),
          Number(r.cst) || Date.now(),
          Number(r.level) || 0,
          r.bnn || '',
          Number(r.bl) || 0,
          Number(r.brid) || 0,
          r.kind || 'chat',
          r.gfid || '',
          Number(r.gfcnt) || 0,
          r.source || 'live',
          r.ext || null,
          r.hkey || messageKey(r),
          r.topic || classify(r.txt || ''),
          stemOf(r.txt || '')
        );
        inserted += Number(res.changes) || 0;
      }
      this.exec('COMMIT');
    } catch (err) {
      this.exec('ROLLBACK');
      throw err;
    }
    return { attempted: rows.length, inserted, dupes: rows.length - inserted };
  }

  /** 被去重层拦下的连发弹幕：不计数但留档，供「弹幕潮」分析用 */
  insertDupes(rows) {
    if (!rows.length) return 0;
    const ins = this.stmt(
      `INSERT INTO dupes (rid, uid, nn, txt, ntxt, cst, level, bnn, bl, kind, reason, delta, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    let n = 0;
    this.exec('BEGIN IMMEDIATE');
    try {
      for (const r of rows) {
        ins.run(
          Number(r.rid),
          String(r.uid || ''),
          r.nn || '',
          String(r.txt || '').slice(0, 500),
          keyOf(r.txt).slice(0, 500),
          Number(r.cst) || 0,
          Number(r.level) || 0,
          r.bnn || '',
          Number(r.bl) || 0,
          r.kind || 'chat',
          r.reason || 'replay',
          Number(r.delta) || 0,
          Date.now()
        );
        n++;
      }
      this.exec('COMMIT');
    } catch (err) {
      this.exec('ROLLBACK');
      throw err;
    }
    return n;
  }

  dupesCount(since = 0) {    const row = this.db.prepare('SELECT COUNT(*) AS n FROM dupes WHERE at >= ?').get(since);
    return row ? row.n : 0;
  }

  /**
   * 重建弹幕潮事件（两段式）。
   *
   * 为什么不能「按桶相加」：`COUNT(DISTINCT uid)` 不可跨桶累加——两个 5 秒桶各有 3 个不同用户，
   * 相加得 6，但完全可能是同一批 3 个人各发两次；那样「一个人连刷」会被误判成「3 人跟风」。
   * 所以 5 秒桶只做**候选预筛**（只看条数），候选桶再回查 10 秒原始行，精确算 distinct uid。
   *
   * 这样既覆盖了跨桶的潮（[t,t+10) 与 [t-5,t+5) 两个窗口都会评估），又不用全量滑动重算。
   */
  rebuildFloods({
    rid = 0,
    since = 0,
    binMs = 5000,
    windowMs = 10000,
    minUsers = 3,
    minCount = 6,
    gapMs = 60000,
    maxDurMs = 300000,
  } = {}) {
    const scanFrom = Number(since) - maxDurMs; // 往前多扫一个「最长事件」，避免边界上的事件被截断
    const where = ["kind = 'chat'", 'cst >= ?', "ntxt != ''"];
    const args = [scanFrom];
    if (rid) {
      where.push('rid = ?');
      args.push(Number(rid));
    }
    // 第一段：纯计数的候选桶（阈值取一半，避免桶边界把窗口劈开后漏检）
    const cand = this.db
      .prepare(
        `SELECT rid, ntxt, CAST(cst / ${Number(binMs)} AS INTEGER) AS b, COUNT(*) AS c
         FROM messages WHERE ${where.join(' AND ')}
         GROUP BY rid, ntxt, b
         HAVING c >= ${Math.max(3, Math.ceil(Number(minCount) / 2))}`
      )
      .all(...args);
    if (!cand.length) {
      this.db.prepare('DELETE FROM flood_events WHERE event_start >= ?').run(scanFrom);
      return { events: 0, candidates: 0 };
    }

    // 第二段：对候选桶评估它的两个滑动窗口，精确算 distinct uid
    const probe = this.db.prepare(
      `SELECT COUNT(*) AS c, COUNT(DISTINCT uid) AS u, MIN(cst) AS f, MAX(cst) AS t
       FROM messages
       WHERE rid = ? AND ntxt = ? AND kind = 'chat' AND cst >= ? AND cst < ?`
    );
    const hits = new Map();
    const seenWin = new Set();
    for (const c of cand) {
      const base = c.b * binMs;
      for (const start of [base - binMs, base]) {
        const key = `${c.rid}|${c.ntxt}|${start}`;
        if (seenWin.has(key)) continue;
        seenWin.add(key);
        const win = probe.get(c.rid, c.ntxt, start, start + windowMs);
        if (!win || win.c < minCount || win.u < minUsers) continue;
        const gk = `${c.rid}|${c.ntxt}`;
        const arr = hits.get(gk) || [];
        arr.push({ s: Number(win.f), e: Number(win.t) + 1 });
        hits.set(gk, arr);
      }
    }

    // 合并相邻窗口：间隔 ≤ gapMs 且总时长 ≤ maxDurMs 才算同一次潮
    const events = [];
    for (const [gk, wins] of hits) {
      const [r, phrase] = gk.split('|');
      wins.sort((a, b) => a.s - b.s);
      const merged = [];
      for (const w of wins) {
        const last = merged[merged.length - 1];
        if (last && w.s - last.e <= gapMs && Math.max(last.e, w.e) - last.s <= maxDurMs) {
          last.e = Math.max(last.e, w.e);
        } else merged.push({ s: w.s, e: w.e });
      }
      for (const m of merged) events.push({ rid: Number(r), phrase, s: m.s, e: m.e });
    }

    // 事件的真实条数/人数要按整段重算（窗口有重叠，不能相加）
    const stat = this.db.prepare(
      `SELECT COUNT(*) AS c, COUNT(DISTINCT uid) AS u, MIN(cst) AS f
       FROM messages WHERE rid = ? AND ntxt = ? AND kind = 'chat' AND cst >= ? AND cst < ?`
    );
    const firstRow = this.db.prepare(
      `SELECT uid, nn, cst FROM messages
       WHERE rid = ? AND ntxt = ? AND kind = 'chat' AND cst >= ? AND cst < ?
       ORDER BY cst ASC, id ASC LIMIT 1`
    );

    this.db.prepare('DELETE FROM flood_events WHERE event_start >= ? AND rid IN (SELECT DISTINCT rid FROM messages WHERE cst >= ?)')
      .run(scanFrom, scanFrom);

    const ins = this.stmt(
      `INSERT OR REPLACE INTO flood_events
        (rid, event_start, phrase, stem, room_name, msg_count, user_count, dur_ms, topic, first_uid, first_nn, first_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const roomName = new Map();
    for (const r of this.db.prepare('SELECT rid, name FROM rooms').all()) roomName.set(Number(r.rid), r.name);

    let n = 0;
    this.exec('BEGIN IMMEDIATE');
    try {
      for (const ev of events) {
        const s = stat.get(ev.rid, ev.phrase, ev.s, ev.e);
        if (!s || s.c < minCount) continue;
        const f = firstRow.get(ev.rid, ev.phrase, ev.s, ev.e) || {};
        ins.run(
          ev.rid,
          Number(ev.s),
          ev.phrase,
          stemOf(ev.phrase),
          roomName.get(ev.rid) || '',
          Number(s.c),
          Number(s.u),
          Number(ev.e) - Number(ev.s),
          classify(ev.phrase),
          String(f.uid || ''),
          f.nn || '',
          Number(f.cst) || Number(ev.s),
          Date.now()
        );
        n++;
      }
      this.exec('COMMIT');
    } catch (err) {
      this.exec('ROLLBACK');
      throw err;
    }
    return { events: n, candidates: cand.length };
  }

  listFloods({ rid = 0, from = 0, to = 0, limit = 30, topic = '' } = {}) {
    const where = ['1 = 1'];
    const args = [];
    if (rid) {
      where.push('rid = ?');
      args.push(Number(rid));
    }
    if (from) {
      where.push('event_start >= ?');
      args.push(Number(from));
    }
    if (to) {
      where.push('event_start <= ?');
      args.push(Number(to));
    }
    if (topic) {
      where.push('topic = ?');
      args.push(String(topic));
    }
    return this.db
      .prepare(
        `SELECT rid, event_start, phrase, room_name, msg_count, user_count, dur_ms, topic, first_uid, first_nn, first_at
         FROM flood_events WHERE ${where.join(' AND ')}
         ORDER BY event_start DESC LIMIT ?`
      )
      .all(...args, Math.min(Number(limit) || 30, 300));
  }

  /** 某时间窗内落在弹幕潮里的 (rid, phrase, start, end)：供检索的共现挖掘剔除刷屏窗口 */
  floodRanges(rid, from, to) {
    return this.db
      .prepare(
        `SELECT rid, phrase, event_start AS s, event_start + dur_ms AS e
         FROM flood_events WHERE rid = ? AND event_start + dur_ms >= ? AND event_start <= ?`
      )
      .all(Number(rid), Number(from), Number(to));
  }

  /** 跟风度：这个用户有多少条发言落在弹幕潮窗口里（用 flood_events 一次 join 算完） */
  floodShare(uid) {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n,
                SUM(CASE WHEN EXISTS (
                  SELECT 1 FROM flood_events f
                  WHERE f.rid = m.rid AND f.phrase = m.ntxt
                    AND m.cst >= f.event_start AND m.cst < f.event_start + f.dur_ms
                ) THEN 1 ELSE 0 END) AS hit
         FROM messages m WHERE m.uid = ? AND m.kind = 'chat'`
      )
      .get(String(uid));
    const n = row ? Number(row.n) || 0 : 0;
    const hit = row ? Number(row.hit) || 0 : 0;
    return { total: n, inFlood: hit, share: n ? hit / n : 0 };
  }

  /**
   * 记一次采集缺口。只在重连成功时调用一次（断线重试期间不写，避免被退避碎片刷满）。
   * - 短于 MIN_GAP_MS 的抖动直接丢弃；
   * - 和已有缺口相邻（间隔 < MERGE_MS）时合并成一条，retries 累加。
   */
  addGap({ rid, from, to, retries = 0, minGapMs = 10000, mergeMs = 10000, reason = 'reconnect' }) {
    const a = Number(from) || 0;
    const b = Number(to) || 0;
    if (!a || !b || b <= a) return null;
    if (b - a < minGapMs) return null;

    const near = this.db
      .prepare(
        `SELECT * FROM gaps
         WHERE rid = ? AND filled_by IS NULL
           AND from_cst <= ? AND to_cst >= ?
         ORDER BY from_cst DESC LIMIT 1`
      )
      .get(Number(rid), b + mergeMs, a - mergeMs);

    if (near) {
      const nFrom = Math.min(Number(near.from_cst), a);
      const nTo = Math.max(Number(near.to_cst), b);
      this.db
        .prepare(
          'UPDATE gaps SET from_cst = ?, to_cst = ?, dur_ms = ?, retries = retries + ?, reason = ? WHERE id = ?'
        )
        .run(nFrom, nTo, nTo - nFrom, Number(retries) || 0, reason, near.id);
      return { id: near.id, merged: true, from: nFrom, to: nTo, durMs: nTo - nFrom, reason };
    }

    const res = this.db
      .prepare(
        'INSERT INTO gaps (rid, from_cst, to_cst, dur_ms, retries, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(Number(rid), a, b, b - a, Number(retries) || 0, reason, Date.now());
    return { id: Number(res.lastInsertRowid), merged: false, from: a, to: b, durMs: b - a, reason };
  }

  listGaps({ rid = 0, from = 0, to = 0, limit = 50 } = {}) {
    const where = [];
    const args = [];
    if (rid) {
      where.push('rid = ?');
      args.push(Number(rid));
    }
    if (from) {
      where.push('to_cst >= ?');
      args.push(Number(from));
    }
    if (to) {
      where.push('from_cst <= ?');
      args.push(Number(to));
    }
    const sql = `SELECT * FROM gaps ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY from_cst DESC LIMIT ?`;
    return this.db.prepare(sql).all(...args, Number(limit));
  }

  /** 缺口总量：条数 + 毫秒。filled_by 不为空的（已用录播补上）不算。 */
  gapTotal({ rid = 0, from = 0, to = 0, includeFilled = false } = {}) {
    const where = [];
    const args = [];
    if (rid) {
      where.push('rid = ?');
      args.push(Number(rid));
    }
    if (from) {
      where.push('to_cst >= ?');
      args.push(Number(from));
    }
    if (to) {
      where.push('from_cst <= ?');
      args.push(Number(to));
    }
    if (!includeFilled) where.push('filled_by IS NULL');
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(dur_ms), 0) AS ms FROM gaps
                ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`)
      .get(...args);
    return { count: Number(row.n) || 0, ms: Number(row.ms) || 0 };
  }

  /** 用录播补上某段缺口后调用：标记为已填充，画像就不再把它当盲区。 */
  markGapFilled(rid, from, to, showId) {
    return this.db
      .prepare(
        `UPDATE gaps SET filled_by = ?
         WHERE rid = ? AND filled_by IS NULL AND from_cst <= ? AND to_cst >= ?`
      )
      .run(String(showId), Number(rid), Number(to), Number(from));
  }

  /** 有效采集时间 = 跨度 − 缺口，画像的分母要用这个。 */
  coverage({ rid = 0, from = 0, to = 0 } = {}) {
    const where = ['kind = \'chat\''];
    const args = [];
    if (rid) {
      where.push('rid = ?');
      args.push(Number(rid));
    }
    if (from) {
      where.push('cst >= ?');
      args.push(Number(from));
    }
    if (to) {
      where.push('cst <= ?');
      args.push(Number(to));
    }
    const row = this.db
      .prepare(`SELECT MIN(cst) AS a, MAX(cst) AS b, COUNT(*) AS n FROM messages WHERE ${where.join(' AND ')}`)
      .get(...args);
    const first = Number(row.a) || 0;
    const last = Number(row.b) || 0;
    const spanMs = last > first ? last - first : 0;
    const gap = this.gapTotal({ rid, from, to });
    const effectiveMs = Math.max(0, spanMs - gap.ms);
    const split = this.gapBreakdown({ rid, from, to });
    return {
      first,
      last,
      spanMs,
      gapCount: gap.count,
      gapMs: gap.ms,
      effectiveMs,
      messages: Number(row.n) || 0,
      downtimeCount: split.downtime.count,
      downtimeMs: split.downtime.ms,
    };
  }

  /** 缺口按原因拆分：reconnect（运行中被掐）/ downtime（程序没开）。 */
  gapBreakdown({ rid = 0, from = 0, to = 0 } = {}) {
    const where = ['filled_by IS NULL'];
    const args = [];
    if (rid) {
      where.push('rid = ?');
      args.push(Number(rid));
    }
    if (from) {
      where.push('to_cst >= ?');
      args.push(Number(from));
    }
    if (to) {
      where.push('from_cst <= ?');
      args.push(Number(to));
    }
    const rows = this.db
      .prepare(
        `SELECT COALESCE(reason, 'reconnect') AS reason, COUNT(*) AS n, COALESCE(SUM(dur_ms), 0) AS ms
         FROM gaps WHERE ${where.join(' AND ')} GROUP BY COALESCE(reason, 'reconnect')`
      )
      .all(...args);
    const out = { reconnect: { count: 0, ms: 0 }, downtime: { count: 0, ms: 0 } };
    for (const r of rows) {
      const key = r.reason === 'downtime' ? 'downtime' : 'reconnect';
      out[key] = { count: Number(r.n) || 0, ms: Number(r.ms) || 0 };
    }
    return out;
  }

  /** 消息里出现过、但 rooms 表里没有的房间（房间记录被删/丢失时，历史不该跟着消失）。 */
  messageRoomSummary() {
    return this.db
      .prepare(
        `SELECT rid, MAX(room_name) AS name, COUNT(*) AS n, MAX(cst) AS last,
                SUM(CASE WHEN source = 'vod' THEN 1 ELSE 0 END) AS vod
         FROM messages GROUP BY rid`
      )
      .all()
      .map((r) => ({
        rid: Number(r.rid),
        name: r.name || '',
        n: Number(r.n) || 0,
        last: Number(r.last) || 0,
        vodOnly: Number(r.n) > 0 && Number(r.vod) === Number(r.n),
      }));
  }

  touchRooms(rows) {
    this.assertDbFile();
    const byRoom = new Map();
    for (const r of rows) {
      const cur = byRoom.get(r.rid) || { n: 0, last: 0 };
      cur.n++;
      cur.last = Math.max(cur.last, Number(r.cst) || 0);
      byRoom.set(r.rid, cur);
    }
    const upd = this.stmt(
      'UPDATE rooms SET msg_count = msg_count + ?, last_msg_at = MAX(COALESCE(last_msg_at, 0), ?) WHERE rid = ?'
    );
    for (const [rid, v] of byRoom) upd.run(v.n, v.last, rid);
  }

  // ---------- 收藏 ----------

  /** 这句说法最常出现在哪个房间（收藏时没指定房间就用它） */
  roomOfStem(stem) {
    const s = String(stem || '').trim();
    if (!s) return 0;
    const row = this.stmt(
      `SELECT rid FROM messages
        WHERE COALESCE(NULLIF(stem, ''), txt) = ? AND kind = 'chat'
        GROUP BY rid ORDER BY COUNT(*) DESC LIMIT 1`
    ).get(s);
    return row ? Number(row.rid) : 0;
  }

  addFavorite({ rid, stem, txt, roomName, uid, nn, cst, note = '' }) {
    const r = Number(rid);
    const s = String(stem || '').trim();
    if (!r || !s) throw new Error('缺少房间或说法');
    const existed = this.isFavorite(r, s);
    const info = this.stmt(
      `INSERT INTO favorites (rid, stem, txt, room_name, uid, nn, cst, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(rid, stem) DO UPDATE SET note = excluded.note`
    ).run(r, s, String(txt || s), roomName || '', String(uid || ''), nn || '', Number(cst) || 0, note, Date.now());
    return { id: Number(info.lastInsertRowid), rid: r, stem: s, existed };
  }

  removeFavorite(id) {
    const r = this.stmt('DELETE FROM favorites WHERE id = ?').run(Number(id));
    return r.changes > 0;
  }

  /** 收藏列表：顺带把「现在有多少条 / 多少人」算出来，方便看这句还热不热 */
  listFavorites({ rid = 0, limit = 200 } = {}) {
    const where = rid ? 'WHERE f.rid = ?' : '';
    const args = rid ? [Number(rid)] : [];
    return this.db
      .prepare(
        `SELECT f.*, r.name AS live_room_name,
                (SELECT COUNT(*) FROM messages m
                  WHERE m.rid = f.rid AND COALESCE(NULLIF(m.stem,''), m.txt) = f.stem AND m.kind='chat') AS hits,
                (SELECT COUNT(DISTINCT m.uid) FROM messages m
                  WHERE m.rid = f.rid AND COALESCE(NULLIF(m.stem,''), m.txt) = f.stem AND m.kind='chat') AS users
           FROM favorites f LEFT JOIN rooms r ON r.rid = f.rid
           ${where}
          ORDER BY f.created_at DESC
          LIMIT ?`
      )
      .all(...args, Number(limit));
  }

  isFavorite(rid, stem) {
    return !!this.db
      .prepare('SELECT 1 FROM favorites WHERE rid = ? AND stem = ?')
      .get(Number(rid), String(stem));
  }

  // ---------- 录播导入 ----------

  saveVodImport(info) {
    this.stmt(
      `INSERT INTO vod_imports (show_id, vid, title, room_id, duration, total, imported, imported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(show_id) DO UPDATE SET
         title = excluded.title, room_id = excluded.room_id, duration = excluded.duration,
         total = excluded.total, imported = vod_imports.imported + excluded.imported,
         imported_at = excluded.imported_at`
    ).run(
      String(info.showId),
      String(info.vid || ''),
      info.title || '',
      Number(info.roomId) || 0,
      Number(info.duration) || 0,
      Number(info.total) || 0,
      Number(info.imported) || 0,
      Date.now()
    );
  }

  getVodImport(showId) {
    return this.stmt('SELECT * FROM vod_imports WHERE show_id = ?').get(String(showId));
  }

  listVodImports() {
    return this.stmt('SELECT * FROM vod_imports ORDER BY imported_at DESC LIMIT 200').all();
  }

  deleteVod(showId) {
    const r = this.stmt("DELETE FROM messages WHERE source = 'vod' AND ext LIKE ?").run(`vod:${showId}:%`);
    this.stmt('DELETE FROM vod_imports WHERE show_id = ?').run(String(showId));
    return Number(r.changes) || 0;
  }

  // ---------- 查询 ----------

  /**
   * 关键词检索（归一化子串匹配）。
   * @param {string[]} terms 归一化后的检索词
   */
  searchMessages(terms, { rid, from, to, limit = 300, offset = 0, cap = 2000 } = {}) {
    if (!terms.length) return [];
    const where = [];
    const args = [];
    const clauses = terms.map(() => 'ntxt LIKE ?');
    for (const t of terms) args.push(`%${t}%`);
    where.push(`(${clauses.join(' OR ')})`);
    if (rid) {
      where.push('rid = ?');
      args.push(Number(rid));
    }
    if (from) {
      where.push('cst >= ?');
      args.push(Number(from));
    }
    if (to) {
      where.push('cst <= ?');
      args.push(Number(to));
    }
    const sql =
      `SELECT id, rid, room_name, uid, nn, txt, cst, level, bnn, bl, brid, kind, source
       FROM messages WHERE ${where.join(' AND ')}
       ORDER BY cst DESC LIMIT ? OFFSET ?`;
    args.push(Math.min(Number(limit) || 300, Number(cap) || 2000), Number(offset) || 0);
    return this.db.prepare(sql).all(...args);
  }

  /**
   * 按句子聚合召回结果：同一句话（stem 相同）只出一行，带上「多少条 / 多少人 / 首末时间」。
   * 弹幕潮里 24 个人刷同一句，逐条列出来没有信息量——列表该按句收敛，证据再展开。
   */
  groupByTerms(terms, { rid, from, to, limit = 40 } = {}) {
    if (!terms.length) return [];
    const where = [];
    const args = [];
    where.push(`(${terms.map(() => 'ntxt LIKE ?').join(' OR ')})`);
    for (const t of terms) args.push(`%${t}%`);
    where.push("kind = 'chat'");
    if (rid) {
      where.push('rid = ?');
      args.push(Number(rid));
    }
    if (from) {
      where.push('cst >= ?');
      args.push(Number(from));
    }
    if (to) {
      where.push('cst <= ?');
      args.push(Number(to));
    }
    const groups = this.db
      .prepare(
        `SELECT COALESCE(NULLIF(stem, ''), txt) AS g, COUNT(*) AS n, COUNT(DISTINCT uid) AS u,
                MIN(cst) AS f, MAX(cst) AS l
         FROM messages WHERE ${where.join(' AND ')}
         GROUP BY g ORDER BY n DESC, l DESC LIMIT ?`
      )
      .all(...args, Math.min(Number(limit) || 40, 200));

    // 样本取法：一次 IN 查询把前 N 组的最新若干行全取回来，再在内存里挑每组的「最长那一版」。
    // 原来是对每组各跑一次 `WHERE COALESCE(NULLIF(stem,''),txt) = ?`——表达式用不上索引，
    // 等于每组一次全表扫，40 组就是 40 次扫，测出来 322ms 全耗在这。
    const keys = groups.map((g) => g.g);
    const samples = new Map();
    if (keys.length) {
      const rows = this.db
        .prepare(
          `SELECT COALESCE(NULLIF(stem, ''), txt) AS g, id, rid, room_name, uid, nn, txt, cst, level, bnn, bl, source
           FROM messages
           WHERE COALESCE(NULLIF(stem, ''), txt) IN (${keys.map(() => '?').join(',')}) AND kind = 'chat'
           ORDER BY cst DESC
           LIMIT ?`
        )
        .all(...keys, Math.min(keys.length * 30, 4000));
      for (const r of rows) {
        const cur = samples.get(r.g);
        if (!cur) samples.set(r.g, r);
        else if ((r.txt || '').length > (cur.txt || '').length) samples.set(r.g, r);
      }
    }

    return groups.map((g) => {
      const sample = samples.get(g.g) || { txt: g.g, cst: g.f };
      return {
        stem: g.g,
        n: Number(g.n),
        users: Number(g.u),
        first: Number(g.f),
        last: Number(g.l),
        id: sample.id,
        rid: sample.rid,
        room: sample.room_name,
        uid: sample.uid,
        nn: sample.nn,
        txt: sample.txt,
        disp: stripAffixes(stripMention(sample.txt || '')) || stripMention(sample.txt || ''),
        cst: sample.cst,
        level: sample.level,
        badge: sample.bnn ? `${sample.bnn} ${sample.bl}` : '',
        source: sample.source,
      };
    });
  }

  /** 某句话是哪些人在发：按人聚合，给「重复」一个可核对的下钻。 */
  sendersOfStem(g, { rid = 0, limit = 20 } = {}) {
    const where = ["COALESCE(NULLIF(stem, ''), txt) = ?", "kind = 'chat'"];
    const args = [String(g)];
    if (rid) {
      where.push('rid = ?');
      args.push(Number(rid));
    }
    return this.db
      .prepare(
        `SELECT uid, MAX(nn) AS nn, COUNT(*) AS n, MIN(cst) AS first, MAX(cst) AS last, MAX(source) AS source
         FROM messages WHERE ${where.join(' AND ')}
         GROUP BY uid ORDER BY last DESC, n DESC LIMIT ?`
      )
      .all(...args, Math.min(Number(limit) || 20, 100))
      .map((r) => ({
        uid: r.uid,
        nn: r.nn,
        n: Number(r.n),
        first: Number(r.first),
        last: Number(r.last),
        source: r.source,
      }));
  }

  /**
   * 排行榜：一段时间内发弹幕最多的人。
   * 按 uid 聚合，昵称取最后一次出现（改名后以新昵称为准），同时给出跨了几个房间。
   */
  topSenders({ rid, from, to, limit = 20 } = {}) {
    const where = ["kind = 'chat'"];
    const args = [];
    if (rid) {
      where.push('rid = ?');
      args.push(Number(rid));
    }
    if (from != null) {
      where.push('cst >= ?');
      args.push(Number(from));
    }
    if (to != null) {
      where.push('cst <= ?');
      args.push(Number(to));
    }
    return this.db
      .prepare(
        `SELECT uid, MAX(nn) AS nn, COUNT(*) AS n, COUNT(DISTINCT rid) AS rooms,
                MIN(cst) AS first, MAX(cst) AS last, MAX(level) AS level
         FROM messages WHERE ${where.join(' AND ')}
         GROUP BY uid ORDER BY n DESC, last DESC LIMIT ?`
      )
      .all(...args, Math.min(Number(limit) || 20, 100))
      .map((r) => ({
        uid: r.uid,
        nn: r.nn,
        n: Number(r.n),
        rooms: Number(r.rooms),
        first: Number(r.first),
        last: Number(r.last),
        level: Number(r.level) || 0,
      }));
  }

  /**
   * 排行榜：一段时间内「被 +1 最多」的说法。
   * +1 次数 = 同一种说法的条数 − 1（第一条是首发，其余都是跟发）。
   * 按 stem 聚合，所以「哈哈哈」和「哈哈哈哈哈」算同一条；每行给出最典型的写法。
   */
  topPlusOne({ rid, from, to, limit = 20 } = {}) {
    // 复用 topPhrases：它用窗口函数一次就把每组的最长原文取出来。
    // 早先这里是「先聚合、再对每个组各查一次最长样本」，而那个 WHERE 是表达式、
    // 用不上索引，100 条榜要跑 100 次全表扫描（实测 2.6 秒）。
    return this.topPhrases({ rid, from, to, limit, min: 2 }).map((r) => ({
      ...r,
      plusOne: Number(r.n) - 1,
    }));
  }

  /**
   * 时间段内「说法」排行：按出现次数降序。
   * topPlusOne 是给排行榜看的（+1 口径），这个给时间线框选用（纯次数）。
   */
  topPhrases({ rid, from, to, limit = 50, min = 2 } = {}) {
    const where = ["kind = 'chat'"];
    const args = [];
    if (rid) {
      where.push('rid = ?');
      args.push(Number(rid));
    }
    if (from != null) {
      where.push('cst >= ?');
      args.push(Number(from));
    }
    if (to != null) {
      where.push('cst <= ?');
      args.push(Number(to));
    }
    const w = where.join(' AND ');
    const lim = Math.min(Math.max(Number(limit) || 50, 1), 500);
    const groups = this.db
      .prepare(
        `SELECT COALESCE(NULLIF(stem, ''), txt) AS g,
                COUNT(*) AS n, COUNT(DISTINCT uid) AS users,
                MIN(cst) AS first, MAX(cst) AS last
           FROM messages WHERE ${w}
          GROUP BY g HAVING n >= ?
          ORDER BY n DESC, users DESC LIMIT ?`
      )
      .all(...args, Math.max(Number(min) || 1, 1), lim);
    if (!groups.length) return [];

    // 每组取一版"最长原文"当展示样本：一条查询用窗口函数拿，避免 N+1
    const marks = groups.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT g, txt FROM (
           SELECT COALESCE(NULLIF(stem, ''), txt) AS g, txt,
                  ROW_NUMBER() OVER (
                    PARTITION BY COALESCE(NULLIF(stem, ''), txt)
                    ORDER BY LENGTH(txt) DESC, id DESC
                  ) AS rn
             FROM messages WHERE ${w} AND COALESCE(NULLIF(stem, ''), txt) IN (${marks})
         ) WHERE rn = 1`
      )
      .all(...args, ...groups.map((g) => g.g));
    const sampleOf = new Map(rows.map((r) => [r.g, r.txt]));

    return groups.map((r) => {
      const sample = sampleOf.get(r.g) || r.g;
      return {
        phrase: r.g,
        n: Number(r.n),
        plusOne: Number(r.n) - 1,
        users: Number(r.users),
        first: Number(r.first),
        last: Number(r.last),
        sample,
        disp: stripAffixes(stripMention(sample)) || sample,
      };
    });
  }

  /** 指定房间/时间段的聊天原文，供词频统计用（新的在前） */
  chatRows({ rid, from, to, limit = 8000 } = {}) {
    const where = ["kind = 'chat'", 'ntxt != \'\''];
    const args = [];
    if (rid) {
      where.push('rid = ?');
      args.push(Number(rid));
    }
    if (from != null) {
      where.push('cst >= ?');
      args.push(Number(from));
    }
    if (to != null) {
      where.push('cst <= ?');
      args.push(Number(to));
    }
    return this.db
      .prepare(
        `SELECT rid, txt, ntxt, cst FROM messages
          WHERE ${where.join(' AND ')} ORDER BY cst DESC LIMIT ?`
      )
      .all(...args, Math.min(Math.max(Number(limit) || 8000, 1), 20000));
  }

  /** 时间线的分桶计数：返回稀疏数组 [{b, c}]，b 是从 from 起的第几个桶 */
  minuteSeries({ rid, from, to, bucketMs = 60000 } = {}) {
    const where = ["kind = 'chat'", 'cst >= ?', 'cst < ?'];
    const args = [Number(from), Number(to)];
    if (rid) {
      where.push('rid = ?');
      args.push(Number(rid));
    }
    const size = Math.max(Number(bucketMs) || 60000, 1000);
    return this.db
      .prepare(
        `SELECT CAST((cst - ?) / ${size} AS INTEGER) AS b, COUNT(*) AS c
           FROM messages WHERE ${where.join(' AND ')}
          GROUP BY b ORDER BY b`
      )
      .all(Number(from), ...args)
      .map((r) => ({ b: Number(r.b), c: Number(r.c) }));
  }

  /** 词频统计：命中词在指定时间范围内的出现次数（用于判断样本是否充足） */  countMatches(terms, { rid, from, to } = {}) {
    return this.countByTerms(terms, { rid, from, to });
  }

  /**
   * 精确计数：命中 include 任意一词、且不命中 exclude 任意一词的条数。
   * 检索的三路召回会重叠（精确命中的句子往往也含同义词），用 exclude 做互斥，
   * 这样「共 N 条」是真实条数，而不是把这一页拿到的行数当总数。
   */
  countByTerms(include, { exclude = [], rid, from, to } = {}) {
    if (!include.length) return 0;
    const where = [];
    const args = [];
    where.push(`(${include.map(() => 'ntxt LIKE ?').join(' OR ')})`);
    for (const t of include) args.push(`%${t}%`);
    for (const t of exclude) {
      where.push('ntxt NOT LIKE ?');
      args.push(`%${t}%`);
    }
    if (rid) {
      where.push('rid = ?');
      args.push(Number(rid));
    }
    if (from) {
      where.push('cst >= ?');
      args.push(Number(from));
    }
    if (to) {
      where.push('cst <= ?');
      args.push(Number(to));
    }
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM messages WHERE ${where.join(' AND ')}`)
      .get(...args);
    return Number(row.n) || 0;
  }

  /** 某段时间窗口内的弹幕（共现分析用） */
  windowMessages(rid, from, to, limit = 3000) {
    return this.db
      .prepare(
        `SELECT txt, ntxt, cst FROM messages
         WHERE rid = ? AND cst BETWEEN ? AND ? AND kind = 'chat'
         ORDER BY cst ASC LIMIT ?`
      )
      .all(Number(rid), Number(from), Number(to), limit);
  }

  /** 房间背景语料样本（最近 N 条） */
  roomSample(rid, limit = 5000) {
    return this.db
      .prepare(
        `SELECT txt, ntxt, cst FROM messages WHERE rid = ? AND kind = 'chat'
         ORDER BY cst DESC LIMIT ?`
      )
      .all(Number(rid), limit);
  }

  userMessages(uid, { rid, from, to, limit = 3000, cap = 200000 } = {}) {
    const where = ['uid = ?'];
    const args = [String(uid)];
    if (rid) {
      where.push('rid = ?');
      args.push(Number(rid));
    }
    if (from) {
      where.push('cst >= ?');
      args.push(Number(from));
    }
    if (to) {
      where.push('cst <= ?');
      args.push(Number(to));
    }
    args.push(Math.min(Number(limit) || 3000, Number(cap) || 200000));
    return this.db
      .prepare(
        `SELECT id, rid, room_name, uid, nn, txt, cst, level, bnn, bl, brid, kind, source
         FROM messages WHERE ${where.join(' AND ')}
         ORDER BY cst ASC LIMIT ?`
      )
      .all(...args);
  }

  // 分页取某用户的全部弹幕（按时间倒序，用自增 id 做游标；不聚合、不去重）
  // 关键词里的 % _ \ 要转义：不然用户输入一个 % 就把整库捞出来了
  static likeEscape(s) {
    return String(s).replace(/[\\%_]/g, (c) => '\\' + c);
  }

  userMessagesPage(uid, { beforeId = 0, limit = 200, rid = 0, q = '' } = {}) {
    const where = ['uid = ?'];
    const args = [String(uid)];
    if (rid) {
      where.push('rid = ?');
      args.push(Number(rid));
    }
    const kw = String(q || '').trim();
    if (kw) {
      where.push("ntxt LIKE ? ESCAPE '\\'");
      args.push(`%${Store.likeEscape(kw)}%`);
    }
    if (beforeId) {
      where.push('id < ?');
      args.push(Number(beforeId));
    }
    args.push(Math.min(Number(limit) || 200, 1000));
    const rows = this.db
      .prepare(
        `SELECT id, rid, room_name, uid, nn, txt, cst, level, bnn, bl, kind, source, topic
         FROM messages WHERE ${where.join(' AND ')}
         ORDER BY id DESC LIMIT ?`
      )
      .all(...args);
    return { rows, nextBefore: rows.length ? rows[rows.length - 1].id : 0 };
  }

  /** 这个用户说过的总条数；带 q 时给「匹配多少条」。 */
  userMessagesCount(uid, { rid = 0, q = '' } = {}) {
    const where = ['uid = ?'];
    const args = [String(uid)];
    if (rid) {
      where.push('rid = ?');
      args.push(Number(rid));
    }
    const kw = String(q || '').trim();
    if (kw) {
      where.push("ntxt LIKE ? ESCAPE '\\'");
      args.push(`%${Store.likeEscape(kw)}%`);
    }
    return Number(this.db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE ${where.join(' AND ')}`).get(...args).c);
  }


  userTotals(uid) {    return this.db
      .prepare(
        `SELECT COUNT(*) AS total, MIN(cst) AS first, MAX(cst) AS last,
                COUNT(DISTINCT rid) AS rooms, COUNT(DISTINCT date(cst/1000,'unixepoch','localtime')) AS days,
                MAX(level) AS max_level
         FROM messages WHERE uid = ? AND kind = 'chat'`
      )
      .get(String(uid));
  }

  userRoomBreakdown(uid, limit = 12) {
    return this.db
      .prepare(
        `SELECT rid, room_name, COUNT(*) AS n, MIN(cst) AS first, MAX(cst) AS last
         FROM messages WHERE uid = ? AND kind = 'chat'
         GROUP BY rid ORDER BY n DESC LIMIT ?`
      )
      .all(String(uid), limit);
  }

  userHourly(uid) {
    return this.db
      .prepare(
        `SELECT CAST(strftime('%H', cst/1000, 'unixepoch', 'localtime') AS INTEGER) AS h,
                COUNT(*) AS n
         FROM messages WHERE uid = ? AND kind = 'chat' GROUP BY h`
      )
      .all(String(uid));
  }

  /** 按天统计某个用户说了多少条（「历史弹幕」那张图用） */
  userDaily(uid, { days = 30 } = {}) {
    return this.db
      .prepare(
        `SELECT strftime('%Y-%m-%d', cst/1000, 'unixepoch', 'localtime') AS day,
                COUNT(*) AS n
           FROM messages WHERE uid = ? AND kind = 'chat'
          GROUP BY day ORDER BY day DESC LIMIT ?`
      )
      .all(String(uid), Number(days) || 30)
      .map((r) => ({ day: r.day, n: Number(r.n) }));
  }

  /** 关注列表 */
  addFollow({ uid, nn = '', note = '' }) {
    const u = String(uid || '').trim();
    if (!u) throw new Error('缺少用户 UID');
    const existed = !!this.db.prepare('SELECT 1 FROM follows WHERE uid = ?').get(u);
    this.db
      .prepare(
        `INSERT INTO follows (uid, nn, note, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(uid) DO UPDATE SET nn = excluded.nn, note = excluded.note`
      )
      .run(u, String(nn || ''), String(note || ''), Date.now());
    return { uid: u, existed };
  }

  /** 设为 / 取消特别关注（只影响列表分组，不影响采集） */
  setFollowSpecial(uid, special) {
    const info = this.db
      .prepare('UPDATE follows SET special = ? WHERE uid = ?')
      .run(special ? 1 : 0, String(uid || ''));
    return Number(info.changes) > 0;
  }

  removeFollow(uid) {
    const info = this.db.prepare('DELETE FROM follows WHERE uid = ?').run(String(uid || ''));
    return Number(info.changes) > 0;
  }

  isFollowing(uid) {
    return !!this.db.prepare('SELECT 1 FROM follows WHERE uid = ?').get(String(uid || ''));
  }

  followState(uid) {
    const r = this.db.prepare('SELECT special FROM follows WHERE uid = ?').get(String(uid || ''));
    return { following: !!r, special: !!(r && r.special) };
  }

  listFollows() {
    return this.db
      .prepare(
        `SELECT f.uid, f.nn, f.note, f.created_at, f.special,
                (SELECT COUNT(*) FROM messages m WHERE m.uid = f.uid AND m.kind = 'chat') AS total,
                (SELECT MAX(m.cst) FROM messages m WHERE m.uid = f.uid AND m.kind = 'chat') AS last_at,
                (SELECT m.nn FROM messages m WHERE m.uid = f.uid AND m.kind = 'chat'
                  ORDER BY m.cst DESC LIMIT 1) AS last_nn
           FROM follows f ORDER BY f.special DESC, f.created_at DESC`
      )
      .all()
      .map((r) => ({
        uid: String(r.uid),
        nn: r.nn || r.last_nn || '',
        note: r.note || '',
        created_at: Number(r.created_at),
        special: Number(r.special) === 1,
        total: Number(r.total),
        last_at: r.last_at ? Number(r.last_at) : 0,
      }));
  }

  userTopTexts(uid, limit = 15) {
    return this.db
      .prepare(
        `SELECT txt, COUNT(*) AS n FROM messages
         WHERE uid = ? AND kind = 'chat' AND length(txt) > 1
         GROUP BY txt ORDER BY n DESC LIMIT ?`
      )
      .all(String(uid), limit);
  }

  userBadges(uid) {
    return this.db
      .prepare(
        `SELECT bnn, bl, brid, COUNT(*) AS n FROM messages
         WHERE uid = ? AND bnn != '' AND kind = 'chat'
         GROUP BY bnn, bl, brid ORDER BY n DESC LIMIT 8`
      )
      .all(String(uid));
  }

  /** 送礼次数（非 chatmsg 事件条数） */
  userGifts(uid) {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM messages WHERE uid = ? AND kind != 'chat'`)
      .get(String(uid));
    return row ? Number(row.n) : 0;
  }

  /** 昵称或 uid 模糊查找用户；q 为空时按发言量列出活跃用户 */
  findUsers(q, limit = 20) {
    const raw = String(q || '').trim();
    if (!raw) {
      return this.db
        .prepare(
          `SELECT uid, nn, COUNT(*) AS n, MAX(cst) AS last, COUNT(DISTINCT rid) AS rooms
           FROM messages WHERE uid != '' GROUP BY uid ORDER BY n DESC LIMIT ?`
        )
        .all(Number(limit));
    }
    return this.db
      .prepare(
        `SELECT uid, nn, COUNT(*) AS n, MAX(cst) AS last, COUNT(DISTINCT rid) AS rooms
         FROM messages
         WHERE (uid = ? OR nn LIKE ?)
         GROUP BY uid, nn ORDER BY n DESC LIMIT ?`
      )
      .all(raw, `%${raw}%`, Number(limit));
  }

  stats() {
    const m = this.db
      .prepare('SELECT COUNT(*) AS total, COUNT(DISTINCT uid) AS users, MIN(cst) AS first, MAX(cst) AS last FROM messages')
      .get();
    const today = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM messages
         WHERE cst >= strftime('%s','now','localtime','start of day','utc') * 1000`
      )
      .get();
    const file = this.path || DB_PATH;
    const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
    // WAL 里可能还有没 checkpoint 的页，按 -wal 文件补上，避免界面显示偏小
    const wal = `${file}-wal`;
    const walSize = fs.existsSync(wal) ? fs.statSync(wal).size : 0;
    return { ...m, today: today.n, dbBytes: size + walSize };
  }

  metaGet(k, def = null) {
    const row = this.db.prepare('SELECT v FROM meta WHERE k = ?').get(k);
    return row ? row.v : def;
  }

  metaSet(k, v) {
    this.db
      .prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
      .run(k, String(v));
  }

  /**
   * 应用新的前后缀配置：存盘、生效、把历史弹幕的聚合键重算一遍。
   * 重算是必须的——不重算的话，只有新弹幕会用新规则，同一句话在新老数据里
   * 停在两个不同的 stem 上，列表看着还是「重复」。
   */
  applyAffixes(cfg) {
    const clean = {
      prefixes: [...new Set((cfg.prefixes || []).map((s) => String(s).trim()).filter(Boolean))],
      suffixes: [...new Set((cfg.suffixes || []).map((s) => String(s).trim()).filter(Boolean))],
    };
    setAffixes(clean);
    this.metaSet('affixes', JSON.stringify(clean));

    const rows = this.db.prepare("SELECT id, txt, stem FROM messages WHERE kind = 'chat'").all();
    const upd = this.db.prepare('UPDATE messages SET stem = ? WHERE id = ?');
    let changed = 0;
    this.db.exec('BEGIN');
    try {
      for (const r of rows) {
        const s = stemOf(r.txt);
        if (s !== r.stem) {
          upd.run(s, r.id);
          changed++;
        }
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return { changed, total: rows.length, ...getAffixes() };
  }

  getAffixes() {
    return getAffixes();
  }

  /** 保留策略：删除早于 N 天的弹幕 */  prune(days) {
    const cutoff = Date.now() - days * 86400000;
    const r = this.db.prepare('DELETE FROM messages WHERE cst < ?').run(cutoff);
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return Number(r.changes) || 0;
  }

  // ---------------------------------------------------------------- 词条归类

  /**
   * 给历史数据补 topic / stem，并修掉「归一化为空」的旧 ntxt（旧版把它们存成空串，
   * 导致纯表情弹幕检索不到、也算不进弹幕潮）。每次最多 limit 行，由调用方循环到返回 0。
   */
  backfillTopics(limit = 4000) {
    const rows = this.db
      .prepare(
        `SELECT id, txt FROM messages
         WHERE kind = 'chat' AND (topic IS NULL OR stem IS NULL OR ntxt = '')
         LIMIT ?`
      )
      .all(limit);
    if (!rows.length) return 0;
    const upd = this.stmt('UPDATE messages SET topic = ?, stem = ?, ntxt = ? WHERE id = ?');
    this.exec('BEGIN IMMEDIATE');
    try {
      for (const r of rows) upd.run(classify(r.txt || ''), stemOf(r.txt || ''), keyOf(r.txt), r.id);
      this.exec('COMMIT');
    } catch (err) {
      this.exec('ROLLBACK');
      throw err;
    }
    return rows.length;
  }

  /** 全站（或某房间）的类别分布 */
  topicStats({ rid = 0, from = 0, to = 0 } = {}) {
    const where = ["kind = 'chat'"];
    const args = [];
    if (rid) {
      where.push('rid = ?');
      args.push(Number(rid));
    }
    if (from) {
      where.push('cst >= ?');
      args.push(Number(from));
    }
    if (to) {
      where.push('cst <= ?');
      args.push(Number(to));
    }
    return this.db
      .prepare(
        `SELECT COALESCE(topic, 'chat') AS topic, COUNT(*) AS n
         FROM messages WHERE ${where.join(' AND ')}
         GROUP BY topic ORDER BY n DESC`
      )
      .all(...args);
  }

  /** 某个用户的类别偏好 */
  userTopics(uid) {
    return this.db
      .prepare(
        `SELECT COALESCE(topic, 'chat') AS topic, COUNT(*) AS n
         FROM messages WHERE uid = ? AND kind = 'chat'
         GROUP BY topic ORDER BY n DESC`
      )
      .all(String(uid));
  }

  /** 首创者：这句话最早出现在哪个房间、谁最先说的 */
  origin(ntxt, { rid = 0 } = {}) {
    const w = ["ntxt = ?", "kind = 'chat'"];
    const args = [String(ntxt)];
    if (rid) {
      w.push('rid = ?');
      args.push(Number(rid));
    }
    const total = this.db
      .prepare(`SELECT COUNT(*) AS n, COUNT(DISTINCT uid) AS u, MIN(cst) AS f, MAX(cst) AS l FROM messages WHERE ${w.join(' AND ')}`)
      .get(...args);
    const first = this.db
      .prepare(`SELECT rid, room_name, uid, nn, txt, cst, source FROM messages WHERE ${w.join(' AND ')} ORDER BY cst ASC, id ASC LIMIT 1`)
      .get(...args);
    const rooms = this.db
      .prepare(
        `SELECT rid, room_name, MIN(cst) AS f, MAX(cst) AS l, COUNT(*) AS c, COUNT(DISTINCT uid) AS u
         FROM messages WHERE ${w.join(' AND ')}
         GROUP BY rid ORDER BY f ASC`
      )
      .all(...args);
    const senders = this.db
      .prepare(
        `SELECT uid, MAX(nn) AS nn, COUNT(*) AS n, MIN(cst) AS f, MAX(cst) AS l
         FROM messages WHERE ${w.join(' AND ')}
         GROUP BY uid ORDER BY n DESC LIMIT 10`
      )
      .all(...args);
    return { total: total ? total.n : 0, users: total ? total.u : 0, first, rooms, senders };
  }

  /** 首发查询：按 stem 聚合，返回这句话在本房间的最早一条 + 复读次数 + 相关潮次数 */
  originOf(phraseOrStem, { rid = 0, by = 'stem' } = {}) {
    const col = by === 'ntxt' ? 'ntxt' : 'stem';
    // 单字、表情、纯符号都要能查——它们的 stem 可能是空串，退回原文键
    const val = by === 'ntxt' ? keyOf(phraseOrStem) : stemOf(phraseOrStem);
    if (!val) return null;
    const w = [`${col} = ?`, "kind = 'chat'"];
    const args = [val];
    if (rid) {
      w.push('rid = ?');
      args.push(Number(rid));
    }
    const agg = this.db
      .prepare(`SELECT COUNT(*) AS n, COUNT(DISTINCT uid) AS u FROM messages WHERE ${w.join(' AND ')}`)
      .get(...args);
    const first = this.db
      .prepare(
        `SELECT rid, room_name, uid, nn, txt, cst, source FROM messages
         WHERE ${w.join(' AND ')} ORDER BY cst ASC, id ASC LIMIT 1`
      )
      .get(...args);
    const rooms = this.db
      .prepare(
        `SELECT rid, room_name, COUNT(*) AS c, MIN(cst) AS f FROM messages
         WHERE ${w.join(' AND ')} GROUP BY rid ORDER BY f ASC`
      )
      .all(...args);
    const floods = rid
      ? this.db.prepare('SELECT COUNT(*) AS n FROM flood_events WHERE rid = ? AND stem = ?').get(Number(rid), val)
      : this.db.prepare('SELECT COUNT(*) AS n FROM flood_events WHERE stem = ?').get(val);
    return {
      phrase: val,
      total: agg ? Number(agg.n) : 0,
      users: agg ? Number(agg.u) : 0,
      plusOne: agg ? Math.max(0, Number(agg.n) - 1) : 0,
      floods: floods ? Number(floods.n) : 0,
      first: first || null,
      rooms,
    };
  }

  /** 跟风度：这个用户的发言里，有多少条落在弹幕潮窗口内（用事件表 join，一次算完） */
  userFloodShare(uid) {
    return this.floodShare(uid);
  }
}

module.exports = { Store, DB_PATH, DATA_DIR };
