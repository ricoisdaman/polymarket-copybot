@echo off
powershell.exe -ExecutionPolicy Bypass -File "%~dp0start-workers.ps1" "%~dp0.env.leader4"
