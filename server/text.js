'use strict';

/** 文本归一化与分词（供检索、画像共用，零依赖）。 */

const CJK = /[\u4e00-\u9fff]/;

/** 归一化：全半角统一、小写、去标点空白与表情，只留文字数字 */
function normalize(input) {
  return String(input == null ? '' : input)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * 轻量分词：英文/数字按词，中文按二元字组（bigram）。
 * 无词典也能得到可用的共现统计粒度。
 */
function tokenize(normalized) {
  const out = [];
  const s = String(normalized || '');
  const re = /[a-z0-9]{2,}|[\u4e00-\u9fff]+/g;
  let m;
  while ((m = re.exec(s))) {
    const seg = m[0];
    if (/^[a-z0-9]+$/.test(seg)) {
      out.push(seg);
      continue;
    }
    if (seg.length === 1) {
      out.push(seg);
      continue;
    }
    for (let i = 0; i + 1 < seg.length; i++) out.push(seg.slice(i, i + 2));
  }
  return out;
}

/**
 * 保留边界的轻量分词：先按标点/空白切段，再在段内取 bigram。
 * 与 tokenize() 的差别是「猴哥，我」不会产出跨标点的假词「哥我」。
 */
function tokenizeText(text) {
  const out = [];
  const segs = String(text == null ? '' : text)
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u);
  for (const seg of segs) {
    if (!seg) continue;
    if (/^[a-z0-9]+$/.test(seg)) {
      if (seg.length >= 2) out.push(seg);
      continue;
    }
    if (seg.length === 1) {
      out.push(seg);
      continue;
    }
    for (let i = 0; i + 1 < seg.length; i++) out.push(seg.slice(i, i + 2));
  }
  return out;
}

/** 去重后的词集合 */
function tokenSet(normalized) {
  return new Set(tokenize(normalized));
}

/** 按标点切成片段（保留原意，不做 bigram） */
function segmentsOf(text) {
  return String(text == null ? '' : text)
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((s) => s.length >= 2 && s.length <= 12);
}

/**
 * 短语级候选词：片段本身（2–12 字）+ 片段内部 bigram。
 * 比 tokenizeText 更适合「强相关词」挖掘——先拿到「大树守卫」再决定要不要退化成 bigram。
 */
function phraseTokens(text) {
  const out = [];
  for (const seg of segmentsOf(text)) {
    out.push(seg);
    if (/^[a-z0-9]+$/.test(seg)) continue;
    if (seg.length < 3) continue;
    for (let i = 0; i + 1 < seg.length; i++) out.push(seg.slice(i, i + 2));
  }
  return out;
}

/** 字符熵（用于机器化判定） */
function entropy(normalized) {
  const s = String(normalized || '');
  if (!s) return 0;
  const freq = new Map();
  for (const ch of s) freq.set(ch, (freq.get(ch) || 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** 截断展示用文本 */
function clip(s, n = 60) {
  const str = String(s || '');
  return str.length > n ? str.slice(0, n) + '…' : str;
}

function isCJK(s) {
  return CJK.test(String(s || ''));
}

const TAIL_PARTICLES = new Set('的了啊呀吧呢嘛哈哦嗯啦吗么诶欸'.split(''));

/**
 * 折叠成「同一句话」的形态，用于统计复读与首发：
 * - 连续 3 个以上相同字符折成 2 个（哈哈哈哈哈 → 哈哈），但两字叠词保留（妈妈 ≠ 妈）；
 * - 再去掉尾部语气词，仅在还剩 ≥2 字时执行（「好的吧」→「好的」，「好」不动）。
 * 只用于聚合口径，不改动原始 ntxt —— 检索仍然按原文精确匹配。
 */
function stem(input) {
  const s = normalize(input);
  if (!s) return '';
  const collapsed = collapseRepeat(s);
  let out = collapsed;
  while (out.length > 2 && TAIL_PARTICLES.has(out[out.length - 1])) out = out.slice(0, -1);
  return out.length >= 2 ? out : collapsed;
}

/** 折叠重复字符但不裁剪（用于判断两条弹幕是不是同一句的不同写法） */
function collapseRepeat(input) {
  const s = normalize(input);
  let out = '';
  for (let i = 0; i < s.length; ) {
    let j = i + 1;
    while (j < s.length && s[j] === s[i]) j++;
    const run = j - i;
    // 3 个以上折成 2 个：这样「哈哈哈哈哈」「哈哈哈哈」「哈哈」落在同一个 key 上
    out += run >= 3 ? s[i] + s[i] : s.slice(i, j);
    i = j;
  }
  return out;
}

/**
 * 去掉开头的「回复某人」前缀：斗鱼的回覆弹幕形如 `@昵称: 正文` / `@昵称：正文`。
 * 不剥掉的话，同一句刷屏因为回覆对象不同会被拆成几十个不同的 stem——
 * 列表里就会看到一堆字面一模一样的行，各自标着 ×9、×8、×5。
 */
const MENTION_RE = /^@[^\r\n]{1,24}?[:：]\s*/;
// 有的回覆没有 @，直接是「昵称：正文」，昵称常常是纯 emoji（🗿：xxx）
const EMOJI_MENTION_RE = /^[^\p{L}\p{N}\r\n]{1,6}[:：]\s*/u;

function stripMention(input) {
  const t = String(input == null ? '' : input);
  if (MENTION_RE.test(t)) return t.replace(MENTION_RE, '');
  if (EMOJI_MENTION_RE.test(t)) {
    const rest = t.replace(EMOJI_MENTION_RE, '');
    if (rest.trim()) return rest;
  }
  return t;
}

/**
 * 检索 / 聚合用的键：归一化之后如果什么都不剩（纯表情、纯标点、单个符号），
 * 退回原文。这类弹幕同样是观众表达——「一个字就有巧思」，🐒 刷屏也是潮，
 * 不能因为归一化把它抹成空字符串就从检索和潮里消失。
 */
function keyOf(input) {
  const t = stripMention(input);
  const n = normalize(t);
  if (n) return n;
  return String(t).trim() || String(input == null ? '' : input).trim();
}

/** stem 的空值兜底同样退回原文键 */
function stemOf(input) {
  return stem(stripAffixes(stripMention(input))) || keyOf(input);
}

/**
 * 用户配置的前后缀（例如「…desuwa」「草…」）。
 * 目的：同一句话带上口头禅尾巴不该被算成两种说法，否则「被 +1」永远统计不出来。
 * 规则刻意保守——剥完至少要剩 2 个字，单字母/单数字不做后缀，避免把 new 剥成 ne。
 */
const AFFIX = { prefixes: [], suffixes: [] };

function setAffixes(cfg = {}) {
  const clean = (arr) =>
    [...new Set((arr || []).map((s) => String(s || '').trim()).filter(Boolean))].slice(0, 60);
  AFFIX.prefixes = clean(cfg.prefixes);
  AFFIX.suffixes = clean(cfg.suffixes);
  return AFFIX;
}

function getAffixes() {
  return { prefixes: AFFIX.prefixes.slice(), suffixes: AFFIX.suffixes.slice() };
}

function usableAffix(a) {
  if (!a) return false;
  // 单字母/单数字不当后缀：「new」会被剥成「ne」
  if (a.length === 1 && /[a-z0-9]/i.test(a)) return false;
  return true;
}

function stripAffixes(input) {
  let s = String(input == null ? '' : input).trim();
  if (!AFFIX.prefixes.length && !AFFIX.suffixes.length) return s;
  for (let guard = 0; guard < 8; guard++) {
    let changed = false;
    for (const p of AFFIX.prefixes) {
      if (!usableAffix(p) || s.length < p.length + 2) continue;
      if (s.toLowerCase().startsWith(p.toLowerCase())) {
        s = s.slice(p.length).replace(/^[\s,，、.。~～!！]+/, '');
        changed = true;
      }
    }
    for (const q of AFFIX.suffixes) {
      if (!usableAffix(q) || s.length < q.length + 2) continue;
      if (s.toLowerCase().endsWith(q.toLowerCase())) {
        s = s.slice(0, s.length - q.length).replace(/[\s,，、.。~～!！]+$/, '');
        changed = true;
      }
    }
    if (!changed) break;
  }
  return s;
}

module.exports = {
  normalize,
  keyOf,
  stemOf,
  stripMention,
  tokenize,
  tokenizeText,
  tokenSet,
  segmentsOf,
  phraseTokens,
  entropy,
  clip,
  isCJK,
  stem,
  collapseRepeat,
  stripAffixes,
  setAffixes,
  getAffixes,
};
