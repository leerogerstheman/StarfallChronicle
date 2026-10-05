@echo off
REM ===========================================================================
REM  星陨纪年 / Starfall Chronicle - launcher
REM ===========================================================================
REM
REM  This file is deliberately PURE ASCII.
REM
REM  cmd.exe reads a .bat using the *active* console code page. Switching the
REM  code page (chcp 65001) inside a batch file that also contains non-ASCII
REM  bytes corrupts cmd's read offset, and it starts executing fragments of its
REM  own text. So: switch the code page FIRST, then hand off to Node, which
REM  prints the Chinese banner as UTF-8. All the Chinese lives in JS, never here.
REM
REM  Usage:
REM    start.bat              start on the default port (8787)
REM    set PORT=9000 & start.bat
REM    start.bat --open       also open the default browser
REM ===========================================================================

setlocal
chcp 65001 >nul 2>&1

cd /d "%~dp0"

if "%PORT%"=="" set PORT=8787
if /i "%~1"=="--open" set STARFALL_OPEN=1

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   [ERROR] Node.js not found on PATH.
  echo   Install Node 22 or newer from https://nodejs.org/
  echo.
  pause
  exit /b 1
)

echo.
echo   Starting Starfall Chronicle on port %PORT% ...
echo.

node src\server.js
set EXITCODE=%ERRORLEVEL%

if not "%EXITCODE%"=="0" (
  echo.
  echo   Server exited with code %EXITCODE%.
  echo.
  pause
)

endlocal
exit /b %EXITCODE%
