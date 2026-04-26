@echo off
:: Launch beta bot-worker-v2 with C1 per-sport filters (PAPER mode, profile=beta)
powershell.exe -ExecutionPolicy Bypass -File "%~dp0start-beta.ps1" %*
exit /b %ERRORLEVEL%
