'use strict';

/**
 * 弹幕词条归类：把每条弹幕归到一个大类，用于「观众最爱发哪类弹幕」。
 *
 * 规则优先，因为斗鱼弹幕短、口语化、错别字多，小样本上分类模型反而更容易飘。
 * 分类目标是「行为类别」，不是「语义标签」——同一句话在不同语境可以归不同类，
 * 我们只关心统计意义上的倾向，所以宁可粗、不要错。
 */

const { normalize } = require('./text');

// 顺序即优先级：越靠前越具体，命中即停（分数相同按顺序）
const CATS = [
  {
    key: 'event',
    name: '活动抽奖',
    words: [
      '抽奖', '口令', '福袋', '礼盒', '中奖', '兑换码', '领取', '活动', '福利', '红包',
      '秒杀', '优惠', '下单', '链接', '拍下', '抢购', '限时', '今晚八点', '直播间专属',
    ],
  },
  {
    key: 'ad',
    name: '广告引流',
    words: [
      '加群', '加微信', '私信', '代练', '收号', '卖号', '看我主页', '点我头像',
      '低价', '包上分', '陪玩', '接单', '出号', '收徒', '教程免费',
    ],
  },
  {
    key: 'troll',
    name: '对立嘲讽',
    words: [
      '傻逼', '脑残', '弱智', '废物', '垃圾', '狗东西', '滚', '闭嘴', '菜鸡', '菜狗',
      '丑陋', '退钱', '骗人', '恶心', '恶心人', '阴阳', '急了', '破防', '小丑',
      // 反串/拱火的口癖与阵营标签：这些话不带脏字，但在直播间里就是节奏
      '反串', '串子', '乐子', '带节奏', '闹麻', '就这', '别叫',
      '圣贤', '龙美', '鹰美', '精冰', '粉蜂', '蜂美', '偷笑', '窃喜', '子贡子路',
    ],
  },
  {
    key: 'game',
    name: '游戏内容',
    words: [
      '打野', '上单', '中单', '辅助', '射手', '英雄', '技能', '装备', '出装', '铭文',
      'boss', '副本', '开局', '操作', '走位', '团战', '开团', '推塔', '杀人', '送',
      '血条', '伤害', '暴击', '刷怪', '存档', '读档', '任务', '地图', 'boss战',
      '影之刃', '魂', '连招', '闪避', '弹反', 'boss', '存档点', '难度',
    ],
  },
  {
    key: 'ask',
    name: '提问互动',
    words: ['吗', '怎么', '为什么', '为啥', '在哪', '有没有', '谁知道', '求', '请问', '啥时候', '多少', '能不能'],
  },
  {
    key: 'emo',
    name: '情绪反应',
    words: [
      '哈哈', '笑死', '6', '牛', '牛逼', '卧槽', '我靠', '啊', '哭了', '泪目', '绝了',
      '好家伙', '离谱', '太强', '帅', '可爱', '急了', '绷不住', '人才', '笑不活了',
    ],
  },
  {
    key: 'greet',
    name: '打招呼签到',
    words: ['来了', '晚上好', '早上好', '下午好', '打卡', '签到', '第一', '沙发', '报到', '晚安', '下播'],
  },
  {
    key: 'anchor',
    name: '主播互动',
    words: ['主播', '老孙', '猴哥', '兰林汉', '房管', '粉丝牌', '牌子', '关注', '点赞', '点亮'],
  },
];

/** 归一化后的文本 → 类别 key */
function classify(txt) {
  const s = normalize(txt);
  if (!s) return 'chat';
  let best = null;
  let bestScore = 0;
  for (const cat of CATS) {
    let score = 0;
    for (const w of cat.words) {
      const nw = normalize(w);
      if (!nw) continue;
      if (s.includes(nw)) score += nw.length >= 2 ? 2 : 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = cat;
    }
  }
  if (best && bestScore >= 2) return best.key;
  return 'chat';
}

const NAMES = { chat: '日常闲聊' };
for (const c of CATS) NAMES[c.key] = c.name;

function nameOf(key) {
  return NAMES[key] || key;
}

function all() {
  return Object.keys(NAMES).map((k) => ({ key: k, name: NAMES[k] }));
}

module.exports = { classify, nameOf, all, CATS, NAMES };
