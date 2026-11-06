'use strict';

/**
 * 打包便携版：node.exe + 代码 + 启动脚本 + 说明，解压即用，不用装 Node。
 *
 *   node tools/build-dist.js            生成 dist/弹幕雷达-便携版/
 *   node tools/build-dist.js --zip      再压成 zip
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const NAME = '弹幕雷达-便携版';
const OUT = path.join(DIST, NAME);

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

function build() {
  // 便携版里的 data/ 是用户的库和设置，重打不能连它一起删：
  // 先把整个 data 目录挪走，构建完再放回去（找不到就当没有）。
  const dataDir = path.join(OUT, 'data');
  const rescue = path.join(ROOT, '.dist-data-rescue');
  let hadData = false;
  try {
    if (fs.existsSync(dataDir)) {
      fs.rmSync(rescue, { recursive: true, force: true });
      fs.renameSync(dataDir, rescue);
      hadData = true;
    }
  } catch (err) {
    console.log(`  [!] 没法暂存 dist\\data（${err.message}），这次跳过保留`);
  }

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  // 引擎单独放 runtime\，根目录只留用户该点的东西（避免有人去双击 node.exe）
  const nodeExe = process.execPath;
  fs.mkdirSync(path.join(OUT, 'runtime'), { recursive: true });
  fs.copyFileSync(nodeExe, path.join(OUT, 'runtime', 'node.exe'));

  copyDir(path.join(ROOT, 'server'), path.join(OUT, 'server'));
  copyDir(path.join(ROOT, 'web'), path.join(OUT, 'web'));
  copyDir(path.join(ROOT, 'shared'), path.join(OUT, 'shared'));

  // 托盘脚本要跟着走，否则便携版里「缩到系统托盘」用不了
  // focus.ps1 同理：开窗口前要靠它把已有窗口提到前台
  fs.mkdirSync(path.join(OUT, 'tools'), { recursive: true });
  for (const f of ['tray.ps1', 'focus.ps1']) {
    fs.copyFileSync(path.join(ROOT, 'tools', f), path.join(OUT, 'tools', f));
  }

  const dataOut = path.join(OUT, 'data');
  fs.mkdirSync(dataOut, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'data', '.keep'), '');

  // 把用户的库和设置放回去（有的话）
  if (hadData) {
    try {
      for (const e of fs.readdirSync(rescue, { withFileTypes: true })) {
        const from = path.join(rescue, e.name);
        const to = path.join(dataOut, e.name);
        if (e.isDirectory()) fs.cpSync(from, to, { recursive: true });
        else fs.copyFileSync(from, to);
      }
      fs.rmSync(rescue, { recursive: true, force: true });
      console.log('  已保留便携版里的 data/（数据库与设置没被覆盖）');
    } catch (err) {
      console.log(`  [!] 恢复 dist\\data 失败：${err.message}（备份还在 ${rescue}）`);
    }
  }

  writeCRLF(path.join(OUT, '弹幕雷达-调试启动.bat'), START_BAT);
  // 无窗口启动器：直接用仓库里的那份（UTF-16LE，wscript 才认得中文）
  fs.copyFileSync(path.join(ROOT, '弹幕雷达启动程序.vbs'), path.join(OUT, '弹幕雷达启动程序.vbs'));
  // 图标 + 「在桌面创建快捷方式」（.vbs 本身换不了图标，只能靠快捷方式）
  // 图标收进 assets\：它是被引用的素材，不该占着根目录；ASCII 名字也更稳
  fs.mkdirSync(path.join(OUT, 'assets'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'assets', 'danmu-radar.ico'), path.join(OUT, 'assets', 'danmu-radar.ico'));
  fs.copyFileSync(
    path.join(ROOT, '在桌面创建快捷方式.vbs'),
    path.join(OUT, '在桌面创建快捷方式.vbs')
  );
  writeCRLF(path.join(OUT, '使用说明.txt'), README);

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
  })(OUT);

  console.log(`已生成 ${OUT}`);
  console.log(`  ${files} 个文件，${(bytes / 1048576).toFixed(1)} MB`);
  return OUT;
}

function zip(dir) {
  // zip 的名字必须全 ASCII：GitHub 上传附件时会把文件名里的非 ASCII 字符直接删掉，
  // 「弹幕雷达-便携版.zip」会变成「-.zip」，所以包名用英文，中文写在 Release 标题里。
  const target = path.join(DIST, 'danmu-radar-portable.zip');
  fs.rmSync(target, { force: true });
  execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Compress-Archive -Path "${dir}" -DestinationPath "${target}" -CompressionLevel Optimal`,
    ],
    { stdio: 'inherit' }
  );
  const mb = (fs.statSync(target).size / 1048576).toFixed(1);
  console.log(`已压缩 ${target}（${mb} MB）`);
  return target;
}

const out = build();
if (process.argv.includes('--zip')) zip(out);
