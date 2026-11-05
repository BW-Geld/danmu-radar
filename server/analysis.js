'use strict';

/** 分析引擎：三路召回检索 + 用户成分画像。 */

const { normalize, keyOf, phraseTokens, segmentsOf, entropy, stem } = require('./text');
const lexicon = require('./lexicon');
const COPY = require('../shared/copy');
const T = COPY.EVIDENCE;
const fill = COPY.fill;

const WINDOW_MS = 90 * 1000;
/** 句首/句尾可剥掉的代词与语气词：「我好困啊」→「好困」 */
const TRIM = new Set('我你您他她它们这那的了啊呀吧呢嘛哈哦嗯啦吗么'.split(''));
/** 出现在词中间就说明这是跨句拼接的伪词 */
const INNER_STOP = new Set('的了啊呀吧呢嘛哈哦嗯啦吗么我你您他她它们这那'.split(''));
/** 高频功能词：共现 lift 再高也没信息量（「就是」「真的」几乎和一切词共现） */
const STOP_TERMS = new Set(
  `就是 不是 这个 那个 什么 怎么 可以 现在 一个 没有 知道 时候 感觉 真的 应该 还是 这么 那么
   我们 你们 他们 自己 也是 不是 但是 因为 所以 然后 已经 一下 有点 好像 觉得 可能 不会 不能
   这个 那个 这样 那样 一点 一直 还是 就是 就是说 我的 你的 他的 哈哈哈 哈哈哈哈 笑死`
    .split(/\s+/)
    .filter(Boolean)
);
const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const pct = (v) => Math.round(v * 100);

/** 把候选词修干净：剥边、去伪词、去功能词。返回 '' 表示丢弃。 */
function cleanTerm(raw) {
  let s = raw;
  while (s.length > 2 && TRIM.has(s[0])) s = s.slice(1);
  while (s.length > 2 && TRIM.has(s[s.length - 1])) s = s.slice(0, -1);
  if (s.length < 2) return '';
  for (const ch of s) if (INNER_STOP.has(ch)) return '';
  if (STOP_TERMS.has(s)) return '';
  // 纯英文/数字的短碎片（ha、hh、233 之类）基本是笑声或口癖，不当作相关词
  if (/^[a-z0-9]+$/.test(s) && s.length <= 2) return '';
  return s;
}

// ---------------------------------------------------------------- 检索

function reasonOf(ntxt, exactTerm, synonymTerms) {
  if (ntxt.includes(exactTerm)) return { type: 'exact', label: '精确命中' };
  for (const s of synonymTerms) {
    if (s.norm && ntxt.includes(s.norm)) return { type: 'synonym', label: `同义/梗词：${s.word}` };
  }
  return { type: 'exact', label: '精确命中' };
}

/** 从命中结果里挖「强相关」词：窗口共现 + lift */
function mineCooccurrence(store, hits, excludeTerms, log) {
  const byRoom = new Map();
  for (const h of hits) {
    if (!byRoom.has(h.rid)) byRoom.set(h.rid, []);
    byRoom.get(h.rid).push(h);
  }

  const scored = new Map();
  const rooms = [...byRoom.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 3);
  let skipped = null;

  for (const [rid, roomHits] of rooms) {
    const sample = store.roomSample(rid, 4000);

    // 弹幕潮窗口必须先剔除：670 条抽奖口令会把「礼盒」「口令」的 lift 顶到天上，
    // 挖出来的强相关词全是营销噪声。注意是「剔除」而不是「加权」——潮表在这里是过滤器。
    const spans = new Map();
    const hitFrom = Math.min(...roomHits.map((h) => Number(h.cst))) - WINDOW_MS;
    const hitTo = Math.max(...roomHits.map((h) => Number(h.cst))) + WINDOW_MS;
    for (const f of store.floodRanges(rid, hitFrom, hitTo)) {
      const arr = spans.get(f.phrase) || [];
      arr.push([Number(f.s), Number(f.e)]);
      spans.set(f.phrase, arr);
    }
    const inFlood = (row) => {
      const arr = spans.get(normalize(row.txt));
      if (!arr) return false;
      const c = Number(row.cst);
      return arr.some(([s, e]) => c >= s && c < e);
    };

    // 先用语料统计「独立成段」的片段：只有真的能独立出现的 bigram 才算词，
    // 否则「是不是明天会胖」会切出「是明」「会胖」这类跨词碎片。
    const segFreq = new Map();
    for (const row of sample) {
      if (inFlood(row)) continue;
      for (const seg of segmentsOf(row.txt)) segFreq.set(seg, (segFreq.get(seg) || 0) + 1);
    }
    const mineTokens = (text) => {
      const out = [];
      for (const raw of phraseTokens(text)) {
        const t = cleanTerm(raw);
        if (!t) continue;
        if (t.length === 2 && !segFreq.has(t)) continue; // 只保留能独立成段的二元词
        out.push(t);
      }
      return out;
    };

    const bg = new Map();
    let bgTotal = 0;
    for (const row of sample) {
      if (inFlood(row)) continue;
      for (const t of mineTokens(row.txt)) {
        bg.set(t, (bg.get(t) || 0) + 1);
        bgTotal++;
      }
    }
    if (!bgTotal) continue;

    // 语料越少，窗口几乎覆盖全量，lift 天然趋近 1 —— 阈值必须跟着放宽
    const liftMin = sample.length >= 400 ? 2.5 : sample.length >= 120 ? 1.8 : 1.4;

    const win = new Map();
    const winDf = new Map();
    const winRows = new Set();
    let winTotal = 0;
    const picked = roomHits.slice(0, 15);
    for (const h of picked) {
      const rows = store.windowMessages(rid, h.cst - WINDOW_MS, h.cst + WINDOW_MS, 400);
      for (const row of rows) {
        if (inFlood(row)) continue;
        winRows.add(`${row.cst}|${row.txt}`);
        const toks = mineTokens(row.txt);
        for (const t of new Set(toks)) winDf.set(t, (winDf.get(t) || 0) + 1);
        for (const t of toks) {
          win.set(t, (win.get(t) || 0) + 1);
          winTotal++;
        }
      }
    }
    if (winTotal < 50) {
      skipped = skipped || 'few_messages';
      continue;
    }
    // 窗口覆盖了超过一半语料时，「共现」等于「全库同现」，lift 没有意义
    if (sample.length && winRows.size / sample.length > 0.5) {
      skipped = skipped || 'corpus_too_short';
      continue;
    }

    for (const [t, c] of win) {
      if (c < 3) continue;
      if ((winDf.get(t) || 0) < 2) continue;
      if (excludeTerms.some((e) => t.includes(e) || e.includes(t))) continue;
      const lift = c / winTotal / ((bg.get(t) || 0.5) / bgTotal);
      if (lift < liftMin) continue;
      const score = Math.log2(lift) * Math.log2(c + 1);
      const cur = scored.get(t);
      if (!cur || cur.score < score) scored.set(t, { term: t, lift, count: c, score, df: winDf.get(t) });
    }
  }

  // 只留「最长形」：「大树守卫」够用时就不要它的碎片「大树」「树守」
  const all = [...scored.values()];
  const kept = all.filter((a) => {
    return !all.some((b) => {
      if (b === a) return false;
      if (b.term.length <= a.term.length) return false;
      if (!b.term.includes(a.term)) return false;
      return b.df >= a.df * 0.9;
    });
  });

  return { terms: kept.sort((a, b) => b.score - a.score).slice(0, 10), skipped: kept.length ? null : skipped };
}

function search(store, opts = {}) {
  const t0 = Date.now();
  const raw = String(opts.q || '').trim();
  // 不设最小长度：一个字、一个表情都是弹幕，「哈」和「😂」同样该能搜到
  const exact = keyOf(raw);
  if (!exact) return { ok: false, error: '请输入关键词', rows: [], total: 0 };

  const limit = Math.min(Number(opts.limit) || 200, 1000);
  const rid = opts.rid ? Number(opts.rid) : null;
  const from = opts.from ? Number(opts.from) : null;
  const to = opts.to ? Number(opts.to) : null;
  const useSynonym = opts.synonym !== false;
  const useCooccur = opts.cooccur !== false;

  const synWords = useSynonym ? lexicon.synonymsOf(raw, opts.lexiconExtra) : [];
  const syn = synWords.map((w) => ({ word: w, norm: normalize(w) })).filter((s) => s.norm && s.norm !== exact);

  const terms = [exact, ...syn.map((s) => s.norm)];
  const rows = store.searchMessages(terms, { rid, from, to, limit: Math.min(limit * 2, 1200) });

  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const ntxt = keyOf(r.txt);
    const reason = reasonOf(ntxt, exact, syn);
    seen.add(r.id);
    out.push({ ...r, reason: reason.label, reasonType: reason.type });
  }

  let cooccur = [];
  let cooccurNote = null;
  if (useCooccur && out.length >= 5) {
    try {
      const mined = mineCooccurrence(store, out, terms, opts.log);
      cooccur = mined.terms;
      if (!cooccur.length && mined.skipped) {
        cooccurNote =
          mined.skipped === 'corpus_too_short'
            ? '本地语料还太短，时间窗几乎覆盖全库，共现统计还不成立；继续采集几小时后再试'
            : '命中太少，暂无法挖掘强相关词';
      }
    } catch (err) {
      opts.log && opts.log(`共现分析失败：${err.message}`);
    }
  } else if (useCooccur) {
    cooccurNote = '命中不足 5 条，暂不做强相关扩展';
  }

  if (cooccur.length) {
    const terms2 = cooccur.map((c) => c.term);
    const extra = store.searchMessages(terms2, { rid, from, to, limit: Math.min(limit, 600) });
    for (const r of extra) {
      if (seen.has(r.id)) continue;
      const ntxt = keyOf(r.txt);
      const hit = cooccur.find((c) => ntxt.includes(c.term));
      if (!hit) continue;
      seen.add(r.id);
      out.push({
        ...r,
        reason: `强相关：${hit.term}（lift ${hit.lift.toFixed(1)}）`,
        reasonType: 'cooccur',
      });
    }
  }

  out.sort((a, b) => b.cst - a.cst);

  // 计数走 SQL，不是数这一页的行。三路召回本身就重叠（精确命中的句子常常也含同义词），
  // 用 exclude 做互斥，保证「共 N 条」是真实条数——否则 limit=5 时总数会被页面大小骗成 18。
  const synTerms = syn.map((s) => s.norm).filter(Boolean);
  const coocTerms = cooccur.map((c) => c.term);
  const exactN = store.countByTerms([exact], { rid, from, to });
  const synonymN = synTerms.length ? store.countByTerms(synTerms, { exclude: [exact], rid, from, to }) : 0;
  const cooccurN = coocTerms.length
    ? store.countByTerms(coocTerms, { exclude: [exact, ...synTerms], rid, from, to })
    : 0;
  const counts = { exact: exactN, synonym: synonymN, cooccur: cooccurN };
  const total = exactN + synonymN + cooccurN;

  // 列表按句聚合：弹幕潮里 24 个人刷同一句，逐条铺开等于没排序。
  // 条数是 SQL 真值（不是这一页），展开时才看具体是谁。
  const allTerms = [exact, ...synTerms, ...coocTerms];
  const groups = store
    .groupByTerms(allTerms, { rid, from, to, limit: Math.min(limit, 200) })
    .map((g) => {
      const ntxt = keyOf(g.txt);
      const direct = ntxt.includes(exact) || syn.some((s) => s.norm && ntxt.includes(s.norm));
      if (direct) {
        const reason = reasonOf(ntxt, exact, syn);
        return { ...g, reason: reason.label, reasonType: reason.type };
      }
      const hit = coocTerms.find((t) => ntxt.includes(t));
      return hit
        ? { ...g, reason: `强相关：${hit}`, reasonType: 'cooccur' }
        : { ...g, reason: '精确命中', reasonType: 'exact' };
    });

  return {
    ok: true,
    query: raw,
    terms: [raw, ...syn.map((s) => s.word)],
    cooccurTerms: cooccur.map((c) => ({ term: c.term, lift: Number(c.lift.toFixed(2)), count: c.count })),
    cooccurNote,
    counts,
    total,
    groups,
    shown: Math.min(out.length, limit),
    truncated: out.length > limit || total > out.length,
    took: Date.now() - t0,
    rows: out.slice(0, limit).map((r) => ({
      id: r.id,
      rid: r.rid,
      room: r.room_name,
      uid: r.uid,
      nn: r.nn,
      txt: r.txt,
      stem: stem(r.txt),
      cst: r.cst,
      level: r.level,
      badge: r.bnn ? `${r.bnn}${r.bl ? ' ' + r.bl : ''}` : '',
      source: r.source || 'live',
      reason: r.reason,
      reasonType: r.reasonType,
    })),
  };
}

// ---------------------------------------------------------------- 关键词推荐

/**
 * 房间高频词：按「独立成段的片段」计数，不做 bigram（否则会切出「是明」「会胖」这种碎词）。
 *
 * 处理弹幕潮的方式是「剔除潮本身的说法」，而不是丢掉潮窗口里的行：
 * 一场抽奖口令能刷几千条，若整段跳过，2 小时窗口里可能剩不下几条正常弹幕
 * （实测 6657 房间 8000 条里 92% 落在潮窗口内）。所以这里照常统计，
 * 只把命中潮说法的词从结果里摘掉——「我选择」「为本场」这类模板碎片也就一起没了。
 */
function keywords(store, opts = {}) {
  const { rid, from = 0, to = Date.now(), limit = 10, sampleLimit = 8000 } = opts;
  const rows = store.chatRows({ rid, from, to, limit: sampleLimit });
  if (!rows.length) return { ok: true, terms: [], sample: 0, floodTerms: 0 };

  const floodCache = new Map();
  const floodPhrases = (r) => {
    if (!floodCache.has(r)) {
      let list = [];
      try {
        list = store
          .floodRanges(r, from, to)
          .map((f) => normalize(f.phrase || ''))
          .filter((s) => s.length >= 2);
      } catch {
        list = [];
      }
      floodCache.set(r, list);
    }
    return floodCache.get(r);
  };
  const isFloodTerm = (term, ridOfRow) =>
    floodPhrases(ridOfRow).some((p) => p.includes(term));

  const counts = new Map();
  for (const row of rows) {
    const seen = new Set();
    for (const seg of segmentsOf(row.txt)) {
      const s = seg.trim();
      if (s.length < 2 || s.length > 12) continue;
      if (STOP_TERMS.has(s)) continue;
      if (/^[\d.\s]+$/.test(s)) continue;
      if (/^[a-z0-9]+$/.test(s) && s.length < 3) continue;
      const key = normalize(s);
      if (!key || key.length < 2) continue;
      if (seen.has(key)) continue; // 同一条里复读只算一次
      seen.add(key);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }

  // 潮说法命中的词直接摘掉。注意复杂度：按「候选词 × 潮说法」比，不能按「消息 × 候选词」，
  // 后者在 8000 条 × 数千候选词时是千万级字符串查找，会直接把接口拖死。
  const ridSet = new Set(rows.map((r) => r.rid));
  const phrases = [];
  for (const r of ridSet) phrases.push(...floodPhrases(r));
  const flooded = new Set();
  for (const k of counts.keys()) {
    if (phrases.some((p) => p.includes(k))) flooded.add(k);
  }

  // 近似变体合并：同长度只差一个字（胖哥两 / 胖哥俩）当作同一个词，取高频写法
  const merged = [];
  for (const [term, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    if (flooded.has(term)) continue;
    const hit = merged.find((m) => nearDup(m.term, term));
    if (hit) hit.n += n;
    else merged.push({ term, n });
  }

  const terms = merged
    .sort((a, b) => b.n - a.n || a.term.localeCompare(b.term))
    .filter((t) => t.n >= 2)
    .slice(0, Math.max(Number(limit) || 10, 1));

  return { ok: true, terms, sample: rows.length, floodTerms: flooded.size };
}

/** 两个词是否「只差一个字」：等长允许 1 处替换，长度差 1 允许 1 处增删 */
function nearDup(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    let diff = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
    return diff <= 1;
  }
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  let i = 0;
  let j = 0;
  let skipped = 0;
  while (i < s.length && j < l.length) {
    if (s[i] === l[j]) {
      i++;
      j++;
    } else {
      skipped++;
      j++;
      if (skipped > 1) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------- 画像

const AD = lexicon.AD_WORDS.map((w) => w.toLowerCase());
const AGG = lexicon.AGGRESSIVE_WORDS.map((w) => w.toLowerCase());
const RHYTHM = lexicon.RHYTHM_WORDS.map((w) => w.toLowerCase());
const CAMP = lexicon.CAMP_WORDS.map((w) => w.toLowerCase());
const TAUNT = lexicon.TAUNT_MARK.map((w) => w.toLowerCase());

function countHits(msgs, words) {
  const hits = [];
  for (const m of msgs) {
    const low = String(m.txt).toLowerCase();
    if (words.some((w) => low.includes(w))) hits.push(m);
  }
  return hits;
}

/**
 * 节奏发言：骂人是一类，拱火是另一类，画像里都归到「对立倾向」，但分开计数。
 *
 * - 直接骂人：命中 AGGRESSIVE_WORDS。
 * - 节奏词：「急了」「串子」「反串」「乐子」这类，命中也算。
 * - 单独一个「急」只有在短语里才算（「你急」「就急」「急啥」），
 *   否则「着急」「紧急」「急死」会误伤；短句里的裸「急」同样按节奏算。
 * - 阵营词（龙美/鹰美/美圣贤/精冰/粉蜂…）**只在同句带挑事语气时**才算：
 *   「我是龙美」是立场，不是对立；「龙美急了」才是。
 */
const BARE_JI = /(^|[^\p{L}])(急)([^\p{L}]|$)/u;
const JI_PHRASE = /(你急|就急|急啥|急什么|急了吧|急死你|别急|急了)/;

function isRhythm(txt) {
  const t = String(txt || '').toLowerCase();
  if (!t) return false;
  if (RHYTHM.some((w) => t.includes(w))) return true;
  if (JI_PHRASE.test(t)) return true;
  if (t.length <= 8 && BARE_JI.test(t)) return true;
  if (CAMP.some((w) => t.includes(w)) && TAUNT.some((w) => t.includes(w))) return true;
  return false;
}

function profile(store, uid, opts = {}) {
  const id = String(uid || '').trim();
  if (!id) return { ok: false, error: '缺少用户 id' };

  const totals = store.userTotals(id);
  const msgs = store.userMessages(id, { limit: 5000 });
  if (!msgs.length) return { ok: false, error: '本地没有该用户的弹幕记录', empty: true };

  const rooms = store.userRoomBreakdown(id);
  const badges = store.userBadges(id);
  const topTexts = store.userTopTexts(id);
  const gifts = store.userGifts(id);

  const total = Number(totals.total) || msgs.length;
  const days = Number(totals.days) || 1;
  const spanDays = Math.max(1, Math.round((Number(totals.last) - Number(totals.first)) / 86400000) + 1);
  const perDay = total / Math.max(1, days);

  const hourly = new Array(24).fill(0);
  const textCount = new Map();
  let shortN = 0;
  let lenSum = 0;
  let entSum = 0;
  for (const m of msgs) {
    const d = new Date(Number(m.cst));
    hourly[d.getHours()]++;
    lenSum += m.txt.length;
    if (m.txt.length <= 3) shortN++;
    entSum += entropy(normalize(m.txt));
    const k = normalize(m.txt);
    textCount.set(k, (textCount.get(k) || 0) + 1);
  }
  const avgLen = lenSum / msgs.length;
  const uniqueRatio = textCount.size / msgs.length;
  const repeatRatio = 1 - uniqueRatio;
  const shortRatio = shortN / msgs.length;
  const nightN = hourly.slice(0, 6).reduce((a, b) => a + b, 0);
  const nightRatio = nightN / msgs.length;
  const avgEnt = entSum / msgs.length;

  const topRoomShare = rooms.length ? Number(rooms[0].n) / total : 0;
  const hhi = rooms.reduce((s, r) => s + Math.pow(Number(r.n) / total, 2), 0);

  // 采集缺口：断线期间的数据永久丢失，那段时间的「安静」不是用户不发言。
  // 所以有效采集时长要从跨度里扣掉缺口，频率类指标才有正确的分母。
  const cov = store.coverage({ from: Number(totals.first), to: Number(totals.last) });
  const effectiveHours = cov.effectiveMs / 3600000;
  const gapMinutes = Math.round(cov.gapMs / 60000);

  // 发言间隔规律性（机器人常见匀速发言）
  let cv = 1;
  if (msgs.length >= 8) {
    const diffs = [];
    for (let i = 1; i < msgs.length; i++) {
      const d = Number(msgs[i].cst) - Number(msgs[i - 1].cst);
      if (d > 0 && d < 3600000) diffs.push(d);
    }
    if (diffs.length >= 5) {
      const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
      const sd = Math.sqrt(diffs.reduce((s, d) => s + (d - mean) ** 2, 0) / diffs.length);
      cv = mean ? sd / mean : 1;
    }
  }

  const adMsgs = countHits(msgs, AD);
  const directMsgs = countHits(msgs, AGG);
  const rhythmMsgs = msgs.filter((m) => !directMsgs.includes(m) && isRhythm(m.txt));
  const aggMsgs = directMsgs.concat(rhythmMsgs);
  const lotteryMsgs = msgs.filter((m) => /抽奖|白嫖|中奖|欧皇|非酋|福利/.test(m.txt));
  const adRatio = adMsgs.length / total;
  const aggRatio = directMsgs.length / total;
  const rhythmRatio = rhythmMsgs.length / total;

  const topBadge = badges[0];
  const badgeMatch = topBadge && rooms[0] && Number(topBadge.brid) === Number(rooms[0].rid);

  const scores = {
    activity: Math.round(clamp(15 * Math.log2(perDay + 1) + 20 * Math.min(1, days / 20))),
    loyalty: Math.round(clamp(100 * (0.55 * topRoomShare + 0.25 * (badgeMatch ? 1 : 0) + 0.2 * Math.min(1, spanDays / 30)))),
    diversity: Math.round(clamp(100 * (0.55 * Math.min(1, rooms.length / 6) + 0.45 * uniqueRatio))),
    // 骂人满格、拱火半格；样本太少时向 0 收缩（5 条里 2 条拱火不该等于「铁对立」）
    aggression: Math.round(clamp((aggRatio * 900 + rhythmRatio * 450) * Math.min(1, total / 20))),
    bot: Math.round(clamp(100 * (0.4 * repeatRatio + 0.22 * shortRatio + 0.22 * (1 - Math.min(1, avgEnt / 3)) + 0.16 * (1 - Math.min(1, cv))))),
    spend: Math.round(clamp(gifts > 0 ? 25 + 12 * Math.log2(gifts + 1) : 0)),
  };

  const topics = store.userTopics(id).map((t) => ({
    key: t.topic || 'chat',
    name: COPY.TOPIC[t.topic || 'chat'] || t.topic,
    n: Number(t.n),
    share: Number((Number(t.n) / total).toFixed(3)),
  }));
  const flood = store.userFloodShare(id);

  const labels = [];
  const add = (key, desc, weight, evidence) =>
    labels.push({
      key,
      label: COPY.LABEL[key] || key,
      desc,
      weight: Math.round(weight),
      evidence: evidence.slice(0, 3).map((m) => ({ txt: m.txt, nn: m.nn, cst: m.cst, rid: m.rid })),
    });

  if (total < 30) add('thin', fill(COPY.NOTE.thin, { n: 30 }), 30, msgs.slice(-3));
  if (topRoomShare >= 0.6 && total >= 30)
    add('loyal', `在「${rooms[0].room_name || rooms[0].rid}」发言占 ${pct(topRoomShare)}%`, topRoomShare * 100, msgs.slice(-3));
  if (rooms.length >= 5 && topRoomShare < 0.45)
    add('roam', fill(T.spread, { n: rooms.length }), 70, msgs.slice(-3));
  if (repeatRatio >= 0.5 && total >= 20 && scores.aggression < 50)
    add('repeat', fill(T.repeat, { n: Math.round(total * repeatRatio), pct: pct(repeatRatio) }), repeatRatio * 100,
      msgs.filter((m) => (textCount.get(normalize(m.txt)) || 0) > 1).slice(-3));
  if (scores.aggression >= 35) add('toxic', fill(T.fight, { n: aggMsgs.length }), scores.aggression, aggMsgs);
  if (adMsgs.length >= 2 && adRatio >= 0.02) add('ad', fill(T.ad, { n: adMsgs.length }), Math.min(100, adMsgs.length * 12), adMsgs);
  if (lotteryMsgs.length >= 3) add('lotto', fill(T.topTopic, { cat: COPY.TOPIC.event, n: lotteryMsgs.length }), Math.min(100, lotteryMsgs.length * 8), lotteryMsgs);
  if (nightRatio >= 0.35 && total >= 20)
    add('night', fill(T.night, { n: nightN }), nightRatio * 100, msgs.filter((m) => new Date(Number(m.cst)).getHours() < 6).slice(-3));
  if (perDay >= 20) add('talker', `活跃日均 ${perDay.toFixed(1)} 条`, Math.min(100, perDay), msgs.slice(-3));
  if (perDay < 2 && days >= 3) add('lurk', `活跃日均仅 ${perDay.toFixed(1)} 条`, 60, msgs.slice(-3));
  if (scores.bot >= 65)
    add('bot', fill(T.lure, { n: avgLen.toFixed(1), pct: pct(shortRatio) }), scores.bot, msgs.slice(-3));

  return {
    ok: true,
    uid: id,
    names: [...new Set(msgs.map((m) => m.nn).filter(Boolean))].slice(0, 5),
    range: { first: Number(totals.first), last: Number(totals.last), spanDays, days },
    total,
    stats: {
      perDay: Number(perDay.toFixed(2)),
      avgLen: Number(avgLen.toFixed(1)),
      uniqueRatio: Number(uniqueRatio.toFixed(3)),
      repeatRatio: Number(repeatRatio.toFixed(3)),
      shortRatio: Number(shortRatio.toFixed(3)),
      nightRatio: Number(nightRatio.toFixed(3)),
      rooms: rooms.length,
      hhi: Number(hhi.toFixed(3)),
      gifts,
      maxLevel: Number(totals.max_level) || 0,
      intervalCv: Number(cv.toFixed(2)),
    },
    coverage: {
      spanHours: Number((cov.spanMs / 3600000).toFixed(2)),
      effectiveHours: Number(effectiveHours.toFixed(2)),
      gapCount: cov.gapCount,
      gapMinutes,
      downtimeCount: cov.downtimeCount || 0,
      downtimeMinutes: Math.round((cov.downtimeMs || 0) / 60000),
      partial: cov.gapCount > 0,
    },
    scores,
    labels: labels.sort((a, b) => b.weight - a.weight),
    sources: {
      live: msgs.filter((m) => m.source !== 'vod' && m.source !== 'import').length,
      vod: msgs.filter((m) => m.source === 'vod').length,
      import: msgs.filter((m) => m.source === 'import').length,
    },
    rooms: rooms.map((r) => ({ rid: r.rid, name: r.room_name, n: Number(r.n), share: Number((Number(r.n) / total).toFixed(3)) })),
    badges: badges.map((b) => ({ name: b.bnn, level: b.bl, rid: b.brid, n: Number(b.n) })),
    hourly,
    topics,
    flood: { total: flood.total, inFlood: flood.inFlood, share: Number((flood.share || 0).toFixed(3)) },
    // 对立倾向拆开给：直接骂人多少条、拱火带节奏多少条，避免把「龙美」这类
    // 阵营标签本身当成攻击
    hostility: {
      direct: directMsgs.length,
      rhythm: rhythmMsgs.length,
      total: aggMsgs.length,
      // 明细：点开就能看到具体是哪几句，按时间倒序，最多 500 条
      rows: aggMsgs
        .slice()
        .sort((a, b) => b.cst - a.cst)
        .slice(0, 500)
        .map((m) => ({
          txt: m.txt,
          cst: m.cst,
          rid: m.rid,
          room: m.room_name,
          kind: directMsgs.includes(m) ? 'direct' : 'rhythm',
        })),
    },
    topTexts: topTexts.map((t) => ({ txt: t.txt, n: Number(t.n) })),
    // 「最近 50 条」和「最近 20 条发言」是两回事：前者给用户页的明细列表用
    recent: msgs.slice(-50).reverse().map((m) => ({
      txt: m.txt,
      cst: m.cst,
      room: m.room_name,
      rid: m.rid,
      topic: m.topic || '',
      source: m.source || 'live',
    })),
    daily: store.userDaily(uid, { days: 30 }),
    sample: msgs.slice(-20).map((m) => ({ txt: m.txt, cst: m.cst, room: m.room_name })),
  };
}

module.exports = { search, profile, keywords };
