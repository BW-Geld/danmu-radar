'use strict';

/**
 * 录播（v.douyu.com）弹幕导入。
 *
 * 接口是前端 bundle 里的：
 *   GET https://v.douyu.com/wgapi/vod/center/getBarrageListByPage?vid={showId}&forward=0&offset={pre}
 *   GET https://v.douyu.com/wgapi/vod/center/getBarrageCount?vid={showId}
 *
 * 两个坑：
 *  1. `vid` 参数要传 showId 字符串（如 6Aw87Ogqmxj7YGkg），传数字 vid 会报「请求参数错误」；
 *  2. 只有 `forward=0` + `pre` 游标能走完全程，`forward=1` + `next` 第二页就返回同一批再置 -1。
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const PAGE_DELAY_MS = 100;
const MAX_PAGES = 600;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 从 showId / 录播链接 / 分享文案里取出 showId */
function parseShowId(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  const m = s.match(/show\/([A-Za-z0-9]{10,})/) || s.match(/\b([A-Za-z0-9]{12,})\b/);
  return m ? m[1] : null;
}

async function getJson(url, showId, { retries = 2, timeout = 15000 } = {}) {
  let lastErr = null;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          Accept: 'application/json',
          Referer: `https://v.douyu.com/show/${showId}`,
        },
        signal: AbortSignal.timeout(timeout),
      });
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        return { error: -1, raw: text.slice(0, 160) };
      }
    } catch (err) {
      lastErr = err;
      if (i < retries) await sleep(400 * (i + 1));
    }
  }
  return { error: -2, msg: `网络异常：${lastErr && lastErr.message}` };
}

/** 解析录播页面内联数据：标题、时长、房间号、页内弹幕数 */
async function fetchMeta(showId) {
  const res = await fetch(`https://v.douyu.com/show/${showId}`, {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    },
  });
  const html = await res.text();
  const num = (re) => {
    const m = html.match(re);
    return m ? Number(m[1]) : null;
  };
  const titleM = html.match(/<title>([^<]+)<\/title>/);
  return {
    showId,
    vid: num(/"point_id"\s*:\s*"?(\d+)/),
    roomId: num(/"room_id"\s*:\s*"?(\d+)/) || num(/"rid"\s*:\s*"?(\d+)/),
    duration: num(/"duration"\s*:\s*"?(\d+)/) || num(/"video_duration"\s*:\s*"?(\d+)/),
    danmuNum: num(/"danmu_num"\s*:\s*"?(\d+)/),
    title: titleM ? titleM[1].replace(/[-_]斗鱼视频\s*$/, '').trim() : showId,
    htmlBytes: html.length,
  };
}

async function fetchCount(showId) {
  const r = await getJson(`https://v.douyu.com/wgapi/vod/center/getBarrageCount?vid=${showId}`, showId);
  if (r.error !== 0) return { ok: false, msg: r.msg || '接口返回错误' };
  return { ok: true, count: Number(r.data?.count) || 0, replayNum: Number(r.data?.ReplayNum) || 0 };
}

/**
 * 反向翻页拉全量。返回按 tl 升序的原始条目（已按 sid 去重）。
 * @param {(p:{page:number,got:number,total:number})=>void} onProgress
 */
async function fetchAll(showId, { onProgress, maxPages = MAX_PAGES } = {}) {
  let offset = -1;
  const seen = new Set();
  const rows = [];

  for (let page = 1; page <= maxPages; page++) {
    const r = await getJson(
      `https://v.douyu.com/wgapi/vod/center/getBarrageListByPage?vid=${showId}&forward=0&offset=${offset}`,
      showId
    );
    if (r.error !== 0) {
      if (page === 1) return { ok: false, msg: r.msg || '接口返回错误', rows: [] };
      break;
    }
    const list = r.data?.list || [];
    let fresh = 0;
    for (const x of list) {
      if (x && x.sid != null && !seen.has(x.sid)) {
        seen.add(x.sid);
        rows.push(x);
        fresh++;
      }
    }
    onProgress?.({ page, got: fresh, total: rows.length });

    const next = r.data?.pre;
    if (!list.length || !fresh || !next || next === -1) break;
    offset = next;
    await sleep(PAGE_DELAY_MS);
  }

  rows.sort((a, b) => (Number(a.tl) || 0) - (Number(b.tl) || 0));
  return { ok: true, rows };
}

/** 原始条目 → messages 表行 */
function toMessageRows(vod, raw) {
  const out = [];
  const rid = Number(vod.roomId) || 0;
  for (const x of raw) {
    const txt = String(x.ctt || '').trim();
    if (!txt) continue;
    const uid = String(x.uid || '').trim();
    if (!uid) continue;
    const sts = Number(x.sts);
    const tl = Number(x.tl);
    // sts 是发送时刻（秒）。但剪辑片段里整场的 sts 是同一个值（通常是上传时间），
    // 这时退回 baseTime + tl，否则全库时间轴会重叠成一瞬间、共现窗口分析直接失效。
    const cst = vod.uniformSts
      ? (Number(vod.baseTime) || Date.now()) + (Number.isFinite(tl) ? tl : 0)
      : Number.isFinite(sts) && sts > 1e9
        ? sts * 1000
        : (Number(vod.baseTime) || Date.now()) + (Number.isFinite(tl) ? tl : 0);
    out.push({
      rid,
      roomName: vod.title,
      uid,
      nn: x.nn || '',
      txt,
      cst,
      level: 0,
      bnn: '',
      bl: 0,
      brid: 0,
      kind: 'chat',
      source: 'vod',
      ext: `vod:${vod.showId}:${x.sid}`,
    });
  }
  return out;
}

/**
 * 导入一个录播的全部弹幕。
 * @param {import('./db').Store} store
 */
async function importVod(store, input, { onProgress, force = false } = {}) {
  const showId = parseShowId(input);
  if (!showId) return { ok: false, error: '没认出录播 ID，请粘贴 v.douyu.com/show/xxxx 链接或 10 位以上的 ID' };

  const prev = store.getVodImport(showId);
  if (prev && !force) {
    return {
      ok: false,
      error: `这个录播已经导入过（${prev.imported} 条 / ${new Date(prev.imported_at).toLocaleString('zh-CN')}），确认要重复导入请加 force`,
      showId,
    };
  }

  const meta = await fetchMeta(showId);
  const cnt = await fetchCount(showId);
  const total = cnt.ok ? cnt.count : meta.danmuNum || 0;

  onProgress?.({ phase: 'meta', meta, total });
  const pulled = await fetchAll(showId, {
    onProgress: (p) => onProgress?.({ phase: 'pages', total, ...p }),
  });
  if (!pulled.ok) return { ok: false, error: pulled.msg || '拉取失败', showId, meta };

  // 判断 sts 是否整场同值（剪辑片段常见）→ 改用 上传时间 + tl 还原时间轴
  const stsSet = new Set(pulled.rows.map((x) => x.sts).filter((v) => v != null));
  const uniformSts = stsSet.size <= 1;
  const baseTime = uniformSts ? (Number([...stsSet][0]) || 0) * 1000 : 0;

  const rows = toMessageRows({ ...meta, showId, uniformSts, baseTime }, pulled.rows);
  let imported = 0;
  const CHUNK = 1000;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const res = store.insertBatch(rows.slice(i, i + CHUNK), { ignore: true });
    imported += res.inserted;
    onProgress?.({ phase: 'insert', done: Math.min(rows.length, i + CHUNK), total: rows.length });
  }

  const users = new Set(rows.map((r) => r.uid)).size;
  const span = rows.length ? (rows[rows.length - 1].cst - rows[0].cst) / 60000 : 0;

  // 记一个占位房间，让"按房间筛选"能选到它；auto_start=0，重启不会去连直播流
  if (meta.roomId) {
    store.ensureVodRoom({ rid: meta.roomId, name: meta.title, owner: '' });
    store.touchRooms(rows);
  }

  store.saveVodImport({
    showId,
    vid: meta.vid,
    title: meta.title,
    roomId: meta.roomId,
    duration: meta.duration,
    total,
    imported: rows.length,
  });

  return {
    ok: true,
    showId,
    vid: meta.vid,
    roomId: meta.roomId,
    title: meta.title,
    duration: meta.duration,
    apiCount: total,
    pulled: pulled.rows.length,
    imported,
    users,
    perUser: users ? +(rows.length / users).toFixed(2) : 0,
    density: span > 0 ? +(rows.length / span).toFixed(1) : null,
    spanMinutes: +span.toFixed(1),
    uniformSts,
    first: rows[0]?.cst || null,
    last: rows[rows.length - 1]?.cst || null,
  };
}

module.exports = { parseShowId, fetchMeta, fetchCount, fetchAll, importVod, toMessageRows };
