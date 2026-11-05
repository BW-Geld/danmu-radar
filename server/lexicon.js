'use strict';

/**
 * 内置词表：同义/梗词扩展、广告词、攻击性词。
 * 用户可在 data/lexicon.json 覆盖或追加，格式：
 *   { "groups": [["词A","词B"]], "ad": ["..."], "aggressive": ["..."] }
 */

const GROUPS = [
  ['开团', '开干', '冲', '上啊', '干他', '冲了', '上上上'],
  ['抽奖', '抽', '白嫖', '中奖', '欧皇', '非酋', '福利'],
  ['主播', '老哥', '兄弟', '哥们', '大佬'],
  ['牛', 'nb', '牛逼', '厉害', '666', '强'],
  ['菜', '下饭', '拉胯', '臭', '搞笑'],
  ['退了', '下播', '溜了', '走了', '晚安'],
  ['来了', '报到', '打卡', '签到', '来了来了'],
  ['哈哈', '笑死', '哈哈哈', '乐', '绷不住'],
  ['问号', '？', '什么情况', '咋了', '发生甚么事'],
  ['外挂', '挂', '开挂', '科技', '脚本'],
  ['举报', '封号', '违规', '超管'],
  ['礼物', '刷礼物', '飞机', '火箭', '办卡'],
];

const AD_WORDS = [
  '加群', '加微信', '加qq', '私聊', '私信', '代练', '代打', '收号', '卖号',
  '链接', '淘宝', '拼多多', '优惠', '返利', '兼职', '日结', '带你', '上车',
];

const AGGRESSIVE_WORDS = [
  '傻逼', 'sb', '脑残', '垃圾', '废物', '滚', '狗叫', '闭嘴', '弱智', '智障',
  '死全家', 'nmsl', 'cnm', '草泥马', '恶心', '恶心人', '小丑', '急了',
];

/**
 * 节奏词：本身不一定脏，但在这类直播间里就是挑事/拱火的信号。
 * 「急了」「别叫」「串子」「反串」「乐子」这类，出现即计一次节奏发言。
 */
const RHYTHM_WORDS = [
  '急了', '别急', '别叫', '串子', '反串', '串子哥', '乐子', '乐子人',
  '带节奏', '开香槟', '破防', '闹麻了', '闹麻', '绷', '就这', '你行你上',
  '小黑子', '黑子', '关我屁事', '有本事', '敢不敢',
];

/**
 * 阵营/标签词：龙美、鹰美、美圣贤、精冰、粉蜂…这些是直播间里互相贴的标签。
 * 单独出现**不算**对立——「我是龙美」是立场，不是攻击；
 * 只有和节奏词/攻击词同句出现，才算一次对立发言。
 */
const CAMP_WORDS = [
  '龙美', '鹰美', '美圣贤', '圣贤', '精冰', '冰粉', '蜂美', '粉蜂',
  '龙鸣', '鹰鸣', '美美', '贤美', '子贡子路', '圣贤子弟',
];

/** 同句里出现这些，说明那句阵营词是在挑事而不是在表态 */
const TAUNT_MARK = [
  '急了', '别叫', '别急', '串', '反串', '乐子', '小丑', '破防', '闹麻', '绷',
  '就这', '？', '?', '哈哈', '偷笑', '窃喜', '憋笑', '阴阳', '急得', '急了',
];

const COPYPasta_MARK = ['复读', '复制', '粘贴'];

let cache = null;

function buildIndex(extra) {
  const groups = GROUPS.slice();
  if (extra && Array.isArray(extra.groups)) groups.push(...extra.groups.filter((g) => Array.isArray(g) && g.length));
  const map = new Map();
  groups.forEach((g, gi) => {
    for (const w of g) {
      const k = String(w).toLowerCase();
      if (!k) continue;
      if (!map.has(k)) map.set(k, { id: gi, group: g });
    }
  });
  return map;
}

/** 加载（可注入用户词表） */
function load(extra) {
  cache = buildIndex(extra);
  return cache;
}

function index(extra) {
  return cache || load(extra);
}

/**
 * 返回与 query 同组的其它词（不含自身）。
 * 单字词（乐、冲、挂、菜…）在长查询里只做噪声：搜「哈哈」不该召回一堆「乐？」，
 * 所以查询本身不是单字时，把单字同义词过滤掉。
 */
function synonymsOf(query, extra) {
  const map = index(extra);
  const q = String(query || '').toLowerCase();
  const hit = map.get(q);
  if (!hit) return [];
  return hit.group.filter((w) => {
    const k = w.toLowerCase();
    if (k === q) return false;
    if (q.length > 1 && k.length < 2) return false;
    return true;
  });
}

function words() {
  return { AD_WORDS, AGGRESSIVE_WORDS, RHYTHM_WORDS, CAMP_WORDS, COPYPasta_MARK };
}

module.exports = { synonymsOf, load, words, GROUPS, AD_WORDS, AGGRESSIVE_WORDS, RHYTHM_WORDS, CAMP_WORDS, TAUNT_MARK };
