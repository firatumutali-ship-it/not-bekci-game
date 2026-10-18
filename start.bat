@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js kurulu degil. https://nodejs.org adresinden kur, sonra tekrar calistir. & pause & exit /b 1)
if not exist node_modules call npm install
if "%OWNER_KEY%"=="" echo [bilgi] OWNER_KEY ayarli degil; sunucu rastgele bir anahtar uretip asagida yazacak.
start "" http://localhost:3000
node server.js
pause
