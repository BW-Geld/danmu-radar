'use strict';

/**
 * 打包便携版：node.exe + 代码 + 启动脚本 + 说明，解压即用，不用装 Node。
 *
 *   node tools/build-dist.js --stage    只生成 .tmp/build-v<版本>/ 里的 staging
 *   node tools/build-dist.js            生成 staging 并同步 dist/弹幕雷达-便携版/
 *   node tools/build-dist.js --zip      同步后再压成 dist/danmu-radar-portable-v<版本>.zip
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const NAME = '弹幕雷达-便携版';
const OUT = path.join(DIST, NAME);

// 版本号只维护这一处：打包、归档、发布都从 VERSION 读，避免文件名和文档各写一份。
const VERSION_FILE = path.join(ROOT, 'VERSION');
if (!fs.existsSync(VERSION_FILE)) {
  throw new Error('找不到 VERSION 文件（项目根目录，内容形如 0.3.1）');
}
const VERSION = fs.readFileSync(VERSION_FILE, 'utf8').trim();
if (!/^\d+\.\d+\.\d+$/.test(VERSION)) {
  throw new Error(`VERSION 内容不合法：${VERSION}（应形如 0.3.1）`);
}
const ZIP_NAME = `danmu-radar-portable-v${VERSION}.zip`;
// 构建先在 .tmp 里从零组装，绝不碰 dist 里的 live data。
const STAGE_ROOT = path.join(ROOT, '.tmp', `build-v${VERSION}`);
const STAGE_PKG = path.join(STAGE_ROOT, NAME);
const CHECKER = path.join(ROOT, 'tools', 'check-package.js');

const START_BAT = `@echo off
cd /d "%~dp0"
title Danmu Radar - debug console

echo.
echo   Debug console - only for troubleshooting.
echo   Normal use: double-click the .vbs launcher in this folder (no window at all)
echo.
echo   UI       : http://127.0.0.1:7788
echo   Log copy : data\\server.log
echo   Closing this window stops the program.
echo.

set NODE_EXE=%~dp0runtime\node.exe
if not exist "%NODE_EXE%" set NODE_EXE=%~dp0node.exe
if not exist "%NODE_EXE%" (
  echo   [!] runtime\node.exe is missing - the zip is incomplete, please unzip again.
  pause
  exit /b 1
)

set DANMU_OPEN=1
set NODE_NO_WARNINGS=1
"%NODE_EXE%" --disable-warning=ExperimentalWarning "%~dp0server\\index.js"

echo.
echo   Exited. Press any key to close this window.
pause >nul
`;

// 使用说明直接用仓库根目录的 README.md：两边只留一份文案，不会再出现「改了 README
// 忘了改包里说明」的情况（写出去时转成 CRLF + BOM，记事本打开不乱码）。
const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');

function copyDir(from, to, filter) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (filter && !filter(e.name)) continue;
    const s = path.join(from, e.name);
    const d = path.join(to, e.name);
    if (e.isDirectory()) copyDir(s, d, filter);
    else fs.copyFileSync(s, d);
  }
}

function writeCRLF(file, text) {
  // cmd.exe 只认 CRLF，写成 LF 会把整行切碎；BOM 保证中文不乱码
  const body = text.replace(/\r?\n/g, '\r\n');
  fs.writeFileSync(file, '\uFEFF' + body, 'utf8');
}

function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function build() {
  // 从零建 staging：只放源码、运行时和空 data/.keep。
  // 不碰 dist\弹幕雷达-便携版\data，所以 7788 在跑也能安全组装。
  fs.rmSync(STAGE_ROOT, { recursive: true, force: true });
  fs.mkdirSync(STAGE_PKG, { recursive: true });

  // 引擎单独放 runtime\，根目录只留用户该点的东西（避免有人去双击 node.exe）
  const nodeExe = process.execPath;
  fs.mkdirSync(path.join(STAGE_PKG, 'runtime'), { recursive: true });
  fs.copyFileSync(nodeExe, path.join(STAGE_PKG, 'runtime', 'node.exe'));

  copyDir(path.join(ROOT, 'server'), path.join(STAGE_PKG, 'server'));
  copyDir(path.join(ROOT, 'web'), path.join(STAGE_PKG, 'web'));
  copyDir(path.join(ROOT, 'shared'), path.join(STAGE_PKG, 'shared'));

  // 托盘脚本要跟着走，否则便携版里「缩到系统托盘」用不了
  // focus.ps1 同理：开窗口前要靠它把已有窗口提到前台
  fs.mkdirSync(path.join(STAGE_PKG, 'tools'), { recursive: true });
  for (const f of ['tray.ps1', 'focus.ps1']) {
    fs.copyFileSync(path.join(ROOT, 'tools', f), path.join(STAGE_PKG, 'tools', f));
  }

  fs.mkdirSync(path.join(STAGE_PKG, 'data'), { recursive: true });
  fs.writeFileSync(path.join(STAGE_PKG, 'data', '.keep'), '');

  writeCRLF(path.join(STAGE_PKG, '弹幕雷达-调试启动.bat'), START_BAT);
  // 无窗口启动器：直接用仓库里的那份（UTF-16LE，wscript 才认得中文）
  // 仓库根里那个 .vbs 是「开发用」的（跑源码、数据在仓库 data\）；
  // 便携版要的是自己那份启动器，内容由 tools\launcher-portable.vbs 维护。
  const LAUNCHER_SRC = path.join(ROOT, 'tools', 'launcher-portable.vbs');
  if (fs.existsSync(LAUNCHER_SRC)) {
    fs.copyFileSync(LAUNCHER_SRC, path.join(STAGE_PKG, '弹幕雷达启动程序.vbs'));
  } else {
    const dev = path.join(ROOT, '开发用-启动源码版.vbs');
    if (!fs.existsSync(dev)) throw new Error('找不到启动器源文件（tools\\launcher-portable.vbs 或 开发用-启动源码版.vbs）');
    fs.copyFileSync(dev, path.join(STAGE_PKG, '弹幕雷达启动程序.vbs'));
  }
  // 图标 + 「在桌面创建快捷方式」（.vbs 本身换不了图标，只能靠快捷方式）
  // 图标收进 assets\：它是被引用的素材，不该占着根目录；ASCII 名字也更稳
  fs.mkdirSync(path.join(STAGE_PKG, 'assets'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'assets', 'danmu-radar.ico'), path.join(STAGE_PKG, 'assets', 'danmu-radar.ico'));
  fs.copyFileSync(
    path.join(ROOT, '在桌面创建快捷方式.vbs'),
    path.join(STAGE_PKG, '在桌面创建快捷方式.vbs')
  );
  writeCRLF(path.join(STAGE_PKG, '使用说明.txt'), README);

  let files = 0;
  let bytes = 0;
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else {
        files++;
        bytes += fs.statSync(p).size;
      }
    }
  })(STAGE_PKG);

  console.log(`已生成 staging ${STAGE_PKG}`);
  console.log(`  ${files} 个文件，${(bytes / 1048576).toFixed(1)} MB；data/ 只有 .keep`);
  return STAGE_ROOT;
}

function syncToDist(stageRoot) {
  const pkg = path.join(stageRoot, NAME);
  fs.mkdirSync(OUT, { recursive: true });

  // 只替换受管理的目录和根文件；data/ 原样留在 dist 里，绝不删除。
  for (const dir of ['server', 'web', 'shared', 'tools', 'assets', 'runtime']) {
    const from = path.join(pkg, dir);
    const to = path.join(OUT, dir);
    if (!fs.existsSync(from)) throw new Error(`staging 缺少 ${dir}/，拒绝同步 dist`);
    fs.rmSync(to, { recursive: true, force: true });
    copyDir(from, to);
  }
  for (const file of ['弹幕雷达-调试启动.bat', '弹幕雷达启动程序.vbs', '在桌面创建快捷方式.vbs', '使用说明.txt']) {
    fs.copyFileSync(path.join(pkg, file), path.join(OUT, file));
  }

  const data = path.join(OUT, 'data');
  fs.mkdirSync(data, { recursive: true });
  if (fs.readdirSync(data).length === 0) {
    fs.writeFileSync(path.join(data, '.keep'), '');
  }
  console.log(`已同步 ${OUT}（data/ 未动）`);
}

function archiveStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function archiveOldZips() {
  // dist 根目录只留最新包；旧包按原名进 archive，重名时加时间戳保留历史。
  const archive = path.join(DIST, 'archive');
  fs.mkdirSync(archive, { recursive: true });
  const stamp = archiveStamp();
  for (const name of fs.readdirSync(DIST)) {
    if (!/^danmu-radar-portable.*\.zip$/i.test(name)) continue;
    const src = path.join(DIST, name);
    if (!fs.statSync(src).isFile()) continue;
    let dest = path.join(archive, name);
    if (fs.existsSync(dest)) {
      dest = path.join(archive, `${path.basename(name, '.zip')}-${stamp}.zip`);
    }
    fs.renameSync(src, dest);
    console.log(`已归档旧包 ${name} -> ${dest}`);
  }
}

function zip(stageRoot) {
  // zip 的名字必须全 ASCII：GitHub 上传附件时会把文件名里的非 ASCII 字符直接删掉，
  // 「弹幕雷达-便携版.zip」会变成「-.zip」，所以包名用英文，中文写在 Release 标题里。
  const target = path.join(DIST, ZIP_NAME);
  const temp = path.join(ROOT, '.tmp', `${ZIP_NAME}.tmp`);
  fs.mkdirSync(path.dirname(temp), { recursive: true });
  fs.rmSync(temp, { force: true });

  // 从 staging 压，不碰 dist\data。.NET 的 includeBaseDirectory=true 保留顶层目录。
  const script = [
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    `[IO.Compression.ZipFile]::CreateFromDirectory(${psQuote(stageRoot)}, ${psQuote(temp)}, [IO.Compression.CompressionLevel]::Optimal, $true)`,
  ].join('; ');
  try {
    execFileSync('powershell', ['-NoProfile', '-Command', script], { stdio: 'inherit' });
    // 坏包在这里直接失败，绝不进入 dist。
    execFileSync(process.execPath, [CHECKER, temp], { stdio: 'inherit' });
    archiveOldZips();
    fs.rmSync(target, { force: true });
    fs.renameSync(temp, target);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw new Error(`zip 生成或检查失败，未写入 dist：${err.message}`);
  }

  const mb = (fs.statSync(target).size / 1048576).toFixed(1);
  console.log(`已压缩 ${target}（${mb} MB，v${VERSION}，已排除 data/）`);
  return target;
}

function main() {
  const stageRoot = build();
  if (process.argv.includes('--stage')) {
    console.log(`  --stage：只生成 staging，不同步 dist、不压缩`);
    return;
  }
  syncToDist(stageRoot);
  if (process.argv.includes('--zip')) zip(stageRoot);
}

main();
