'use strict';

/** 静态一致性检查：app.js 里引用的 DOM id 必须都在 index.html 中存在。 */

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', 'web');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');

const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const refs = new Set([...js.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]));

// 有些 id 是运行时赋上去的（`b.id = 'u-follow'`），HTML 里本来就没有。
// 只看「是不是在 app.js 里被赋过值」，赋过就算存在——不然会误报，还会诱导人往 HTML 里塞重复 id。
const dynamic = new Set([...js.matchAll(/\.id\s*=\s*'([A-Za-z0-9_-]+)'/g)].map((m) => m[1]));

const missing = [...refs].filter((r) => !ids.has(r) && !dynamic.has(r));
console.log(
  `index.html 元素 id ${ids.size} 个，app.js 引用 ${refs.size} 个，运行时赋值 ${dynamic.size} 个${
    dynamic.size ? `（${[...dynamic].join(', ')}）` : ''
  }`
);
if (missing.length) console.log('缺失：' + missing.join(', '));
else console.log('✓ 所有引用都能在 HTML 中找到');

// class 抽查：app.js 里用到的关键 class 是否在 CSS 中定义
const classes = ['tag', 'result', 'empty', 'stat', 'tab-panel', 'tabs', 'results', 'stream', 'profile'];
const missCss = classes.filter((c) => !new RegExp(`\\.${c}[\\s.,{:]`).test(css));
console.log(missCss.length ? '✗ CSS 缺 class：' + missCss.join(', ') : '✓ 关键 class 均有样式');

// 四个页签都必须有对应面板
const tabs = [...html.matchAll(/data-tab="([^"]+)"/g)].map((m) => m[1]);
const panels = [...html.matchAll(/id="tab-([a-z]+)"/g)].map((m) => m[1]);
console.log(`页签 ${tabs.join('/')} ↔ 面板 ${panels.join('/')}`);
const bad = tabs.filter((t) => !panels.includes(t));
console.log(bad.length ? '✗ 页签缺面板：' + bad.join(', ') : '✓ 页签与面板一一对应');

process.exit(missing.length || bad.length || missCss.length ? 1 : 0);
