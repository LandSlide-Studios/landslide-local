@echo off
title Landslide Local
cd /d "%~dp0"
echo.
echo   Landslide Local — starting...
echo.
node scripts\preflight.mjs
node src\server.js
pause
