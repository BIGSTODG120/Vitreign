@echo off
setlocal
title Vitreign
cd /d "%~dp0"
where node.exe >nul 2>&1
if errorlevel 1 (
    echo Install Node.js 24.16 or newer from https://nodejs.org/ and reopen this launcher.
    pause
    exit /b 1
)
node -e "const [major,minor]=process.versions.node.split('.').map(Number); process.exit(major>24 || major===24 && minor>=16 ? 0 : 1)"
if errorlevel 1 (
    echo Upgrade Node.js to 24.16 or newer, then reopen this launcher.
    pause
    exit /b 1
)
node src/start.mjs --launch
if errorlevel 1 pause
