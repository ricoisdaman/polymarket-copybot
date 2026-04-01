@echo off
:: Thin launcher - delegates to start-bot.ps1 which handles everything cleanly
powershell.exe -ExecutionPolicy Bypass -File "%~dp0start-bot.ps1" %*
exit /b %ERRORLEVEL%
