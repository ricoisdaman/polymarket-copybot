@echo off
:: start-paper-v2.bat — launches bot-worker + guardian-worker for paper-v2 profile
:: paper-v2: Sports Trader A | $3/trade | 70-80 filter | PAPER mode
powershell.exe -ExecutionPolicy Bypass -File "%~dp0start-workers.ps1" "%~dp0.env.paper-v2"
