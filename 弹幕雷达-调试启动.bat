@echo off
cd /d "%~dp0"
title Danmu Radar - console mode (debug)

echo.
echo   Console mode, for troubleshooting only.
echo   Normal use: double-click  start.vbs  (no window at all)
echo.
echo   UI       : http://127.0.0.1:7788
echo   Log copy : data\server.log
echo   Closing this window stops the program.
echo.

set DANMU_OPEN=1
set NODE_NO_WARNINGS=1
node --disable-warning=ExperimentalWarning "%~dp0server\index.js"

echo.
echo   Exited. Press any key to close this window.
pause >nul
