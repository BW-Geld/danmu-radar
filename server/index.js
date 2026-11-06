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
// 我们主动关掉的旧窗口 pid：它的 exit 回调不能当成「用户关窗」
let closingAppWindowPid = 0;
// 正在通过接口拉界面：这期间浏览器早退（转交给旧实例、启动失败）不算用户关窗，
// 也别在 exit 回调里再补开一个，否则一次点击会开出两个窗口。
let openingUi = false;

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
      opened = await openAppWindow();
    } else if (body.openWindow === 'browser') {
      // 「现在开启浏览器窗口」：不管当前模式，直接用默认浏览器开一个标签页
      opened = await openBrowser({ noApp: true, force: true });
    }
    return json(res, 200, { ok: true, ...next, opened });
  }

  // 托盘图标点「打开界面」：优先把已经开着的窗口提到前台，没有才新开一个
  if (p === '/ui/activate' && req.method === 'POST') {
    const pid = activeAppPid();
    if (pid && (await focusAppWindow(pid))) {
      ensureTray();
      return json(res, 200, { ok: true, how: 'focused' });
    }
    // 没有独立窗口，但可能已经在浏览器标签里开着（标题含「弹幕雷达」）：把它叫出来就行，
    // 不要再启动一次浏览器——提权/普通权限混用时，再启动一次会弹 Windows 的「Edge 未响应」权限提示。
    if (await focusAnyWindow()) {
      ensureTray();
      return json(res, 200, { ok: true, how: 'tab-focused' });
    }
    if (await openAppWindow()) return json(res, 200, { ok: true, how: 'app' });
    const tab = await openBrowser({ noApp: true, force: true });
    return json(res, 200, { ok: true, how: tab ? 'browser' : 'none' });
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
/**
 * 能开「独立窗口」的浏览器，按顺序：Edge 在前，Chrome 兜底。
 *
 * 用户要求 Edge 优先（机器上平时用的就是 Edge，不想无端换浏览器）。
 * 风险是：Windows 上只要有个「以管理员身份运行」的 Edge，普通权限再启动 Edge
 * 就可能弹「现有实例正在以提升的权限运行」的权限框，或者留下一个标题停在
 * `127.0.0.1_/`、页面永远不加载的白页。那个高权限实例既提不到前台
 * （SetForegroundWindow 被跨权限挡住），也杀不掉（taskkill 拒绝访问）。
 * 所以这里不假设 Edge 一定行：调用方会等「真有界面连上 SSE」，连不上就关掉
 * 换下一个候选 —— Chrome 就是那个兜底。
 */
function browserCandidates() {
  const bases = [
    process.env['ProgramFiles(x86)'],
    process.env.ProgramFiles,
    process.env.LOCALAPPDATA,
    'C:\\Program Files (x86)',
    'C:\\Program Files',
  ];
  const names = [
    'Microsoft\\Edge\\Application\\msedge.exe',
    'Google\\Chrome\\Application\\chrome.exe',
  ];
  const out = [];
  const seen = new Set();
  for (const n of names) {
    for (const b of bases) {
      if (!b) continue;
      const p = path.join(b, n);
      try {
        if (fs.existsSync(p) && !seen.has(p.toLowerCase())) {
          seen.add(p.toLowerCase());
          out.push(p);
        }
      } catch {
        /* ignore */
      }
    }
  }
  return out;
}

/** 浏览器类型：两家共用一份配置目录会互相踩，必须分开 */
function browserName(exe) {
  return /chrome\.exe$/i.test(exe) ? 'chrome' : 'edge';
}

/** 每种浏览器一份专属配置目录 */
function profileFor(exe) {
  return path.join(ROOT, 'data', browserName(exe) === 'chrome' ? 'chrome-profile' : 'window-profile');
}

// ---------------------------------------------------------------- 系统托盘
// 关窗口选「缩到系统托盘」时，用 PowerShell 的 NotifyIcon 留在任务栏右下角。
// 只用 Windows 自带的 WinForms，不装任何依赖。
let trayChild = null;
// 托盘只该有一个。启动脚本要几百毫秒才写完 pid 文件，这期间别的调用点再进来
// 就会看到「还没起」，于是又拉一个——屏幕上就出现两个图标。这里自己记一笔。
let trayStartedAt = 0;

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

function killTrayProcesses() {
  if (process.platform !== 'win32') return;
  try {
    const { execFileSync } = require('node:child_process');
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.CommandLine -like '*tray.ps1*' -and $_.ProcessId -ne $PID } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
      ],
      { timeout: 8000, windowsHide: true, stdio: 'ignore' }
    );
  } catch {}
}

function ensureTray() {
  if (trayAlive()) return true;
  // 刚拉过、pid 文件还没落盘的这段时间，直接当作已启动，避免重复拉
  if (trayChild && !trayChild.killed) return true;
  if (trayStartedAt && Date.now() - trayStartedAt < 10000) return true;
  // 走到这儿说明 pid 文件不可信（上次的服务被杀、托盘还在）。
  // 先把残留的托盘进程清干净再拉一个新的，否则会并排出现两个图标。
  killTrayProcesses();
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
    p.on('error', (err) => {
      trayStartedAt = 0;
      console.log(`[托盘] 启动失败：${err.code || err.message}`);
    });
    // 托盘进程自己退出（脚本判定服务器没了、被杀、系统休眠）时必须清掉记录，
    // 否则 ensureTray() 会一直以为「还活着」，从此再也不拉起——图标就这么消失了。
    p.on('exit', () => {
      if (trayChild === p) {
        trayChild = null;
        trayStartedAt = 0;
      }
    });
    p.unref();
    trayChild = p;
    trayStartedAt = Date.now();
    console.log('[托盘] 托盘图标已就绪（双击回到界面，右键可退出）');
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

/**
 * 独立窗口的 pid 记录。
 * Edge / Chrome 对同一个 --user-data-dir 只允许一个实例：已经有一个窗口在跑时再 spawn，
 * 新进程会把参数转交给旧进程、自己立刻退出，屏幕上多出一个停在 127.0.0.1/ 的白页。
 * 所以这里记下 pid，开新窗口之前先把旧的关掉。
 */
function appWindowPidFile() {
  return path.join(ROOT, 'data', 'app-window.pid');
}

/** 窗口的完整记录：pid + 哪个浏览器 + 用的哪份配置目录（清理残留进程要按目录找） */
function appWindowStateFile() {
  return path.join(ROOT, 'data', 'app-window.json');
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 读窗口记录；旧版本只写了 pid 文件，也认 */
function readAppWindowState() {
  let st = {};
  try {
    st = JSON.parse(fs.readFileSync(appWindowStateFile(), 'utf8')) || {};
  } catch {
    /* 旧版本 */
  }
  let pid = Number(st.pid) || 0;
  if (!pid) {
    try {
      pid = Number(fs.readFileSync(appWindowPidFile(), 'utf8').trim()) || 0;
    } catch {
      pid = 0;
    }
  }
  return { pid, exe: st.exe || '', profile: st.profile || '' };
}

function writeAppWindowState(pid, exe, profile) {
  try {
    fs.writeFileSync(appWindowPidFile(), String(pid));
  } catch {
    /* ignore */
  }
  try {
    fs.writeFileSync(appWindowStateFile(), JSON.stringify({ pid, exe, profile }));
  } catch {
    /* ignore */
  }
}

/** 清记录；传了 onlyPid 就只在记录的仍是这个 pid 时清（别把新窗口的记录抹掉） */
function clearAppWindowState(onlyPid) {
  if (onlyPid) {
    const st = readAppWindowState();
    if (st.pid && st.pid !== onlyPid) return;
  }
  for (const f of [appWindowPidFile(), appWindowStateFile()]) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
}

/** 记着的那扇独立窗口还活着就返回它的 pid，否则 0 */
function activeAppPid() {
  const st = readAppWindowState();
  return pidAlive(st.pid) ? st.pid : 0;
}

/** 按窗口标题找「弹幕雷达」的窗口并提到前台（不限 pid：浏览器标签页也算） */
function focusAnyWindow() {
  return new Promise((resolve) => {
    const script = path.join(ROOT, 'tools', 'focus.ps1');
    if (!fs.existsSync(script)) return resolve(false);
    const { execFile } = require('node:child_process');
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Title', '弹幕雷达'],
      { timeout: 12000 },
      (err, stdout) => resolve(!err && String(stdout).includes('FOCUSED'))
    );
  });
}

/**
 * 把已经开着的窗口提到最前面。
 * 先按「窗口标题含 弹幕雷达」找（tools/focus.ps1，SetForegroundWindow）——
 * 白页窗口的标题是 `127.0.0.1_/`，匹配不到，正好被当成「不是好窗口」；
 * 再退回按 pid 的 AppActivate 兜底。返回是否真的提到了。
 */
function focusAppWindow(pid) {
  if (!pidAlive(pid)) return Promise.resolve(false);
  const { execFile } = require('node:child_process');
  const script = path.join(ROOT, 'tools', 'focus.ps1');
  const byTitle = new Promise((resolve) => {
    if (!fs.existsSync(script)) return resolve(false);
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-TargetPid', String(pid), '-Title', '弹幕雷达'],
      { timeout: 12000 },
      (err, stdout) => resolve(!err && String(stdout).includes('FOCUSED'))
    );
  });
  const byPid = () => new Promise((resolve) => {
    const ps = `$s = New-Object -ComObject WScript.Shell; if ($s.AppActivate(${pid})) { 'FOCUSED' } else { 'MISSED' }`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 6000 }, (err, stdout) => {
      resolve(!err && String(stdout).includes('FOCUSED'));
    });
  });
  return byTitle.then((ok) => (ok ? true : byPid()));
}

/** 找出所有命令行里带这个 profile 目录的 Edge/Chrome 进程并结束（含子进程） */
function closeProfileWindows(profile) {
  return new Promise((resolve) => {
    if (!profile) return resolve(0);
    const { execFile } = require('node:child_process');
    const ps =
      `Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='chrome.exe'" | ` +
      `Where-Object { $_.CommandLine -like '*${profile.replace(/\\/g, '\\\\')}*' } | ` +
      `ForEach-Object { $_.ProcessId }`;
    try {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 8000 }, (err, stdout) => {
        if (err || !stdout) return resolve(0);
        const pids = String(stdout)
          .split(/\s+/)
          .map((s) => Number(s))
          .filter((n) => Number.isInteger(n) && n > 0);
        if (!pids.length) return resolve(0);
        let left = pids.length;
        for (const p of pids) {
          try {
            execFile('taskkill', ['/PID', String(p), '/T', '/F'], () => {
              if (--left === 0) resolve(pids.length);
            });
          } catch {
            if (--left === 0) resolve(pids.length);
          }
        }
      });
    } catch {
      // 沙箱/受限环境里 spawn 可能直接抛 EPERM：清不掉不等于开不了窗，继续往下走
      resolve(0);
    }
  });
}

/** 配置目录要能写；写不进去（被别的权限级别占用/ACL 异常）就换到 %LOCALAPPDATA% 下 */
function usableProfile(preferred, tag) {
  try {
    fs.mkdirSync(preferred, { recursive: true });
    const probe = path.join(preferred, '.write-test');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return preferred;
  } catch {
    const base = process.env.LOCALAPPDATA || process.env.TEMP || ROOT;
    const alt = path.join(base, 'DanmuRadar', `${tag || 'window'}-profile`);
    try {
      fs.mkdirSync(alt, { recursive: true });
      console.log(`[界面] 配置目录不可用，改用 ${alt}`);
      return alt;
    } catch {
      return preferred;
    }
  }
}

async function closeOldAppWindow() {
  const st = readAppWindowState();
  const pid = st.pid;
  if (!pidAlive(pid)) {
    clearAppWindowState();
    return true;
  }
  closingAppWindowPid = pid;
  // 必须连子进程一起结束：浏览器主进程退了，渲染/GPU 子进程还会攥着 profile 一会儿，
  // 这时抢先 spawn 新窗口，浏览器会把它降级成一个停在 127.0.0.1/ 的白页。
  await killTree(pid);
  // 等 profile 锁真正释放，否则新窗口还是会被转交成白页
  for (let i = 0; i < 20 && pidAlive(pid); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((r) => setTimeout(r, 600));
  // 除了自己记录的 pid，把任何还在用这份 profile 的浏览器也清掉：
  // 高权限（管理员）起的那个会攥着配置目录，普通权限的新窗口拿不到它，只能开出白页。
  if (st.profile) await closeProfileWindows(st.profile);
  clearAppWindowState();
  // 杀不掉（比如它是以管理员身份起的）就别再拿同一份 profile 硬开
  return !pidAlive(pid);
}

/** 起一个 --app 窗口；返回子进程（失败返回 null）。退出回调负责托盘/停采集那套语义 */
function launchAppWindow(exe, url, profile) {
  const { spawn } = require('node:child_process');
  try {
    fs.mkdirSync(profile, { recursive: true });
  } catch {
    /* ignore */
  }
  // 不再指定 --user-data-dir：实测自建配置目录在服务里创建时会开出白页
  // （目录在、进程在、标题空、页面不加载），而共用默认配置 1.8 秒就正常加载。
  // 代价是窗口与用户日常浏览共用一份配置，好处是再没有「配置被别的实例占着」这类问题。
  const argv = [
    `--app=${url}`,
    '--window-size=1360,820',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
  ];
  const p = spawn(exe, argv,
    // 不用 detached：实测 detached:true 起的 --app 窗口出现过「进程在、标题空、页面不加载」的白页，
    // 去掉 detached 后正常；配合下面的 unref()，窗口照样能活过父进程。
    { stdio: 'ignore', windowsHide: false }
  );
  p.on('error', (err) => {
    console.log(`[界面] 打开独立窗口失败：${err.code || err.message}（${exe}）`);
  });
  p.on('spawn', () => {
    console.log(`[界面] 已打开独立窗口（${path.basename(exe)}）`);
    writeAppWindowState(p.pid, exe, profile);
  });
  p.unref();
  appWindowChild = p;
  const startedAt = Date.now();
  p.on('exit', (code) => {
    const lived = Date.now() - startedAt;
    if (appWindowChild === p) appWindowChild = null;
    // 是我们自己为了重开而关掉的旧窗口：不算用户关窗，也别再开标签页
    if (closingAppWindowPid && closingAppWindowPid === p.pid) {
      closingAppWindowPid = 0;
      return;
    }
    clearAppWindowState(p.pid);
    // 刚起来就退：多半是浏览器把请求转给了同 profile 的旧进程，或直接报错。
    // 这时不能当成「用户关了窗口」。若外层正在重试别的浏览器，就交给外层处理，别重复开。
    if (lived < 5000) {
      if (clients.size > 0 || openingUi) return;
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
  return p;
}

/** 杀掉一个进程及其子进程（浏览器主进程退了，渲染子进程还会攥着 profile） */
async function killTree(pid) {
  if (!pid) return;
  await new Promise((resolve) => {
    const { execFile } = require('node:child_process');
    try {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => resolve());
    } catch {
      resolve();
    }
  });
}

/** 等一个新界面连上 SSE；连上说明页面真的起来了（白页永远不会连） */
function waitForClient(before, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (clients.size > before) return resolve(true);
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(tick, 150);
    };
    tick();
  });
}

/** 用 --app 开一个没有地址栏/标签页的独立窗口，像桌面软件 */
async function openAppWindow() {
  // 实测在这台机器上，服务进程拉起的 --app 窗口会被 Edge 的单实例/权限检查挡住，
  // 屏幕上是「127.0.0.1_/」白页，反复换参数、换配置、换启动方式都绕不过去。
  // 浏览器标签页这条路径是稳的，所以默认改走标签页；想再试验独立窗口就设
  // DANMU_APP_WINDOW=1，代码原样保留。
  if (process.env.DANMU_APP_WINDOW !== '1') {
    console.log('[界面] 独立窗口改走浏览器标签页（这条路径稳定），如需实验独立窗口设 DANMU_APP_WINDOW=1');
    return openBrowser({ noApp: true, force: true });
  }
  if (DRY_RUN) {
    console.log('[界面] [dry] 会打开独立窗口');
    return true;
  }
  openingUi = true;
  try {
    // 已经有窗口就把它提到前台，不关掉重开：重开会丢掉滚动位置和当前筛选，
    // 而且「关掉再开」的空档里浏览器还攥着配置目录，正是之前白屏的温床。
    const alive = activeAppPid();
    if (alive) {
      if (await focusAppWindow(alive)) {
        console.log('[界面] 窗口已经开着，已提到前台');
        ensureTray();
        return true;
      }
      console.log('[界面] 有窗口但提不到前台（权限级别不同），关掉重开');
    }
    const url = `http://${HOST}:${PORT}/`;
    const cands = browserCandidates();
    if (!cands.length) {
      console.log('[界面] 没找到 Chrome / Edge，无法打开独立窗口');
      return false;
    }
    try {
      await closeOldAppWindow();
    } catch (err) {
      console.log(`[界面] 关闭旧窗口时出错（继续）：${err.message}`);
    }
    // 逐个浏览器试：一个连不上界面（白屏）就关掉换下一个。
    // Chrome 在前 —— 机器上存在「管理员权限的 Edge」时，普通权限的 Edge 开出来只会是白页或权限框。
    for (const exe of cands) {
      const name = browserName(exe);
      try {
        const profile = usableProfile(profileFor(exe), name);
        // 同 profile 的后台残留进程会抢先接管新窗口，必须先清干净
        await closeProfileWindows(profile);
        const before = clients.size;
        const p = launchAppWindow(exe, url, profile);
        if (!p) continue;
        ensureTray();
        // 白页不会连 SSE：给它 6 秒，连不上就认作白屏，关掉换下一个
        if (await waitForClient(before, 6000)) return true;
        console.log(`[界面] ${name} 的独立窗口没连上界面（白屏），关掉再试下一个浏览器。`);
        // 标记成「我们自己关的」，否则 exit 回调会把它当成用户关窗，按设置把采集也停掉
        closingAppWindowPid = p.pid;
        await killTree(p.pid);
        clearAppWindowState(p.pid);
      } catch (err) {
        console.log(`[界面] 打开 ${name} 独立窗口出错（换下一个）：${err.message}`);
      }
    }
    console.log('[界面] 所有浏览器都没开出可用的独立窗口，改用浏览器标签打开。');
    return openBrowser({ noApp: true, force: true });
  } catch (err) {
    console.log(`[界面] 打开独立窗口失败：${err.message}`);
    return false;
  } finally {
    openingUi = false;
  }
}

function openBrowser(opts = {}) {
  // 端口必须是确定的数字：拼出 http://127.0.0.1:0 这类地址时浏览器会把它当 80 端口，
  // 打开一个永远不会有人应答的白页，比「没打开」更难排查。
  if (!Number.isInteger(PORT) || PORT <= 0) {
    console.log(`[界面] 端口无效（${PORT}），跳过自动打开`);
    return Promise.resolve(false);
  }
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

    // 实际要打开的地址写进日志：出问题时能一眼看出是地址错了还是窗口没起来
    console.log(`[界面] 打开 ${url}/`);

    if (process.platform !== 'win32') {
      const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
      const args = mode === 'app' && process.platform === 'darwin' ? ['-a', 'Google Chrome', '--args', `--app=${url}`] : [url];
      return await run(opener, args);
    }
    if (!opts.noApp && mode !== 'browser' && (await openAppWindow())) return true;

    // 不再「只要进程起来了就算打开」——cmd start 会立刻返回 0，用户却可能只看到一个权限框。
    // 现在必须等到真的有一页连上 SSE 才算成功；15 秒内都不行就往上抛失败，让界面给明确提示。
    // 已经有一页开着就把它提出来，绝不另起浏览器进程
    if (await focusAnyWindow()) {
      console.log('[界面] 已经有一页开着，直接切过去了');
      return true;
    }

    // 只用资源管理器去开：走的是用户当前那个浏览器实例（新增一个标签页），
    // 不新起进程、不碰自建配置目录，所以不会再出现白窗和「以提升的权限运行」的弹窗。
    const before = clients.size;
    const okExplorer = await run('explorer.exe', [`${url}/`]);
    if (!okExplorer) await run('rundll32', ['url.dll,FileProtocolHandler', `${url}/`]);
    if (await waitForClient(before, 14000)) {
      ensureTray();
      return true;
    }
    console.log('[界面] 没能打开可用的浏览器窗口，界面里会提示手动打开地址。');
    return false;
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

  // 托盘要一直有人看着：图标可能因为脚本自己退出、系统重启资源管理器而消失，
  // 而这时候界面往往正开着（下面会因为 clients>0 提前 return），没人补。
  if (s.closeAction === 'tray' && !trayAlive() && Date.now() - lastTrayTry > 30000) {
    lastTrayTry = Date.now();
    if (ensureTray()) console.log('[托盘] 图标不见了，已重新拉起');
  }

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
