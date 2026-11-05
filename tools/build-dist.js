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

const README = `弹幕雷达 · 斗鱼弹幕统计（便携版）
================================

怎么用
------
1. 把整个文件夹（或解压出来的文件夹）放在一个你找得到的地方，比如 D:\\弹幕雷达。
2. 双击 弹幕雷达启动程序.vbs —— 不会有黑色命令行窗口，程序在后台跑。
   （弹幕雷达-调试启动.bat 是带窗口的调试版，只在启动不起来时用来看看报错。）
3. 等一两秒，会弹出一个窗口（没有地址栏，像软件一样）。
   如果没弹出来，手动打开浏览器访问 http://127.0.0.1:7788
4. 在左侧输入直播间号（例如 6657）点「添加」，弹幕就开始实时入库了。

不需要安装 Node.js，也不需要联网登录任何账号。

文件夹里都是什么
----------------
弹幕雷达启动程序.vbs   日常用这个（双击，无黑框）
在桌面创建快捷方式.vbs   双击一次，桌面就多一个带图标的「弹幕雷达」，以后点桌面那个
assets\\danmu-radar.ico   上面那个快捷方式用的图标（不用管）
弹幕雷达-调试启动.bat   出问题时用这个（有窗口，能看到报错）
runtime\\node.exe     程序引擎（Node.js），不用管它，别双击
server\\ web\\ shared\\  程序本体
data\\                你的弹幕库和设置
使用说明.txt          就是这份说明

怎么退出
--------
· 关掉那个独立窗口就行（默认会缩到右下角托盘继续采集）
· 托盘图标右键 →「停止采集并退出」
· 界面里 设置 → 界面与退出 →「停止采集并退出」

日志
----
弹幕雷达启动程序.vbs 启动时，程序的输出写在 data\\server.log（超过 5MB 会自动改成 server.log.1）。
启动不起来时先看这个文件。

界面选择
--------
设置 → 界面与退出：
  · 独立窗口：没有地址栏和标签页，任务栏里是自己的图标
  · 浏览器标签：用你平时的浏览器打开这个地址
  · 关窗口时：缩小到系统托盘（采集继续）/ 停止采集（宽限期后退出）
    （宽限秒数是给「误关 / 刷新页面」留的余地，这段时间内重新打开就继续采集）

数据在哪
--------
data\\danmaku.db       全部弹幕（SQLite，单文件）
data\\soak.log         挂机采样日志（有的话）
data\\lexicon.json     自定义词表（可选，自己建）

备份：关掉程序，把 data\\danmaku.db 复制走就是完整备份。
换电脑：复制整个文件夹，连带 data 目录一起。

注意
----
· 关掉黑色控制台窗口 = 停止程序，会先把缓冲里的弹幕落盘。
· 弹幕只有程序运行期间才采集，斗鱼不提供历史弹幕接口。
· 端口被占用时程序会提示，并尝试直接打开已在运行的那个实例。
· 想换端口：双击 弹幕雷达-调试启动.bat（调试版），在 node.exe 那一行前面加一行 set DANMU_PORT=7890
  （启动程序不读这个，改了端口后用浏览器访问 http://127.0.0.1:7890 即可）

卸载
----
删掉整个文件夹即可。没有注册表、没有系统服务、没有开机启动项。
`;

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
  fs.mkdirSync(path.join(OUT, 'tools'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'tools', 'tray.ps1'), path.join(OUT, 'tools', 'tray.ps1'));

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
  const target = path.join(DIST, `${NAME}.zip`);
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
