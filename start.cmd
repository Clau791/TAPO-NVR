@echo off
rem Pornire manuala (in fereastra). Pentru rulare non-stop la boot foloseste install-autostart.ps1.
cd /d "%~dp0"
node server.js
pause
