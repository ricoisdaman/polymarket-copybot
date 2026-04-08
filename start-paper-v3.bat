@echo off
:: start-paper-v3.bat — launches bot-worker + guardian-worker for paper-v3 profile
:: paper-v3: Sports Trader A | $3/trade | No price filter | PAPER mode
powershell.exe -ExecutionPolicy Bypass -File "%~dp0start-workers.ps1" "%~dp0.env.paper-v3"
