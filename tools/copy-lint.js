'use strict';

/**
 * 文案检查（窄版）：
 *   A. 共享字典里的每个字符串都不得做心理归因（喜欢 / 偏好 / 感兴趣 / 最爱 / 热衷）；
 *   B. web/ 下的代码里也不许出现这些词——除非写在 shared/copy.js 里。
 *      （弹幕正文、证据句、用户输入都是数据，不扫。）
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const BANNED = ['喜欢', '偏好', '感兴趣', '最爱', '热衷'];

const problems = [];

function walkStrings(node, trail, fn) {
  if (typeof node === 'string') return fn(node, trail);
  if (Array.isArray(node)) return node.forEach((v, i) => walkStrings(v, `${trail}[${i}]`, fn));
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) walkStrings(v, `${trail}.${k}`, fn);
  }
}

const COPY = require(path.join(ROOT, 'shared', 'copy.js'));
walkStrings(COPY, 'COPY', (s, trail) => {
  for (const w of BANNED) {
    if (s.includes(w)) problems.push(`shared/copy.js ${trail} 含「${w}」：${s}`);
  }
});

// web/ 目录：只扫源码里的中文字面量，跳过 copy.js 本身（它就是要检查的字典）
const webDir = path.join(ROOT, 'web');
for (const f of fs.readdirSync(webDir)) {
  if (!/\.(js|html)$/.test(f)) continue;
  const full = path.join(webDir, f);
  const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    if (!/[\u4e00-\u9fff]/.test(line)) return;
    for (const w of BANNED) {
      if (!line.includes(w)) continue;
      // 允许显式豁免，但必须写理由（copy-ok: <reason>）
      if (/copy-ok:/.test(line)) return;
      problems.push(`web/${f}:${i + 1} 出现「${w}」，应放进 shared/copy.js：${line.trim().slice(0, 80)}`);
    }
  });
}

if (problems.length) {
  console.error(`文案检查未通过（${problems.length} 处）：`);
  for (const p of problems) console.error('  ✗ ' + p);
  process.exit(1);
}

const count = (function n(node) {
  if (typeof node === 'string') return 1;
  if (node && typeof node === 'object') return Object.values(node).reduce((a, v) => a + n(v), 0);
  return 0;
})(COPY);

console.log(`✓ 文案检查通过：字典 ${count} 条字符串，均无心理归因用词；web/ 无越界文案`);
