@echo off
chcp 65001 >nul 2>&1
title BiliTracker

echo.
echo  BiliTracker - Start
echo  ====================
echo.

set SCRIPT_DIR=%~dp0
set SERVER_DIR=%SCRIPT_DIR%server

REM check python
python --version >nul 2>&1
if errorlevel 1 (
    echo  [!] Python not found. Please install Python 3.10+
    echo      https://www.python.org/downloads/
    pause
    exit /b 1
)

REM install deps
echo  [1/3] Installing dependencies...
pip install fastapi uvicorn "httpx[socks]" -q 2>nul
echo  [OK] Dependencies ready

REM register autostart
echo  [2/3] Setting up autostart...

(
echo Set WshShell = CreateObject^("WScript.Shell"^)
echo WshShell.Run "cmd /c cd /d %SERVER_DIR% && python server.py", 0, False
) > "%SCRIPT_DIR%start_silent.vbs"

set STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
copy /y "%SCRIPT_DIR%start_silent.vbs" "%STARTUP%\BiliTracker.vbs" >nul 2>&1
if errorlevel 1 (
    schtasks /create /tn "BiliTracker" /tr "\"%SCRIPT_DIR%start_silent.vbs\"" /sc onlogon /rl highest /f >nul 2>&1
)
echo  [OK] Autostart configured

REM start server
echo  [3/3] Starting server...
echo.
echo  ----------------------------------------
echo   Chrome Extension (first time only):
echo   1. Open chrome://extensions/
echo   2. Enable Developer Mode
echo   3. Load unpacked -^> select extension folder
echo  ----------------------------------------
echo.

cd /d "%SERVER_DIR%"
python server.py

echo.
echo  Server stopped. Press any key to exit.
pause >nul
