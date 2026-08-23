@echo off
title Landslide Local - verify
cd /d "%~dp0"
echo.
node scripts\preflight.mjs
node scripts\verify-live.mjs
echo.
pause
