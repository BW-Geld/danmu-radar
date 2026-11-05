'use strict';

/**
 * 把一次「已经观测到、但当时还没实现 gaps 表」的断线补记进去。
 * 用法：node tools/record-gap.js <rid> <ISO开始> <ISO结束> [retries]
 * 时间按本机时区解释，写入 from=开始前最后一条消息、to=结束后第一条消息。
 */

const { Store } = require('../server/db');

const [rid, fromIso, toIso, retries] = process.argv.slice(2);
if (!rid || !fromIso || !toIso) {
  console.error('用法：node tools/record-gap.js <rid> <开始时间> <结束时间> [重试次数]');
  process.exit(1);
}

const store = new Store();
const fromMs = Date.parse(fromIso);
const toMs = Date.parse(toIso);
if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
  console.error('时间格式无法解析，示例：2026-11-04T19:15:41+08:00');
  process.exit(1);
}

const before = store.db
  .prepare('SELECT MAX(cst) AS t FROM messages WHERE rid = ? AND cst <= ?')
  .get(Number(rid), fromMs);
const after = store.db
  .prepare('SELECT MIN(cst) AS t FROM messages WHERE rid = ? AND cst >= ?')
  .get(Number(rid), toMs);

const a = Number(before && before.t) || 0;
const b = Number(after && after.t) || 0;
if (!a || !b) {
  console.error('这个区间前后没有消息，无法定位缺口边界');
  process.exit(1);
}

const gap = store.addGap({ rid: Number(rid), from: a, to: b, retries: Number(retries) || 0 });
console.log('最后一条消息:', new Date(a).toLocaleString('zh-CN'));
console.log('恢复后第一条:', new Date(b).toLocaleString('zh-CN'));
console.log('写入结果:', gap);
console.log('当前缺口总数:', store.gapTotal({ rid: Number(rid) }));
store.close();
