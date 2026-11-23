'use strict';

/**
 * 发布包静态检查：不解压、不启动服务，只读 zip 的中央目录。
 *
 *   node tools/check-package.js dist\danmu-radar-portable-v0.4.0.zip
 *
 * 目的：在坏包进入 dist 之前失败。重点不是“文件齐不齐”，而是：
 *   - 只有一个顶层目录；
 *   - data\ 里只有空 .keep，绝不能带用户数据库/日志/浏览器 profile；
 *   - 运行必需的入口文件存在；
 *   - 没有绝对路径、..、重复 entry。
 *
 * 这是 build-dist.js 的闸门；测试见 tools\test-check-package.js。
 */

const fs = require('node:fs');
const path = require('node:path');

const EXPECTED_TOP = '弹幕雷达-便携版';

const REQUIRED = [
  'server/index.js',
  'web/index.html',
  'web/app.js',
  'web/style.css',
  'shared/copy.js',
  'runtime/node.exe',
  'tools/tray.ps1',
  'tools/focus.ps1',
  'assets/danmu-radar.ico',
  '弹幕雷达启动程序.vbs',
  '弹幕雷达-调试启动.bat',
  '使用说明.txt',
  'data/.keep',
];

const FORBIDDEN = [
  /\.db(-wal|-shm)?$/i,
  /\.log$/i,
  /(^|\/)chrome-profile(\/|$)/i,
  /(^|\/)node_modules(\/|$)/i,
  /(^|\/)\.git(\/|$)/i,
  /(^|\/)\.tmp(\/|$)/i,
  /(^|\/)\.bak[^/]*(\/|$)/i,
  /(^|\/)desktop\.ini$/i,
  /(^|\/)Thumbs\.db$/i,
];

const SOFT_MIN_BYTES = 20 * 1024 * 1024;
const SOFT_MAX_BYTES = 60 * 1024 * 1024;
const HARD_MAX_BYTES = 80 * 1024 * 1024;

function fail(message, errors) {
  errors.push(message);
}

function normalizeName(raw) {
  return String(raw).replace(/\\/g, '/').replace(/^\.\//, '');
}

function readCentralDirectory(buf) {
  const min = Math.max(0, buf.length - 65557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 zip：找不到 EOCD');

  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new Error('暂不支持 ZIP64（发布包不应超过 4GB）');
  }
  if (cdOffset + cdSize > buf.length) throw new Error('zip 中央目录越界');

  const entries = [];
  let off = cdOffset;
  for (let i = 0; i < total; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) {
      throw new Error(`zip 中央目录第 ${i + 1} 项损坏`);
    }
    const flags = buf.readUInt16LE(off + 8);
    const method = buf.readUInt16LE(off + 10);
    const compressedSize = buf.readUInt32LE(off + 20);
    const size = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const nameEnd = off + 46 + nameLen;
    if (nameEnd > buf.length) throw new Error('zip entry 名称越界');

    const rawName = buf.subarray(off + 46, nameEnd).toString('utf8');
    const name = normalizeName(rawName).replace(/\/+$/, '');
    entries.push({
      name,
      rawName,
      dir: /\/$/.test(rawName) || size === 0,
      size,
      compressedSize,
      method,
      flags,
      encrypted: Boolean(flags & 1),
    });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function checkZip(file) {
  const errors = [];
  const warnings = [];
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    return { ok: false, errors: [`打不开文件：${err.message}`], warnings, entries: [] };
  }
  if (!stat.isFile()) return { ok: false, errors: ['不是普通文件'], warnings, entries: [] };
  if (stat.size > HARD_MAX_BYTES) {
    errors.push(`zip 体积 ${(stat.size / 1048576).toFixed(1)} MB，超过硬上限 ${HARD_MAX_BYTES / 1048576} MB（疑似把 data 打进来了）`);
  } else if (stat.size < SOFT_MIN_BYTES || stat.size > SOFT_MAX_BYTES) {
    warnings.push(`zip 体积 ${(stat.size / 1048576).toFixed(1)} MB，超出常规 ${SOFT_MIN_BYTES / 1048576}-${SOFT_MAX_BYTES / 1048576} MB 范围`);
  }

  let entries;
  try {
    entries = readCentralDirectory(fs.readFileSync(file));
  } catch (err) {
    return { ok: false, errors: [err.message], warnings, entries: [] };
  }
  if (!entries.length) errors.push('zip 里没有任何 entry');

  const byName = new Map();
  for (const e of entries) {
    if (!e.name) {
      errors.push('存在空 entry 名');
      continue;
    }
    if (e.encrypted) errors.push(`${e.name} 被加密，发布包不应使用密码`);
    if (e.method !== 0 && e.method !== 8) errors.push(`${e.name} 使用了不支持的压缩方法 ${e.method}`);
    if (/^[A-Za-z]:/.test(e.name) || e.name.startsWith('/')) errors.push(`${e.name} 是绝对路径`);
    if (e.name.split('/').some((p) => p === '..')) errors.push(`${e.name} 含 .. 路径`);
    const key = e.name.toLowerCase();
    if (byName.has(key)) errors.push(`重复 entry：${e.name}`);
    byName.set(key, e);
  }

  const hasTop = entries.some((e) => e.name === EXPECTED_TOP || e.name.startsWith(`${EXPECTED_TOP}/`));
  if (!hasTop) {
    errors.push(`缺少顶层目录 ${EXPECTED_TOP}/（现有根 entry：${entries.filter((e) => e.name && !e.name.includes('/')).map((e) => e.name).join(', ') || '无'}）`);
  }
  for (const e of entries) {
    if (!e.name) continue;
    const first = e.name.split('/')[0];
    if (first !== EXPECTED_TOP) errors.push(`${e.name} 不在顶层目录 ${EXPECTED_TOP}/ 下`);
  }

  for (const e of entries) {
    if (!e.name) continue;
    const rel = e.name === EXPECTED_TOP ? '' : e.name.slice(EXPECTED_TOP.length + 1);
    if (!rel) continue;
    if (rel === 'data') continue;
    if (rel.startsWith('data/')) {
      if (rel !== 'data/.keep') errors.push(`data/ 里只能有 .keep，发现 ${rel}`);
      if (rel === 'data/.keep' && e.size !== 0) errors.push('data/.keep 必须是 0 字节');
      continue;
    }
    for (const re of FORBIDDEN) {
      if (re.test(rel)) errors.push(`禁止文件：${rel}`);
    }
  }

  for (const req of REQUIRED) {
    const found = byName.get(`${EXPECTED_TOP}/${req}`.toLowerCase());
    if (!found) errors.push(`缺少必需文件：${req}`);
    else if (req !== 'data/.keep' && found.size === 0) errors.push(`必需文件是空文件：${req}`);
  }

  if (entries.length < 20 || entries.length > 60) {
    warnings.push(`entry 数 ${entries.length}，超出常规 20-60（不单独判失败）`);
  }

  return {
    ok: errors.length === 0,
    errors: [...new Set(errors)],
    warnings: [...new Set(warnings)],
    entries,
    size: stat.size,
  };
}

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('用法：node tools\\check-package.js <zip 路径>');
    process.exitCode = 2;
    return;
  }
  const abs = path.resolve(file);
  const result = checkZip(abs);
  if (result.errors.length) {
    console.error(`✗ 包检查失败：${abs}`);
    for (const e of result.errors) console.error(`  - ${e}`);
  } else {
    console.log(`✓ 包检查通过：${abs}`);
    console.log(`  ${result.entries.length} 个 entry，${(result.size / 1048576).toFixed(1)} MB，顶层 ${EXPECTED_TOP}/，data/ 只有 .keep`);
  }
  for (const w of result.warnings) console.log(`  ! ${w}`);
  if (!result.ok) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { checkZip, EXPECTED_TOP, REQUIRED };