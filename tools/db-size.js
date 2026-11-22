#!/usr/bin/env node
'use strict';
// 数据量检查：只读文件大小，不打开数据库，不会和正在运行的服务抢锁。
// 用法：
//   node tools\db-size.js
//   node tools\db-size.js --json
//   node tools\db-size.js E:\path\to\danmaku.db

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_DB = path.join(ROOT, 'dist', '弹幕雷达-便携版', 'data', 'danmaku.db');
const JSON_OUT = process.argv.includes('--json');
const argPath = process.argv.slice(2).find((a) => !a.startsWith('-'));
const target = path.resolve(argPath || process.env.DANMU_DB || DEFAULT_DB);

const MB = 1024 * 1024;
const GB = 1024 * MB;
const fileSize = (p) => {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
};

const dbBytes = fileSize(target);
const walBytes = fileSize(target + '-wal');
const shmBytes = fileSize(target + '-shm');
const total = dbBytes + walBytes + shmBytes;

const phases = [
  { bytes: 5 * GB, phase: 'Phase 3', action: '多归档库 + 保留策略' },
  { bytes: 2 * GB, phase: 'Phase 2', action: 'term_bigrams + worker + 按月归档' },
  { bytes: 500 * MB, phase: 'Phase 1', action: 'term_stats + user_stats' },
];
const current = phases.find((p) => total >= p.bytes);
const next = [...phases].reverse().find((p) => total < p.bytes);

const result = {
  ok: dbBytes > 0,
  path: target,
  dbBytes,
  walBytes,
  shmBytes,
  totalBytes: total,
  totalMB: Number((total / MB).toFixed(1)),
  totalGB: Number((total / GB).toFixed(3)),
  phase: current ? current.phase : 'Phase 0',
  action: current ? current.action : '继续 A 方案；只监控',
  nextPhase: next ? next.phase : null,
  nextAtMB: next ? next.bytes / MB : null,
  remainingMB: next ? Number(((next.bytes - total) / MB).toFixed(1)) : 0,
  doc: 'docs\\数据量扩展方案.md',
};

if (JSON_OUT) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 2);
}

if (!result.ok) {
  console.error('找不到数据库：' + target);
  console.error('可用参数指定：node tools\\db-size.js <danmaku.db>');
  process.exit(2);
}

console.log(`数据库：${result.totalMB} MB（db ${(dbBytes / MB).toFixed(1)} + wal ${(walBytes / MB).toFixed(1)} + shm ${(shmBytes / MB).toFixed(1)}）`);
console.log(`当前档位：${result.phase} —— ${result.action}`);
if (next) {
  console.log(`距离 ${next.phase}（${next.bytes / MB} MB）还差 ${result.remainingMB} MB`);
} else {
  console.log('已经超过最高档位，按 docs\\数据量扩展方案.md 做归档/保留策略。');
}
console.log('方案：' + result.doc);