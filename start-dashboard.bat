@echo off
powershell.exe -ExecutionPolicy Bypass -Command "Set-Location '%~dp0'; pnpm --filter @copybot/dashboard dev"
