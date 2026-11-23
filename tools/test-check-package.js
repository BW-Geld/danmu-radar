'use strict';

/**
 * 验证 tools\check-package.js 本身：
 *   - 干净包必须通过；
 *   - 带 danmaku.db 的包必须失败；
 *   - 带 chrome-profile 的包必须失败；
 *   - 缺必需文件的包必须失败；
 *   - 没有顶层目录的包必须失败；
 *   - 如果 dist 里有当前版本包，顺便验收它。
 *
 *   node tools\test-check-package.js
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const CHECKER = path.join(__dirname, 'check-package.js');
const TMP = path.join(ROOT, '.tmp', 'check-package-fixtures');
const TOP = '弹幕雷达-便携版';
const VERSION = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim();
const ACTUAL_ZIP = path.join(ROOT, 'dist', `danmu-radar-portable-v${VERSION}.zip`);

function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function write(rel, content = 'fixture') {
  const p = path.join(TMP, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function makeGoodPkg(caseName) {
  const base = path.join(TMP, caseName, TOP);
  fs.rmSync(path.join(TMP, caseName), { recursive: true, force: true });
  fs.mkdirSync(base, { recursive: true });
  const files = [
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
  ];
  for (const f of files) {
    const p = path.join(base, f);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'fixture');
  }
  const keep = path.join(base, 'data', '.keep');
  fs.mkdirSync(path.dirname(keep), { recursive: true });
  fs.writeFileSync(keep, '');
  return base;
}

function zipDir(srcDir, zipPath, includeBase) {
  fs.rmSync(zipPath, { force: true });
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  const script = [
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    `[IO.Compression.ZipFile]::CreateFromDirectory(${psQuote(srcDir)}, ${psQuote(zipPath)}, [IO.Compression.CompressionLevel]::Optimal, ${includeBase ? '$true' : '$false'})`,
  ].join('; ');
  execFileSync('powershell', ['-NoProfile', '-Command', script], { stdio: 'ignore' });
}

function runChecker(zipPath) {
  const r = spawnSync(process.execPath, [CHECKER, zipPath], { stdio: 'ignore' });
  return { status: r.status, signal: r.signal, error: r.error };
}

function expect(name, zipPath, wantPass) {
  const r = runChecker(zipPath);
  const passed = r.status === 0;
  const ok = passed === wantPass;
  console.log(`${ok ? '✓' : '✗'} ${name}：${passed ? '通过' : '拒绝'}（期望${wantPass ? '通过' : '拒绝'}）`);
  if (!ok) console.log(`    status=${r.status} signal=${r.signal || ''} error=${r.error ? r.error.message : ''}`);
  return ok;
}

function main() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  let allOk = true;
  try {
    const goodPkg = makeGoodPkg('good');
    const goodZip = path.join(TMP, 'good.zip');
    zipDir(goodPkg, goodZip, true);
    allOk = expect('干净包', goodZip, true) && allOk;

    const dbPkg = makeGoodPkg('db');
    fs.writeFileSync(path.join(dbPkg, 'data', 'danmaku.db'), 'not a real db');
    const dbZip = path.join(TMP, 'db.zip');
    zipDir(dbPkg, dbZip, true);
    allOk = expect('带 danmaku.db', dbZip, false) && allOk;

    const chromePkg = makeGoodPkg('chrome');
    fs.mkdirSync(path.join(chromePkg, 'chrome-profile', 'Default'), { recursive: true });
    fs.writeFileSync(path.join(chromePkg, 'chrome-profile', 'Default', 'Cookies'), 'x');
    const chromeZip = path.join(TMP, 'chrome.zip');
    zipDir(chromePkg, chromeZip, true);
    allOk = expect('带 chrome-profile', chromeZip, false) && allOk;

    const missingPkg = makeGoodPkg('missing');
    fs.rmSync(path.join(missingPkg, 'shared', 'copy.js'));
    const missingZip = path.join(TMP, 'missing.zip');
    zipDir(missingPkg, missingZip, true);
    allOk = expect('缺 shared/copy.js', missingZip, false) && allOk;

    const noTopPkg = makeGoodPkg('no-top');
    const noTopZip = path.join(TMP, 'no-top.zip');
    zipDir(noTopPkg, noTopZip, false);
    allOk = expect('没有顶层目录', noTopZip, false) && allOk;

    if (fs.existsSync(ACTUAL_ZIP)) {
      allOk = expect(`当前发布包 ${path.basename(ACTUAL_ZIP)}`, ACTUAL_ZIP, true) && allOk;
    } else {
      console.log(`- 跳过当前发布包：${ACTUAL_ZIP} 不存在`);
    }
  } finally {
    fs.rmSync(TMP, { recursive: true, force: true });
  }
  if (!allOk) {
    console.error('检查器自测失败：坏包能通过，或好包被拒绝');
    process.exitCode = 1;
  } else {
    console.log('检查器自测全部通过');
  }
}

main();