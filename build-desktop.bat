@echo off
REM ===========================================================================
REM  Starfall Chronicle - build the native window launcher
REM ===========================================================================
REM
REM  This file is deliberately PURE ASCII (see start.bat for why).
REM
REM  Compiles desktop\Launcher.cs into desktop\bin\StarfallChronicle.exe using
REM  the C# compiler that already ships with Windows. No .NET SDK, no Visual
REM  Studio, no NuGet restore, no internet access required.
REM
REM  The WebView2 managed assemblies are vendored in desktop\webview2-sdk\ and
REM  are copied next to the executable, because the .NET Framework loader
REM  resolves assemblies by name from the application directory.
REM
REM  Output:
REM    desktop\bin\StarfallChronicle.exe
REM    desktop\bin\Microsoft.Web.WebView2.Core.dll
REM    desktop\bin\Microsoft.Web.WebView2.WinForms.dll
REM    desktop\bin\WebView2Loader.dll
REM ===========================================================================

setlocal enabledelayedexpansion
chcp 65001 >nul 2>&1

cd /d "%~dp0"

set "SRC=%~dp0desktop\Launcher.cs"
set "SDK=%~dp0desktop\webview2-sdk"
set "OUT=%~dp0desktop\bin"

echo.
echo   Starfall Chronicle - desktop build
echo   ---------------------------------

if not exist "%SRC%" (
  echo   [ERROR] Missing %SRC%
  exit /b 1
)

REM --- locate a C# compiler ------------------------------------------------
REM  Prefer the 64-bit framework compiler, fall back to the 32-bit one, then
REM  to whatever is on PATH.
set "CSC="
if exist "%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe" set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not defined CSC if exist "%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe" set "CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if not defined CSC for /f "delims=" %%i in ('where csc 2^>nul') do if not defined CSC set "CSC=%%i"

if not defined CSC (
  echo   [ERROR] csc.exe not found.
  echo           Expected at %%WINDIR%%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
  echo           Install .NET Framework 4.x, or keep using start.bat without
  echo           the native window.
  exit /b 1
)
echo   compiler : %CSC%

REM --- verify the vendored SDK ---------------------------------------------
if not exist "%SDK%\Microsoft.Web.WebView2.Core.dll" (
  echo   [ERROR] Missing WebView2 SDK in %SDK%
  exit /b 1
)
if not exist "%SDK%\Microsoft.Web.WebView2.WinForms.dll" (
  echo   [ERROR] Missing WebView2 SDK in %SDK%
  exit /b 1
)
if not exist "%SDK%\WebView2Loader.dll" (
  echo   [ERROR] Missing WebView2 SDK in %SDK%
  exit /b 1
)

if not exist "%OUT%" mkdir "%OUT%"

REM --- compile -------------------------------------------------------------
echo   output   : %OUT%\StarfallChronicle.exe
echo.

"%CSC%" /nologo /target:winexe /platform:x64 /optimize+ /warn:4 ^
  /out:"%OUT%\StarfallChronicle.exe" ^
  /reference:System.dll ^
  /reference:System.Drawing.dll ^
  /reference:System.Windows.Forms.dll ^
  /reference:"%SDK%\Microsoft.Web.WebView2.Core.dll" ^
  /reference:"%SDK%\Microsoft.Web.WebView2.WinForms.dll" ^
  "%SRC%"

if errorlevel 1 (
  echo.
  echo   [ERROR] Compilation failed.
  exit /b 1
)

REM --- stage runtime dependencies ------------------------------------------
copy /y "%SDK%\Microsoft.Web.WebView2.Core.dll" "%OUT%\" >nul
copy /y "%SDK%\Microsoft.Web.WebView2.WinForms.dll" "%OUT%\" >nul
copy /y "%SDK%\WebView2Loader.dll" "%OUT%\" >nul

echo.
echo   Build OK.
echo   Run:  start.bat          (uses the native window automatically)
echo         desktop\bin\StarfallChronicle.exe --port 9000
echo.

endlocal
exit /b 0
