@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist node_modules (echo Kurulum yapiliyor... & call npm install)
start "NOBETCI SUNUCU" cmd /k "npm start"
timeout /t 3 >nul
echo.
echo ===== ARKADASLARINA GONDERECEGIN ADRES asagida (https://....lhr.life) =====
echo Bu pencereyi KAPATMA. Kapatirsan oyun internetten kapanir.
echo.
ssh -o StrictHostKeyChecking=no -R 80:localhost:3000 nokey@localhost.run
pause
