@echo off
:: Thin launcher — delegates to stop-bot.ps1
powershell.exe -ExecutionPolicy Bypass -File "%~dp0stop-bot.ps1" %*
