@echo off
REM ===========================================================================
REM  Starfall Chronicle - launcher
REM ===========================================================================
REM
REM  This file is deliberately PURE ASCII.
REM
REM  cmd.exe reads a .bat using the *active* console code page. Switching the
REM  code page (chcp 65001) inside a batch file that also contains non-ASCII
REM  bytes corrupts cmd's read offset, and it starts executing fragments of its
REM  own text. So: switch the code page FIRST, then hand off to another program,
REM  which prints the Chinese banner as UTF-8. All the Chinese lives in JS or in
REM  the compiled launcher, never here.
REM
REM  Default behaviour: open the game in its own native window (no browser).
REM  If the native launcher has not been built yet, this builds it on the spot
REM  using the C# compiler that ships with Windows, then runs it.
REM  If no C# compiler is available, it falls back to the console server, which
REM  prints a URL you can open in any browser.
REM
REM  Usage:
REM    start.bat                 native window on the default port (8787)
REM    start.bat --console       console server only (prints a URL)
REM    start.bat --port 9000     native window on another port
REM    set PORT=9000 ^& start.bat
REM ===========================================================================

setlocal enabledelayedexpansion
chcp 65001 >nul 2>&1

cd /d "%~dp0"

if "%PORT%"=="" set PORT=8787
set "MODE=window"
set "CONSOLE_OPEN="

:parse
if "%~1"=="" goto parsed
if /i "%~1"=="--console" set "MODE=console"
if /i "%~1"=="--no-window" set "MODE=console"
if /i "%~1"=="--open" set "CONSOLE_OPEN=1"
if /i "%~1"=="--port" (
  if not "%~2"=="" set "PORT=%~2"
  shift
)
shift
goto parse
:parsed

if /i "%MODE%"=="console" goto console

REM --- native window path ---------------------------------------------------
set "EXE=%~dp0desktop\bin\StarfallChronicle.exe"

if exist "%EXE%" goto runwindow

REM Not built yet: try to build it now, quietly.
set "HAVE_CSC="
if exist "%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe" set "HAVE_CSC=1"
if not defined HAVE_CSC if exist "%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe" set "HAVE_CSC=1"

if not defined HAVE_CSC goto console

echo.
echo   First run: building the native window launcher ...
call "%~dp0build-desktop.bat"
if errorlevel 1 (
  echo.
  echo   [WARN] Native build failed. Falling back to the console server.
  goto console
)

:runwindow
echo.
echo   Starfall Chronicle is opening in its own window ...
echo.
"%EXE%" --port %PORT%
set EXITCODE=%ERRORLEVEL%
REM  Keep endlocal and exit on ONE line: the whole line is expanded before it
REM  runs, so %EXITCODE% is read while it still exists. Split across two lines
REM  it would expand to nothing after endlocal discarded it.
endlocal & exit /b %EXITCODE%

REM --- console path ---------------------------------------------------------
:console
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

if defined CONSOLE_OPEN set STARFALL_OPEN=1

node src\server.js
set EXITCODE=%ERRORLEVEL%

if not "%EXITCODE%"=="0" (
  echo.
  echo   Server exited with code %EXITCODE%.
  echo.
  pause
)

endlocal & exit /b %EXITCODE%