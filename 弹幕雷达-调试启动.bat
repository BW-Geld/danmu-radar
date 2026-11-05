@echo off
cd /d "%~dp0"
title Danmu Radar - debug console

echo.
echo   Debug console - only for troubleshooting.
echo   Normal use: double-click the .vbs launcher in this folder (no window at all)
echo.
echo   UI       : http://127.0.0.1:7788
echo   Log copy : data\server.log
echo   Closing this window stops the program.
echo.

set NODE_EXE=%~dp0runtime
ode.exe
if not exist "%NODE_EXE%" set NODE_EXE=%~dp0node.exe
if not exist "%NODE_EXE%" (
  echo   [!] runtime
ode.exe is missing - the zip is incomplete, please unzip again.
  pause
  exit /b 1
)

set DANMU_OPEN=1
set NODE_NO_WARNINGS=1
"%NODE_EXE%" --disable-warning=ExperimentalWarning "%~dp0server\index.js"

echo.
echo   Exited. Press any key to close this window.
pause >nul
