@echo off
rem Chat room server launcher for Windows. Double-click this file to start.
rem To change settings, copy config.example.env to config.env and edit it. Press Ctrl+C in this window to stop.
rem NOTE: keep this file ASCII-only. cmd mis-parses UTF-8 multibyte text in batch files (lines get dropped),
rem       so every Korean message lives in start-messages\*.txt and is printed with "type".
setlocal
chcp 65001 >nul
title SiruGC Chat Server
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  type "%~dp0start-messages\no-node.txt"
  pause
  exit /b 1
)

node -e "process.exit(+process.versions.node.split('.')[0] >= 18 ? 0 : 1)"
if errorlevel 1 (
  type "%~dp0start-messages\old-node.txt"
  node -v
  pause
  exit /b 1
)

rem Install dependencies only the first time or after package-lock.json changed (exit code 1 = install needed).
node -e "const f=require('fs');try{process.exit(f.statSync('package-lock.json').mtimeMs>f.statSync('node_modules/.package-lock.json').mtimeMs?1:0)}catch(e){process.exit(1)}"
if errorlevel 1 (
  type "%~dp0start-messages\installing.txt"
  call npm install --omit=dev --no-audit --no-fund --loglevel=error
  if errorlevel 1 (
    type "%~dp0start-messages\install-failed.txt"
    pause
    exit /b 1
  )
)

if not exist config.env type "%~dp0start-messages\no-config.txt"
node server.js

echo.
echo Exit code: %errorlevel%
type "%~dp0start-messages\stopped.txt"
pause
