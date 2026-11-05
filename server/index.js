'use strict';

/** 本地 HTTP 服务：REST API + SSE 实时推送 + 静态页面。 */

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Store } = require('./db');
const { Collector } = require('./collector');
const { normalize } = require('./text');
const analysis = require('./analysis');
const lexicon = require('./lexicon');
const vod = require('./vod');
const library = require('./library');
const { PRESETS } = require('./affixes');
const COPY = require('../shared/copy');

const HOST = process.env.DANMU_HOST || '127.0.0.1';
const PORT = Number(process.env.DANMU_PORT || 7788);
const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** YYYY-MM-DD → 本地时区那一天的 [from, to)；缺省是今天 */
function dayRange(input) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(input || ''));
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date();
  d.setHours(0, 0, 0, 0);
  const from = d.getTime();
  const pad = (x) => String(x).padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return { from, to: from + 24 * 3600 * 1000, date };
}

const store = new Store();
store.open();

// 测试/探针用：只打印「打算怎么打开界面」，不真的拉窗口
const DRY_RUN = process.env.DANMU_DRY === '1';

// ---------------------------------------------------------------- 界面偏好
// 时间线选区这类「应该跨窗口一致」的小状态放服务端，而不是 localStorage：
// 独立窗口用的是自己的 data/window-profile，和浏览器 profile 不是同一份存储。
function readPrefs() {
  try {
    const obj = JSON.parse(store.metaGet('prefs') || '{}');
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

function writePrefs(prefs) {
  const tl = (prefs && prefs.tlsel) || {};
  const keys = Object.keys(tl).slice(-400); // 只留最近 400 个选区，别让 meta 无限涨
  const slim = {};
  for (const k of keys) {
    const v = tl[k] || {};
    const a = Number(v.a);
    const b = Number(v.b);
    if (Number.isFinite(a) && Number.isFinite(b)) slim[k] = { a, b };
  }
  store.metaSet('prefs', JSON.stringify({ tlsel: slim }));
}

const collector = new Collector(store, {
  onLog: (msg) => console.log(`[${new Date().toLocaleTimeString('zh-CN')}] ${msg}`),
});

// ---------------------------------------------------------------- 界面设置
// 用户可以在设置页选「独立窗口」还是「浏览器标签」，以及关窗口时要不要停采集。
const UI_DEFAULTS = { windowMode: 'app', stopOnWindowClose: true, graceSec: 30, closeAction: 'tray' };

function getUISettings() {
  let saved = {};
  try {
    saved = JSON.parse(store.metaGet('ui') || '{}');
  } catch {
    saved = {};
  }
  const s = { ...UI_DEFAULTS, ...saved };
  if (s.windowMode !== 'app' && s.windowMode !== 'browser') s.windowMode = 'app';
  s.graceSec = Math.max(5, Math.min(600, Number(s.graceSec) || UI_DEFAULTS.graceSec));
  s.stopOnWindowClose = s.stopOnWindowClose !== false;
  if (s.closeAction !== 'stop') s.closeAction = 'tray'; // 关窗口后默认缩到托盘
  return s;
}

function saveUISettings(patch = {}) {
  // 只合并显式传入的字段：局部 patch（比如只改 closeAction）不该把 windowMode 重置成默认值
  const next = { ...getUISettings() };
  for (const k of ['windowMode', 'stopOnWindowClose', 'graceSec', 'closeAction']) {
    if (patch[k] !== undefined) next[k] = patch[k];
  }
  if (next.windowMode !== 'app' && next.windowMode !== 'browser') next.windowMode = 'app';
  next.graceSec = Math.max(5, Math.min(600, Number(next.graceSec) || UI_DEFAULTS.graceSec));
  next.stopOnWindowClose = next.stopOnWindowClose !== false;
  if (next.closeAction !== 'stop') next.closeAction = 'tray';
  store.metaSet('ui', JSON.stringify(next));
  return next;
}

function loadUserLexicon() {
  const file = path.join(ROOT, 'data', 'lexicon.json');
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const extra = JSON.parse(raw);
    lexicon.load(extra);
    console.log(`[词表] 已加载自定义词表 ${file}`);
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[词表] 读取失败：${err.message}`);
    lexicon.load(null);
  }
}
loadUserLexicon();

// ---------------------------------------------------------------- 自动清理
// README 承诺「默认保留 90 天」，那就得真的定时执行，而不是等用户点按钮。
// retentionDays = 0 表示永久保留：不自动删除任何东西。
let RETENTION_DAYS = Number(process.env.DANMU_RETENTION || store.metaGet('retentionDays') || 90);
if (!Number.isFinite(RETENTION_DAYS) || RETENTION_DAYS < 0) RETENTION_DAYS = 90;

function autoPrune() {
  try {
    if (RETENTION_DAYS <= 0) {
      // 永久保留：仍然记一次检查时间，界面上能看出定时器是活的
      store.metaSet('last_prune_at', String(Date.now()));
      return;
    }
    const removed = store.prune(RETENTION_DAYS);
    store.metaSet('last_prune_at', String(Date.now()));
    if (removed > 0) console.log(`[维护] 自动清理 ${removed} 条超过 ${RETENTION_DAYS} 天的弹幕`);
  } catch (err) {
    console.warn(`[维护] 自动清理失败：${err.message}`);
  }
}

/** 运行时观测：SSE 连接数、待落库缓冲、WAL 大小、内存。挂机测试时看这些，才知道"稳不稳"。 */
function runtimeInfo() {
  let walBytes = 0;
  try {
    walBytes = fs.statSync(store.path + '-wal').size;
  } catch {
    /* WAL 不存在就是 0 */
  }
  const mem = process.memoryUsage();
  let lateFrames = 0;
  for (const entry of collector.clients.values()) {
    lateFrames += (entry.client && entry.client.stats && entry.client.stats.lateFrames) || 0;
  }
  return {
    sseClients: clients.size,
    buffered: (collector.buffer || []).length,
    dropped: collector.dropped || 0,
    replayDropped: collector.replayDropped || 0,
    lateFrames,
    recentSeen: (collector.recent || new Map()).size,
    floodKept: collector.floodKept || 0,
    gapsWritten: collector.gapsWritten || 0,
    dupesStored: store.dupesCount(Date.now() - 86400000),
    replayLog: (collector.replayLog || []).slice(-5),
    walBytes,
    rssBytes: mem.rss,
    heapUsed: mem.heapUsed,
    uptimeSec: Math.round(process.uptime()),
    lastPruneAt: Number(store.metaGet('last_prune_at')) || null,
    retentionDays: RETENTION_DAYS,
  };
}

setTimeout(autoPrune, 60 * 1000).unref();
setInterval(autoPrune, 12 * 3600 * 1000).unref();

/** 回填 topic / stem（老库一次性），再定时重建弹幕潮事件 */
function backfillDerived() {
  try {
    let total = 0;
    for (;;) {
      const n = store.backfillTopics(4000);
      total += n;
      if (n < 4000) break;
    }
    if (total) console.log(`[维护] 回填词条分类 ${total} 条`);
    store.metaSet('topic_v1', String(Date.now()));
  } catch (err) {
    console.warn(`[维护] 回填失败：${err.message}`);
  }
}

function autoFloods() {
  try {
    const r = store.rebuildFloods({ since: Date.now() - 20 * 60000 });
    if (r.events) console.log(`[维护] 弹幕潮事件 ${r.events} 个（候选桶 ${r.candidates}）`);
  } catch (err) {
    console.warn(`[维护] 弹幕潮重建失败：${err.message}`);
  }
}

setTimeout(() => {
  backfillDerived();
  autoFloods();
}, 20 * 1000).unref();
setInterval(autoFloods, 60 * 1000).unref();

// ---------------------------------------------------------------- SSE

const clients = new Set();
// 关窗口即停采集：只要界面连过、又全部断开，就开始倒计时
let uiAttached = false;
let graceSince = 0;
let appWindowChild = null;

/** 在采房间 + 只存在于数据库里的房间（如录播导入的占位房间） */
function roomList() {
  const live = collector.list();
  const liveIds = new Set(live.map((r) => Number(r.rid)));
  const extra = store
    .listRooms()
    .filter((r) => !liveIds.has(Number(r.rid)))
    .map((r) => ({
      rid: r.rid,
      name: r.name,
      owner: r.owner,
      avatar: r.avatar,
      status: r.status || 'saved',
      port: null,
      received: 0,
      chats: 0,
      reconnects: 0,
      since: r.added_at,
      stored: r.msg_count,
      live: false,
    }));
  return live.concat(extra);
}

/**
 * rooms 表里的房间 + 只在 messages 里留下痕迹的房间（房间记录被删掉时，
 * 历史数据还在——不能让人以为数据没了，也不能让它悄悄不再采集）。
 */
function roomListFull() {
  const list = roomList();
  const seen = new Set(list.map((r) => Number(r.rid)));
  const counts = new Map();
  for (const o of store.messageRoomSummary()) {
    counts.set(o.rid, o.n);
    if (seen.has(o.rid)) continue;
    list.push({
      rid: o.rid,
      name: o.name,
      owner: '',
      avatar: '',
      status: o.vodOnly ? 'vod' : 'archived',
      port: null,
      received: 0,
      chats: 0,
      reconnects: 0,
      since: o.last,
      stored: o.n,
      live: false,
      archived: !o.vodOnly,
    });
  }
  // rooms.msg_count 是「本进程写过的条数」，重加房间会归零；
  // 侧栏要显示的是「库里这个房间一共多少条」，所以统一用 messages 的真实计数。
  for (const r of list) {
    // 不在采集列表里的房间，status 可能是上次从斗鱼取到的 live/offline，
    // 直接显示出来会让人误以为还在采——统一改写成「未采集」。
    if (r.live === false && r.status !== 'stopped' && r.status !== 'vod' && r.status !== 'archived') {
      r.status = 'saved';
    }
    const n = counts.get(Number(r.rid));
    if (n != null) r.stored = n;
  }
  return list;
}

function sseSend(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    /* 断开的连接由 close 事件清理 */
  }
}

function broadcast(event, data) {
  for (const res of clients) sseSend(res, event, data);
}

collector.on('messages', (rows) => {
  broadcast('messages', {
    rid: rows[0] && rows[0].rid,
    rows: rows.filter((r) => r.kind === 'chat').slice(-100),
    total: rows.length,
  });
});

collector.on('rooms', () => broadcast('rooms', roomListFull()));
collector.on('status', (st) => broadcast('status', st));

// ---------------------------------------------------------------- helpers

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

// ---------------------------------------------------------------- CSV 导出

const CSV_HEAD = ['时间', '房间', 'UID', '昵称', '等级', '粉丝牌', '来源', '命中', '内容'];

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 文件名里的时间戳，例如 20261104-1650 */
function stamp() {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
}

/** 加 BOM，Excel 直接双击打开中文不乱码 */
function sendCsv(res, filename, rows) {
  const lines = [CSV_HEAD.join(',')];
  for (const r of rows) {
    lines.push(
      [
        new Date(Number(r.cst) || 0).toLocaleString('zh-CN', { hour12: false }),
        r.room_name,
        r.uid,
        r.nn,
        r.level,
        r.bnn ? `${r.bnn}${r.bl ? ' ' + r.bl : ''}` : '',
        r.source === 'vod' ? '录播' : '直播',
        r.hitType || '',
        r.txt,
      ]
        .map(csvCell)
        .join(',')
    );
  }
  const body = '\uFEFF' + lines.join('\r\n');
  res.writeHead(200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="${filename}"`,
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readRawBody(req, limit = 512 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('文件太大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('JSON 解析失败'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  rel = decodeURIComponent(rel);
  const full = path.join(WEB, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!full.startsWith(WEB)) return json(res, 403, { ok: false, error: 'forbidden' });

  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    fs.createReadStream(full).pipe(res);
  });
}

// ---------------------------------------------------------------- 路由

async function handleApi(req, res, url) {
  const p = url.pathname.replace(/^\/api/, '') || '/';
  const q = url.searchParams;

  // 轻量探活：启动器用它判断服务是否已经就绪（不碰库、不带统计）
  if (p === '/ping' && req.method === 'GET') {
    return json(res, 200, { ok: true, app: 'danmu-radar', uptimeSec: Math.round(process.uptime()) });
  }

  // 概览
  if (p === '/stats' && req.method === 'GET') {
    return json(res, 200, {
      ok: true,
      ...store.stats(),
      coverage: store.coverage(),
      runtime: runtimeInfo(),
      rooms: roomListFull(),
    });
  }

  // 采集缺口：断线期间丢掉的时段。记下来是为了让画像扣分母，不是为了画虚线。
  if (p === '/gaps' && req.method === 'GET') {
    const rid = Number(q.get('rid')) || 0;
    const from = Number(q.get('from')) || 0;
    const to = Number(q.get('to')) || 0;
    return json(res, 200, {
      ok: true,
      gaps: store.listGaps({ rid, from, to, limit: Number(q.get('limit')) || 50 }),
      total: store.gapTotal({ rid, from, to }),
      coverage: store.coverage({ rid, from, to }),
    });
  }

  // 房间高频词：检索页搜索框下方的推荐位
  if (p === '/keywords' && req.method === 'GET') {
    const rid = Number(q.get('rid')) || 0;
    const hours = Math.min(Math.max(Number(q.get('hours')) || 2, 0.5), 720);
    const to = Date.now();
    const from = to - hours * 3600 * 1000;
    const t0 = Date.now();
    const r = analysis.keywords(store, {
      rid: rid || null,
      from,
      to,
      limit: Math.min(Math.max(Number(q.get('limit')) || 10, 1), 30),
    });
    return json(res, 200, { ...r, rid, hours, from, to, took: Date.now() - t0 });
  }

  // 时间线：某一天的分桶计数（默认每分钟一桶）
  if (p === '/timeline' && req.method === 'GET') {
    const rid = Number(q.get('rid')) || 0;
    const bucketMs = Math.min(Math.max(Number(q.get('bucketMs')) || 60000, 10000), 3600000);
    const { from, to, date } = dayRange(q.get('date'));
    const sparse = store.minuteSeries({ rid: rid || null, from, to, bucketMs });
    const n = Math.round((to - from) / bucketMs);
    const buckets = new Array(n).fill(0);
    let max = 0;
    let total = 0;
    for (const r of sparse) {
      if (r.b < 0 || r.b >= n) continue;
      buckets[r.b] = r.c;
      total += r.c;
      if (r.c > max) max = r.c;
    }
    return json(res, 200, { ok: true, date, from, to, bucketMs, total, max, buckets });
  }

  // 时间线框选：一段时间内出现过的说法，按重复次数降序
  if (p === '/timeline/top' && req.method === 'GET') {
    const rid = Number(q.get('rid')) || 0;
    const from = Number(q.get('from')) || 0;
    const to = Number(q.get('to')) || Date.now();
    if (!from || to <= from) return json(res, 400, { ok: false, error: '时间范围无效' });
    const t0 = Date.now();
    const rows = store.topPhrases({
      rid: rid || null,
      from,
      to,
      limit: Math.min(Math.max(Number(q.get('limit')) || 60, 1), 500),
      min: Math.max(Number(q.get('min')) || 2, 1),
    });
    return json(res, 200, {
      ok: true,
      from,
      to,
      took: Date.now() - t0,
      rows: rows.map((r) => ({ ...r, reason: `本段出现 ${r.n} 次` })),
    });
  }

  // 房间列表 / 添加
  if (p === '/rooms' && req.method === 'GET') {
    return json(res, 200, { ok: true, rooms: roomListFull(), saved: store.listRooms() });
  }

  if (p === '/rooms' && req.method === 'POST') {
    const body = await readBody(req);
    const inputs = body.inputs || (body.input ? [body.input] : []);
    if (!inputs.length) return json(res, 400, { ok: false, error: '请输入房间号' });

    const added = [];
    const failed = [];
    for (const input of inputs.slice(0, 10)) {
      try {
        const res = await collector.add(input, { persist: body.persist !== false });
        if (res) added.push(res.info || res);
      } catch (err) {
        failed.push({ input, error: err.message });
      }
    }
    return json(res, 200, { ok: added.length > 0, added, failed });
  }

  // /rooms/:rid 删除或停止
  const roomMatch = p.match(/^\/rooms\/(\d+)$/);
  if (roomMatch) {
    const rid = Number(roomMatch[1]);
    if (req.method === 'DELETE') {
      collector.stop(rid);
      // forget=1 是真的删数据：只删 rooms 行会留下孤儿弹幕，
      // 然后被「仅历史」兜底重新显示出来（用户看到的就是「删了又回来」）。
      let removed = 0;
      if (q.get('forget') === '1') {
        removed = store.deleteRoomData(rid);
        store.removeVodImportsByRoom(rid);
      } else {
        store.removeRoom(rid);
      }
      return json(res, 200, { ok: true, removed, rooms: roomListFull() });
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      if (body.action === 'stop') {
        collector.stop(rid);
        return json(res, 200, { ok: true, rooms: roomListFull() });
      }
      if (body.action === 'start') {
        const r = await collector.add(String(rid), { persist: false });
        return json(res, 200, { ok: true, room: r && r.info ? r.info : r, rooms: roomListFull() });
      }
    }
  }

  // 弹幕潮事件（按事件记账，不是按桶）
  if (p === '/floods' && req.method === 'GET') {
    const rows = store.listFloods({
      rid: q.get('rid') ? Number(q.get('rid')) : 0,
      from: q.get('from') ? Number(q.get('from')) : 0,
      to: q.get('to') ? Number(q.get('to')) : 0,
      topic: q.get('topic') || '',
      limit: q.get('limit') ? Number(q.get('limit')) : 30,
    });
    return json(res, 200, { ok: true, count: rows.length, rows });
  }

  // 首发查询：这句话在本房间最早是谁说的、被 +1 了多少次
  if (p === '/origin' && req.method === 'GET') {
    const txt = q.get('txt') || q.get('stem') || '';
    if (!txt) return json(res, 400, { ok: false, error: '缺少 phrases' });
    const info = store.originOf(txt, {
      rid: q.get('rid') ? Number(q.get('rid')) : 0,
      by: q.get('by') === 'ntxt' ? 'ntxt' : 'stem',
    });
    if (!info) return json(res, 200, { ok: false, error: '本地没有这句话的记录' });
    return json(res, 200, { ok: true, ...info, note: COPY.NOTE.firstSeen });
  }

  // 这句话是谁在发：给检索列表里「×24 条」一个可核对的下钻
  if (p === '/senders' && req.method === 'GET') {
    const g = q.get('stem') || q.get('txt') || '';
    if (!g) return json(res, 400, { ok: false, error: '缺少 stem' });
    return json(res, 200, {
      ok: true,
      stem: g,
      senders: store.sendersOfStem(g, {
        rid: q.get('rid') ? Number(q.get('rid')) : 0,
        limit: Number(q.get('limit')) || 20,
      }),
    });
  }

  // 前后缀折叠：desuwa / 喵 / 草… 这些口癖尾巴不该把同一句话拆成两种说法
  if (p === '/affixes' && req.method === 'GET') {
    return json(res, 200, { ok: true, presets: PRESETS, current: store.getAffixes() });
  }

  if (p === '/affixes' && req.method === 'POST') {
    const body = await readBody(req);
    const t0 = Date.now();
    const out = store.applyAffixes({
      prefixes: Array.isArray(body.prefixes) ? body.prefixes : [],
      suffixes: Array.isArray(body.suffixes) ? body.suffixes : [],
    });
    return json(res, 200, { ok: true, ...out, took: Date.now() - t0 });
  }

  // 排行榜：today=1 只看今天（本地零点起），否则看全部；两条榜共用一套时间口径
  if (p === '/board' && req.method === 'GET') {
    const rid = q.get('rid') ? Number(q.get('rid')) : 0;
    const limit = Math.min(Number(q.get('limit')) || 20, 100);
    // 三种口径：?date=YYYY-MM-DD 指定某天；?today=0 全部时间；缺省今天
    const dateArg = q.get('date');
    const allTime = !dateArg && q.get('today') === '0';
    const day = allTime ? null : dayRange(dateArg || '');
    const win = allTime
      ? { rid, from: null, to: null, limit }
      : { rid, from: day.from, to: dateArg ? day.to : Date.now(), limit };
    return json(res, 200, {
      ok: true,
      date: day ? day.date : null,
      from: win.from,
      to: win.to,
      users: store.topSenders(win),
      phrases: store.topPlusOne(win),
    });
  }

  // 界面设置：窗口模式、关窗口是否停采集
  if (p === '/ui' && req.method === 'GET') {
    return json(res, 200, {
      ok: true,
      ...getUISettings(),
      uiOpen: clients.size > 0,
      tray: trayAlive(),
      graceLeftSec: graceSince ? Math.max(0, Math.round((graceSince + getUISettings().graceSec * 1000 - Date.now()) / 1000)) : null,
    });
  }

  if (p === '/ui' && req.method === 'POST') {
    const body = await readBody(req);
    const before = getUISettings();
    const next = saveUISettings({
      windowMode: body.windowMode,
      stopOnWindowClose: body.stopOnWindowClose,
      graceSec: body.graceSec,
      closeAction: body.closeAction,
    });
    // 关窗口行为由 closeAction 决定：stop 时顺带把旧的开关同步过去
    if (body.closeAction) {
      next.stopOnWindowClose = next.closeAction === 'stop';
      store.metaSet('ui', JSON.stringify(next));
    }
    // 从「浏览器标签」切成「独立窗口」时，或者用户直接点了「现在开独立窗口」，立刻开一个
    let opened = false;
    if (body.open === true || body.openWindow === 'app' || (before.windowMode !== next.windowMode && next.windowMode === 'app')) {
      opened = openAppWindow();
    } else if (body.openWindow === 'browser') {
      // 「现在开启浏览器窗口」：不管当前模式，直接用默认浏览器开一个标签页
      opened = await openBrowser({ noApp: true, force: true });
    }
    return json(res, 200, { ok: true, ...next, opened });
  }

  // 退出：缩到托盘，或者停止采集（界面上的两选一）
  if (p === '/exit' && req.method === 'POST') {
    const body = await readBody(req);
    const action = body.action === 'stop' ? 'stop' : 'tray';
    const remember = body.remember !== false;
    if (remember) {
      const next = saveUISettings({ closeAction: action, stopOnWindowClose: action === 'stop' });
      store.metaSet('ui', JSON.stringify(next));
    }
    if (action === 'stop') {
      json(res, 200, { ok: true, action });
      setTimeout(() => shutdown('界面选择「停止采集」'), 200);
      return;
    }
    const hadAppWindow = !!appWindowChild;
    if (appWindowChild) {
      try {
        appWindowChild.kill();
      } catch {
        /* ignore */
      }
    }
    const ok = ensureTray();
    // closedWindow 告诉前端：独立窗口已经被我们关掉了；false 说明用户是在浏览器标签里看的，
    // 那个标签页得他自己关（脚本没法保证 window.close() 生效）。
    return json(res, 200, { ok: true, action: 'tray', tray: ok, closedWindow: hadAppWindow });
  }

  // 主动停止采集并退出（界面上的「停止并退出」按钮）
  if (p === '/shutdown' && req.method === 'POST') {
    const body = await readBody(req);
    if (body.confirm !== true) return json(res, 400, { ok: false, error: '需要 confirm:true' });
    json(res, 200, { ok: true });
    setTimeout(() => shutdown('界面请求退出'), 200);
    return;
  }


  if (p === '/admin/floods' && req.method === 'POST') {
    const body = await readBody(req);
    const since = Number(body.since) || Date.now() - 7 * 86400000;
    const r = store.rebuildFloods({
      rid: Number(body.rid) || 0,
      since,
      minUsers: Number(body.minUsers) || 3,
      minCount: Number(body.minCount) || 6,
    });
    console.log(`[维护] 重建弹幕潮：${r.events} 个事件 / ${r.candidates} 个候选桶`);
    return json(res, 200, { ok: true, ...r });
  }

  // 手动回填 topic / stem
  if (p === '/admin/backfill' && req.method === 'POST') {
    let total = 0;
    for (;;) {
      const n = store.backfillTopics(4000);
      total += n;
      if (n < 4000) break;
    }
    return json(res, 200, { ok: true, updated: total });
  }

  // 检索
  if (p === '/search' && req.method === 'GET') {    const keyword = q.get('q') || '';
    const result = analysis.search(store, {
      q: keyword,
      rid: q.get('rid') ? Number(q.get('rid')) : null,
      from: q.get('from') ? Number(q.get('from')) : null,
      to: q.get('to') ? Number(q.get('to')) : null,
      limit: q.get('limit') ? Number(q.get('limit')) : 200,
      synonym: q.get('synonym') !== '0',
      cooccur: q.get('cooccur') !== '0',
      log: (m) => console.warn(`[检索] ${m}`),
    });
    return json(res, 200, result);
  }

  // 导出检索结果（CSV，最多 5 万条）
  if (p === '/export/search' && req.method === 'GET') {
    const keyword = (q.get('q') || '').trim();
    if (!keyword) return json(res, 400, { ok: false, error: '缺少关键词' });
    const exact = normalize(keyword);
    const useSyn = q.get('synonym') !== '0';
    const syn = useSyn ? lexicon.synonymsOf(keyword) : [];
    const terms = [exact, ...syn.map((w) => normalize(w)).filter((n) => n && n !== exact)];
    const rows = store.searchMessages(terms, {
      rid: q.get('rid') ? Number(q.get('rid')) : null,
      from: q.get('from') ? Number(q.get('from')) : null,
      to: q.get('to') ? Number(q.get('to')) : null,
      limit: 50000,
      cap: 50000,
    });
    for (const r of rows) r.hitType = normalize(r.txt).includes(exact) ? '精确' : '同义';
    console.log(`[导出] 检索「${keyword}」→ ${rows.length} 条`);
    return sendCsv(res, `danmu-search-${stamp()}.csv`, rows);
  }

  // 导出某个用户的全部弹幕（CSV）
  const exportUser = p.match(/^\/export\/user\/(.+)$/);
  if (exportUser && req.method === 'GET') {
    const uid = decodeURIComponent(exportUser[1]);
    const rows = store.userMessages(uid, { limit: 200000, cap: 200000 });
    if (!rows.length) return json(res, 404, { ok: false, error: '本地没有该用户的弹幕' });
    console.log(`[导出] 用户 ${uid} → ${rows.length} 条`);
    return sendCsv(res, `danmu-user-${String(uid).replace(/[^\w-]/g, '_')}-${stamp()}.csv`, rows);
  }

  // 用户
  if (p === '/users' && req.method === 'GET') {
    return json(res, 200, { ok: true, users: store.findUsers(q.get('q') || '', 20) });
  }

  const userMatch = p.match(/^\/users\/([^/]+)$/);
  if (userMatch && req.method === 'GET') {
    const uid = decodeURIComponent(userMatch[1]);
    const result = analysis.profile(store, uid);
    if (result.ok) Object.assign(result, store.followState(uid));
    return json(res, result.ok ? 200 : 404, result);
  }

  // 某个用户的全部弹幕（分页，按时间倒序，不聚合不去重）
  const userMsgMatch = p.match(/^\/users\/(.+)\/messages$/);
  if (userMsgMatch && req.method === 'GET') {
    const uid = decodeURIComponent(userMsgMatch[1]);
    const limit = Math.min(Number(q.get('limit')) || 200, 1000);
    const out = store.userMessagesPage(uid, {
      beforeId: Number(q.get('before')) || 0,
      limit,
      rid: Number(q.get('rid')) || 0,
      q: q.get('q') || '',
    });
    const totals = store.userTotals(uid);
    const kw = (q.get('q') || '').trim();
    return json(res, 200, {
      ok: true,
      uid,
      q: kw,
      // total 是「当前查询匹配多少条」，totalAll 是这个用户一共说过多少条
      total: kw ? store.userMessagesCount(uid, { rid: Number(q.get('rid')) || 0, q: kw }) : totals.total,
      totalAll: totals.total,
      rows: out.rows,
      nextBefore: out.nextBefore,
      hasMore: out.rows.length === limit,
    });
  }

  // ---------------- 界面偏好（跨窗口一致） ----------------
  if (p === '/prefs' && req.method === 'GET') {
    return json(res, 200, { ok: true, prefs: readPrefs() });
  }

  if (p === '/prefs' && req.method === 'POST') {
    const body = await readBody(req);
    writePrefs(body && body.prefs);
    broadcast('prefs', {});
    return json(res, 200, { ok: true });
  }

  // ---------------- 关注 ----------------
  if (p === '/follows' && req.method === 'GET') {
    return json(res, 200, { ok: true, items: store.listFollows() });
  }

  if (p === '/follows' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const out = store.addFollow({ uid: body.uid, nn: body.nn || '', note: body.note || '' });
      // 别的窗口（浏览器标签 / 独立窗口）也要立刻看到
      broadcast('follows', { uid: String(body.uid) });
      return json(res, 200, { ok: true, ...out });
    } catch (err) {
      return json(res, 400, { ok: false, error: err.message });
    }
  }

  if (p.startsWith('/follows/') && req.method === 'POST') {
    // /follows/:uid/special {"special":true|false}
    const rest = p.slice('/follows/'.length);
    const uid = decodeURIComponent(rest.replace(/\/special$/, ''));
    if (!/\/special$/.test(rest)) return json(res, 404, { ok: false, error: '未知操作' });
    const body = await readBody(req);
    const ok = store.setFollowSpecial(uid, body.special !== false);
    if (ok) broadcast('follows', { uid });
    return json(res, 200, { ok: true, ...store.followState(uid) });
  }

  if (p.startsWith('/follows/') && req.method === 'DELETE') {
    const uid = decodeURIComponent(p.slice('/follows/'.length));
    const removed = store.removeFollow(uid);
    if (removed) broadcast('follows', { uid });
    return json(res, 200, { ok: true, removed });
  }

  // 最近消息
  if (p === '/messages' && req.method === 'GET') {
    const rid = q.get('rid') ? Number(q.get('rid')) : null;
    const limit = Math.min(Number(q.get('limit')) || 100, 500);
    const rows = rid
      ? store.recentMessages(rid, limit)
      : store.recentMessages(null, limit);
    return json(res, 200, { ok: true, rows });
  }

  // 设置 / 维护。retentionDays = 0 表示永久保留（不再自动清理）。
  if (p === '/maintenance' && req.method === 'POST') {
    const body = await readBody(req);
    const raw = body.retentionDays;
    const days = raw === 0 || raw === '0' ? 0 : Number(raw) > 0 ? Number(raw) : NaN;
    if (!Number.isFinite(days)) return json(res, 400, { ok: false, error: 'retentionDays 需要是 0 或正整数' });
    store.metaSet('retentionDays', String(days));
    RETENTION_DAYS = days;
    const removed = days > 0 ? store.prune(days) : 0;
    if (days === 0) console.log('[维护] 已改为永久保留，不再自动清理');
    return json(res, 200, { ok: true, removed, retentionDays: days });
  }

  if (p === '/lexicon' && req.method === 'GET') {
    return json(res, 200, { ok: true, groups: lexicon.GROUPS, ad: lexicon.AD_WORDS, aggressive: lexicon.AGGRESSIVE_WORDS });
  }

  // ---------------- 收藏 ----------------

  if (p === '/favorites' && req.method === 'GET') {
    const rid = Number(q.get('rid')) || 0;
    return json(res, 200, { ok: true, items: store.listFavorites({ rid }) });
  }

  if (p === '/favorites' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const stem = body.stem || body.txt;
      // 从排行榜/时间线收藏时可能没有具体房间（选的是「全部房间」），
      // 这时按这句说法在库里的主要来源房间落库，跟检索页收藏的行为保持一致。
      let rid = Number(body.rid) || 0;
      if (!rid && stem) rid = store.roomOfStem(stem) || 0;
      const out = store.addFavorite({
        rid,
        stem,
        txt: body.txt,
        roomName: body.roomName || '',
        uid: body.uid || '',
        nn: body.nn || '',
        cst: body.cst || 0,
        note: body.note || '',
      });
      broadcast('favorites', { id: out.id || 0 });
      // rid 可能被 roomOfStem 补成了真实房间，回给前端用来对齐星标的 key
      return json(res, 200, { ok: true, rid, ...out });
    } catch (err) {
      return json(res, 400, { ok: false, error: err.message });
    }
  }

  if (p.startsWith('/favorites/') && req.method === 'DELETE') {
    const id = Number(p.slice('/favorites/'.length));
    const removed = store.removeFavorite(id);
    if (removed) broadcast('favorites', { id });
    return json(res, 200, { ok: true, removed });
  }

  // ---------------- 库包分发 ----------------

  // 导出：直接下载一个 .db 库包（默认匿名）
  if (p === '/library/export' && req.method === 'GET') {
    const anon = q.get('anon') !== '0';
    const out = library.exportLibrary(store, {
      rid: Number(q.get('rid')) || 0,
      from: Number(q.get('from')) || 0,
      to: Number(q.get('to')) || 0,
      anon,
      name: q.get('name') || '',
    });
    const stamp = new Date().toISOString().slice(0, 10);
    const suffix = anon ? 'anon' : 'full';
    res.writeHead(200, {
      'content-type': 'application/vnd.sqlite3',
      'content-disposition': `attachment; filename="danmu-lib-${stamp}-${suffix}.db"`,
      'content-length': out.bytes,
      'x-lib-rows': String(out.rows),
      'x-lib-anon': anon ? '1' : '0',
    });
    const stream = fs.createReadStream(out.file);
    stream.pipe(res);
    stream.on('close', () => fs.rm(out.file, { force: true }, () => {}));
    stream.on('error', () => {
      fs.rm(out.file, { force: true }, () => {});
      if (!res.headersSent) json(res, 500, { ok: false, error: '导出失败' });
    });
    return;
  }

  // 导入：请求体就是库包文件本身（不搞 multipart，零依赖）
  if (p === '/library/import' && req.method === 'POST') {
    const buf = await readRawBody(req, 512 * 1024 * 1024);
    if (!buf.length) return json(res, 400, { ok: false, error: '没有收到文件' });
    const tmp = path.join(os.tmpdir(), `danmu-import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
    fs.writeFileSync(tmp, buf);
    try {
      const out = library.importLibrary(store, tmp, {
        onProgress: (x) => broadcast('libprogress', x),
      });
      broadcast('rooms', roomListFull());
      broadcast('stats', store.stats());
      return json(res, 200, { ok: true, ...out });
    } finally {
      fs.rm(tmp, { force: true }, () => {});
    }
  }



  if (p === '/vod' && req.method === 'GET') {
    return json(res, 200, { ok: true, imports: store.listVodImports() });
  }

  // 只查元信息：条数、时长，不下载
  if (p === '/vod/preview' && req.method === 'GET') {
    const showId = vod.parseShowId(q.get('input') || '');
    if (!showId) return json(res, 400, { ok: false, error: '没认出录播 ID' });
    const meta = await vod.fetchMeta(showId);
    const cnt = await vod.fetchCount(showId);
    const done = store.getVodImport(showId);
    return json(res, 200, { ok: true, ...meta, count: cnt.ok ? cnt.count : null, error: cnt.ok ? null : cnt.msg, done });
  }

  if (p === '/import/vod' && req.method === 'POST') {
    const body = await readBody(req);
    const input = body.input || '';
    if (!input) return json(res, 400, { ok: false, error: '请粘贴录播链接或 ID' });
    const result = await vod.importVod(store, input, {
      force: !!body.force,
      onProgress: (x) => broadcast('vodprogress', x),
    });
    if (result.ok) broadcast('stats', store.stats());
    return json(res, result.ok ? 200 : 400, result);
  }

  const vodMatch = p.match(/^\/vod\/([A-Za-z0-9]+)$/);
  if (vodMatch && req.method === 'DELETE') {
    const removed = store.deleteVod(vodMatch[1]);
    broadcast('stats', store.stats());
    return json(res, 200, { ok: true, removed });
  }

  return json(res, 404, { ok: false, error: `未知接口 ${p}` });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type');
  res.setHeader('access-control-allow-methods', 'GET,POST,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // SSE
  if (url.pathname === '/api/stream') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(': connected\n\n');
    clients.add(res);
    uiAttached = true;
    graceSince = 0;
    sseSend(res, 'hello', { rooms: roomListFull(), stats: store.stats() });
    const ping = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        /* ignore */
      }
    }, 25000);
    // 用 res 的 close：req 的 close 在 keep-alive 连接上不一定触发，会让 clients 永远留着一条
    res.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
    });
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    try {
      await handleApi(req, res, url);
    } catch (err) {
      console.error('[API]', err);
      if (!res.headersSent) json(res, 500, { ok: false, error: err.message });
      else res.end();
    }
    return;
  }

  // 共享文案字典：Node 和浏览器用同一份，保证 lint 检查的和页面显示的是同一个东西
  if (url.pathname === '/copy.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' });
    return fs.createReadStream(path.join(ROOT, 'shared', 'copy.js')).pipe(res);
  }

  serveStatic(req, res, url.pathname);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    // 双击 start.bat 第二次的时候最常见：端口被占说明已经开着一个了。
    // 这时候报错退出对用户没有帮助——直接把浏览器指到已有实例上。
    console.log('');
    console.log(`  [!] 端口 ${PORT} 已被占用，说明程序已经在运行了。`);
    console.log(`  ▶ 直接打开 http://${HOST}:${PORT}`);
    console.log('');
    if (process.env.DANMU_OPEN === '1') openBrowser();
    setTimeout(() => process.exit(0), 800);
    return;
  }
  throw err;
});

/**
 * 打开系统默认浏览器。
 * Windows 上「双击 bat → 自动开页面」这条路有三个坑，所以按顺序退：
 *   1) cmd /c start "" url —— 常规做法，但有的机器上 start 会把 url 当窗口标题；
 *   2) rundll32 url.dll,FileProtocolHandler url —— 直接走协议处理器，不经过 cmd；
 *   3) explorer.exe url —— 最后一招，explorer 会交给默认浏览器。
 * 全部失败也不影响服务，只是要手动点控制台里打印的地址。
 */
/** 找一个能开「应用窗口」的浏览器：Edge 优先，其次 Chrome */
function appWindowBrowsers() {
  const bases = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, 'C:\\Program Files (x86)', 'C:\\Program Files'];
  const names = [
    'Microsoft\\Edge\\Application\\msedge.exe',
    'Google\\Chrome\\Application\\chrome.exe',
  ];
  const out = [];
  for (const n of names) {
    for (const b of bases) {
      if (!b) continue;
      const p = path.join(b, n);
      try {
        if (fs.existsSync(p)) out.push(p);
      } catch {
        /* ignore */
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- 系统托盘
// 关窗口选「缩到系统托盘」时，用 PowerShell 的 NotifyIcon 留在任务栏右下角。
// 只用 Windows 自带的 WinForms，不装任何依赖。
let trayChild = null;

function trayPidFile() {
  return path.join(ROOT, 'data', 'tray.pid');
}

function trayAlive() {
  try {
    const pid = Number(String(fs.readFileSync(trayPidFile(), 'utf8')).trim());
    if (!pid) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function ensureTray() {
  if (trayAlive()) return true;
  if (process.platform !== 'win32') {
    console.log('[托盘] 目前只在 Windows 上支持缩到托盘');
    return false;
  }
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (!fs.existsSync(ps)) {
    console.log('[托盘] 找不到 powershell.exe，无法缩到托盘');
    return false;
  }
  try {
    const { spawn } = require('node:child_process');
    const p = spawn(
      ps,
      [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-WindowStyle', 'Hidden',
        '-File', path.join(ROOT, 'tools', 'tray.ps1'),
        '-Port', String(PORT),
        '-Url', `http://${HOST}:${PORT}/`,
      ],
      // 不能用 detached: DETACHED_PROCESS 下 PowerShell 5.1 会立刻退出（实测 exit 0、脚本一行没跑）
      { detached: false, stdio: 'ignore', windowsHide: true }
    );
    p.on('error', (err) => console.log(`[托盘] 启动失败：${err.code || err.message}`));
    p.unref();
    trayChild = p;
    console.log('[托盘] 已缩到系统托盘，采集继续（双击图标回到界面，右键可退出）');
    return true;
  } catch (err) {
    console.log(`[托盘] 启动失败：${err.message}`);
    return false;
  }
}

function stopTray() {
  try {
    const pid = Number(String(fs.readFileSync(trayPidFile(), 'utf8')).trim());
    if (pid) {
      try {
        process.kill(pid);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  try {
    fs.unlinkSync(trayPidFile());
  } catch {
    /* ignore */
  }
  trayChild = null;
}

/** 用 --app 开一个没有地址栏/标签页的独立窗口，像桌面软件 */
function openAppWindow() {
  if (DRY_RUN) {
    console.log('[界面] [dry] 会打开独立窗口');
    return true;
  }
  const { spawn } = require('node:child_process');
  const url = `http://${HOST}:${PORT}/`;
  const profile = path.join(ROOT, 'data', 'window-profile');
  try {
    fs.mkdirSync(profile, { recursive: true });
  } catch {
    /* ignore */
  }
  const exe = appWindowBrowsers()[0];
  if (!exe) {
    console.log('[界面] 没找到 Edge / Chrome，无法打开独立窗口');
    return false;
  }
  try {
    const p = spawn(
      exe,
      [
        `--app=${url}`,
        `--user-data-dir=${profile}`,
        '--window-size=1500,940',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=Translate,MediaRouter',
      ],
      { detached: true, stdio: 'ignore', windowsHide: false }
    );
    p.on('error', (err) => {
      console.log(`[界面] 打开独立窗口失败：${err.code || err.message}（${exe}）`);
    });
    p.on('spawn', () => console.log(`[界面] 已打开独立窗口（${path.basename(exe)}）`));
    p.unref();
    appWindowChild = p;
    const startedAt = Date.now();
    p.on('exit', (code) => {
      const lived = Date.now() - startedAt;
      appWindowChild = null;
      // 刚起来就退：多半是浏览器把请求转给了同 profile 的旧进程，或直接报错。
      // 这时不能当成「用户关了窗口」，退回到普通标签页，至少让用户看到界面。
      if (lived < 5000) {
        if (clients.size > 0) return;
        console.log(`\n[界面] 独立窗口没能起来（${lived}ms 后退出，code=${code}），改用浏览器标签打开。`);
        openBrowser({ noApp: true });
        return;
      }
      // 还有别的界面连着（比如浏览器标签还开着），就不算「关掉程序」
      if (clients.size > 0) {
        console.log('\n[界面] 独立窗口已关闭，但还有别的界面在用，继续采集。');
        return;
      }
      const ui = getUISettings();
      if (ui.closeAction === 'tray') {
        console.log('\n[界面] 窗口已关闭，按设置缩到系统托盘。');
        ensureTray();
        return;
      }
      if (!ui.stopOnWindowClose) return;
      console.log('\n[界面] 独立窗口已关闭 → 按设置停止采集。');
      shutdown('窗口关闭');
    });
    return true;
  } catch {
    return false;
  }
}

function openBrowser(opts = {}) {
  const url = `http://${HOST}:${PORT}`;
  const { spawn } = require('node:child_process');
  const run = (cmd, args) =>
    new Promise((resolve) => {
      try {
        const p = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
        p.on('error', () => resolve(false));
        p.on('spawn', () => {
          p.unref();
          resolve(true);
        });
      } catch {
        resolve(false);
      }
    });

  return (async () => {
    const mode = opts.force ? 'browser' : process.env.DANMU_WINDOW || getUISettings().windowMode;
    if (mode === 'none' && !opts.force) return false;

    // 把「按哪个设置开的」打出来，启动行为不对时一眼能看出是设置没存、还是被环境变量盖了
    if (!opts.force) {
      const from = process.env.DANMU_WINDOW ? '环境变量 DANMU_WINDOW' : '设置里的「窗口模式」';
      const label = mode === 'browser' ? '浏览器标签' : mode === 'none' ? '不自动打开' : '独立窗口';
      console.log(`[界面] 启动方式：${label}（来自${from}）`);
    }
    if (DRY_RUN) return true;

    if (process.platform !== 'win32') {
      const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
      const args = mode === 'app' && process.platform === 'darwin' ? ['-a', 'Google Chrome', '--args', `--app=${url}`] : [url];
      return await run(opener, args);
    }
    if (!opts.noApp && mode !== 'browser' && openAppWindow()) return true;
    if (await run('cmd', ['/c', 'start', '', url])) return true;
    if (await run('rundll32', ['url.dll,FileProtocolHandler', url])) return true;
    return await run('explorer.exe', [url]);
  })();
}

server.listen(PORT, HOST, async () => {
  console.log('');
  console.log('  弹幕雷达 · 斗鱼弹幕统计工具');
  console.log(`  ▶ http://${HOST}:${PORT}`);
  console.log(`  ▶ 数据文件 ${store.path}`);
  console.log('');

  if (process.env.DANMU_OPEN === '1') openBrowser();

  collector.restore();

  // 浏览器标签模式没法拦「关窗口」，只能看界面连接断没断：断了给一段宽限期，还不回来就退出。
  setInterval(uiMonitor, 2000).unref?.();
});

let closing = false;

/** 界面全断开 → 按 closeAction 处理（缩托盘 / 宽限后停止） */
let lastTrayTry = 0;
function uiMonitor() {
  const s = getUISettings();
  if (!uiAttached) return;

  if (clients.size > 0) {
    if (graceSince) console.log('[界面] 界面回来了，取消退出倒计时。');
    graceSince = 0;
    return;
  }

  // 缩托盘：界面断开就把托盘图标拉起来，这样「关了窗口采集还在」是真的成立
  if (s.closeAction === 'tray') {
    if (trayAlive()) return;
    if (Date.now() - lastTrayTry < 30000) return;
    lastTrayTry = Date.now();
    const ok = ensureTray();
    console.log(
      ok
        ? '[界面] 界面已断开，已缩到系统托盘，采集继续（双击托盘图标回到界面）'
        : '[界面] 界面已断开，托盘没能启动（采集仍在继续）'
    );
    return;
  }

  if (!s.stopOnWindowClose) return;
  if (!graceSince) {
    graceSince = Date.now();
    console.log(`[界面] 界面已断开，${s.graceSec} 秒内没有重新打开就停止采集。`);
    return;
  }
  if (Date.now() - graceSince >= s.graceSec * 1000) {
    console.log('\n[界面] 界面关闭且宽限期已过 → 停止采集。');
    shutdown('界面关闭');
  }
}

function shutdown(sig) {
  if (closing) return;
  closing = true;
  console.log(`\n[退出] 收到 ${sig}，正在落盘…`);
  try {
    stopTray();
  } catch {
    /* ignore */
  }
  try {
    collector.stopAll();
    collector.flush(); // 缓冲里最多还压着 800ms 的弹幕，退出前必须落盘
  } catch {
    /* ignore */
  }
  setTimeout(() => {
    try {
      store.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  }, 300);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
