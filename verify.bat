@echo off
REM ===========================================================================
REM  Run the full verification suite. Pure ASCII - see the note in start.bat.
REM
REM    verify.bat            engine + integration + art + balance + desktop shell
REM    verify.bat --browser  also drive a real browser (needs Chrome/Edge)
REM    verify.bat --fast     skip the desktop shell test (it builds + opens
REM                          a real window, so it is the slow one)
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
set FAST=0
set BROWSER=0
REM  Guard the empty-argument case: "for %%a in () do" is a cmd syntax error.
if not "%~1"=="" for %%a in (%*) do (
  if /i "%%a"=="--browser" set BROWSER=1
  if /i "%%a"=="--fast" set FAST=1
)

echo.
echo   ============================================================
echo    Starfall Chronicle - verification
echo   ============================================================
echo.

echo   [1/6] Engine self-check ...
node test\run-all.js
if errorlevel 1 set FAILED=1

echo.
echo   [2/6] HTTP integration ...
node test\integration.js
if errorlevel 1 set FAILED=1

echo.
echo   [3/6] Generated art ...
node test\art.js
if errorlevel 1 set FAILED=1

echo.
echo   [4/6] Balance harness ...
node test\balance.js --runs 60
if errorlevel 1 set FAILED=1

if "%FAST%"=="1" (
  echo.
  echo   [5/6] Desktop shell ... skipped, --fast
) else (
  echo.
  echo   [5/6] Desktop shell - build + native window ...
  node test\desktop.js
  if errorlevel 1 set FAILED=1
)

if "%BROWSER%"=="1" (
  echo.
  echo   [6/6] Browser smoke test ...
  node test\browser.js
  if errorlevel 1 set FAILED=1
) else (
  echo.
  echo   [6/6] Browser smoke test ... skipped
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
