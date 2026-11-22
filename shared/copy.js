'use strict';

/**
 * 面向用户的自有文案，集中在这里。
 *
 * 规则（tools/copy-lint.js 会检查）：
 * 1. 这里的每个字符串都是「我们说的话」，不得出现 喜欢 / 偏好 / 感兴趣 / 最爱 / 热衷
 *    —— 本工具只做行为归纳，不做心理归因。
 * 2. 证据句用占位符：模板在字典里受检，填充进去的数据（弹幕、类别名、数字）不受检。
 * 3. web/app.js 里新写的中文字符串必须引用 COPY，或在同一行标注 `// copy-ok: 理由`。
 *
 * 同时供 Node（require）和浏览器（<script src="/copy.js">）使用。
 */
(function (root, factory) {
  const COPY = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = COPY;
  if (root) root.COPY = COPY;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  return {
    DIM: {
      activity: '活跃度',
      loyalty: '房间黏性',
      diversity: '话题多样性',
      aggression: '对立倾向',
      bot: '程序化倾向',
      
    },

    LABEL: {
      thin: '样本偏少',
      loyal: '本房常驻',
      roam: '跨房活跃',
      repeat: '高频复读',
      toxic: '对立性发言偏多',
      ad: '疑似引流',
      lotto: '抽奖参与多',
      night: '深夜活跃',
      talker: '高频发言',
      lurk: '低频发言',
      bot: '疑似程序化发言',
    },

    TOPIC: {
      event: '活动抽奖',
      ad: '广告引流',
      troll: '对立嘲讽',
      game: '游戏内容',
      ask: '提问互动',
      emo: '情绪反应',
      greet: '打招呼签到',
      anchor: '主播互动',
      chat: '日常闲聊',
    },

    /** 检索结果展开：首发 / 谁在发 */
    DETAIL: {
      title: '看谁在发、本房间最早是谁',
      expand: '展开',
      collapse: '收起',
      originLoading: '本房间最早：查询中…',
      originEmpty: '本房间最早：本地没有记录',
      originFailed: '本房间最早：加载失败',
      sendersLoading: '谁在发：加载中…',
      sendersEmpty: '谁在发：本地没有记录',
      sendersFailed: '谁在发：加载失败',
      sendersTitle: '谁在发（{n} 人）：',
      originWho: '本房间最早：{who} · ',
      originStats: '共 {total} 条 / {users} 人 · 其中被 +1 {plusOne} 次 · 弹幕潮 {floods} 次',
      sampleFrom: '样本取自 {who}',
      firstInRoom: '本房间最早 {date} {time}',
    },

    /** 收藏夹：排序与 +1 口径 */
    FAV: {
      sortBy: '排序',
      byTime: '收藏时间',
      byPlus1: '被 +1 数',
      desc: '倒序 ↓',
      asc: '正序 ↑',
      dirTitle: '切换正序 / 倒序',
      count: '共 {n} 条收藏',
      plusOne: '+1 {n}',
      plus1Hint: '「+1」= 同一种说法的跟发次数（总条数 − 1）。',
    },

    /** 画像图、检索复制、时间线跳检索 */
    PROFILE: {
      hourTitle: '发言时段分布（全量）',
      hourTip: '{time} · {n} 条 · 占 {pct}%',
      hourHint: '0 点 → 23 点 · 悬停看条数和占比',
      dayTip: '{day} · {n} 条 · 点击看当天时间线',
      dayHint: '共 {n} 天有发言 · 最多一天 {max} 条 · 点柱子看那一天',
      copy: '复制',
      copyTitle: '复制这句话',
      copied: '已复制',
      copyFailed: '复制失败，请手动选择文本',
      timelineOpen: '在检索里看这句',
      basisNote: '全量：总数、均长、短文本、夜间、去重；文本类（情绪/广告/对立/节奏/标签证据）：最近 {n} 条样本',
    },

    /** 填 {key} 占位符；缺失的键原样保留，方便测试发现漏填 */
    fill(tpl, vars) {
      return String(tpl == null ? '' : tpl).replace(/\{(\w+)\}/g, (all, key) =>
        vars && key in vars ? String(vars[key]) : all
      );
    },

    EVIDENCE: {
      topTopic: '发得最多的是「{cat}」类内容（共 {n} 条）',
      repeat: '有 {n} 条弹幕和别人的话完全重复（复读率 {pct}%）',
      flood: '{n} 条弹幕出现在弹幕潮里（占 {pct}%）',
      fight: '出现 {n} 条对立性措辞',
      ad: '出现 {n} 条疑似引流内容',
      night: '{n} 条弹幕发生在 0–6 点',
      lure: '平均每条 {n} 字，重复率 {pct}%',
      spread: '在 {n} 个房间发过言',
      none: '样本太少，暂无可归纳的行为',
    },

    NOTE: {
      notIdentity: '这里输出的是基于发言的行为归纳，不是身份判定。',
      localOnly: '统计只覆盖本工具采集到的弹幕。',
      thin: '样本少于 {n} 条，结论仅供参考。',
      firstSeen: '本房间内、本工具采集到的第一条，不代表原创。',
      gap: '采集缺口期间的行为没有被记录，相关特征可能偏低（偏差只会少算，不会多算）。',
      gapLine: '有效采集 {eff} 小时，其中 {gap} 分钟因断线缺失。',
    },
  };
});
