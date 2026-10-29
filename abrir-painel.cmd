@echo off
rem Abre o Red Code (app desktop do painel). Se o app nao abrir, cai no painel pelo navegador.
cd /d "%~dp0"
if exist "%~dp0node_modules\electron\dist\electron.exe" (
    start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0desktop\main.js"
    exit /b
)
set PORTA=4317
netstat -ano | findstr /R /C:"127.0.0.1:%PORTA% .*LISTENING" >nul
if errorlevel 1 (
    start "Painel (servidor)" /min node "%~dp0lancador.js"
    timeout /t 1 /nobreak >nul
)
start "" http://localhost:%PORTA%
