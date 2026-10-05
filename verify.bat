@echo off
REM ===========================================================================
REM  Run the full verification suite. Pure ASCII - see the note in start.bat.
REM
REM    verify.bat            engine + integration + balance
REM    verify.bat --browser  also drive a real browser (needs Chrome/Edge)
REM ===========================================================================

setlocal
chcp 65001 >nul 2>&1
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo   [ERROR] Node.js not found on PATH.
  pause
  exit /b 1
)

set FAILED=0

echo.
echo   ============================================================
echo    Starfall Chronicle - verification
echo   ============================================================
echo.

echo   [1/4] Engine self-check ...
node test\run-all.js
if errorlevel 1 set FAILED=1

echo.
echo   [2/4] HTTP integration ...
node test\integration.js
if errorlevel 1 set FAILED=1

echo.
echo   [3/4] Balance harness ...
node test\balance.js --runs 60
if errorlevel 1 set FAILED=1

if /i "%~1"=="--browser" (
  echo.
  echo   [4/4] Browser smoke test ...
  node test\browser.js
  if errorlevel 1 set FAILED=1
) else (
  echo.
  echo   [4/4] Browser smoke test ... skipped
  echo         Run "verify.bat --browser" to include it.
)

echo.
if "%FAILED%"=="1" (
  echo   RESULT: some checks FAILED.
) else (
  echo   RESULT: all checks passed.
)
echo.
pause

endlocal
exit /b %FAILED%
