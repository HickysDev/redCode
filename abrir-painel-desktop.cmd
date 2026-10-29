@echo off
rem Abre o Red Code como app desktop (janela pr?pria, bandeja, atalho Ctrl+Shift+Espa?o).
rem Se o painel j? estiver rodando no navegador, o app s? abre a janela nele.
cd /d "%~dp0"
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0desktop\main.js"
