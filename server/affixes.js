'use strict';

/**
 * 常用弹幕口头禅尾巴。勾上之后，带这些尾巴的说法会并到同一句里：
 * 「这踏马是哪？我不是在京东购物吗desuwa」和原句算同一条。
 *
 * 这里只处理「口癖」，不做同义替换——同义归词表（lexicon）管。
 * 要解决的是"同一句话因为口癖被拆成两种说法"，否则「被 +1」永远统计不出来。
 */
const SUFFIX_PRESETS = [
  'desuwa', 'desu', 'deshou', 'nya', 'nyan', 'awa', 'qwq', 'qaq', 'orz',
  '233', '2333', '喵', '捏', '哒', '酱', '喔', '啦', '嘛', '诶', '欸',
];

const PREFIX_PRESETS = ['草', '笑死', '我超', '卧槽', '就是说', '不是'];

const PRESETS = {
  suffixes: SUFFIX_PRESETS.map((v) => ({ value: v, label: v, note: '口癖尾巴' })),
  prefixes: PREFIX_PRESETS.map((v) => ({ value: v, label: v, note: '开头语气词' })),
};

module.exports = { PRESETS };
