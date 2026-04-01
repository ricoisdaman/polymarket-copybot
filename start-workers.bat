@echo off
:: Thin launcher — delegates to start-workers.ps1
powershell.exe -ExecutionPolicy Bypass -File "%~dp0start-workers.ps1" %*

::  running the api-server for the default profile.
::
::  Usage:  .\start-workers.bat .env.leader2
:: ─────────────────────────────────────────────────────────────────────────────

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "ENVFILE=%ROOT%\.env"

if not "%~1"=="" (
    if exist "%~1"           set "ENVFILE=%~1"
    if not exist "%~1"       if exist "%ROOT%\%~1" set "ENVFILE=%ROOT%\%~1"
)

echo.
echo [copybot-workers] Loading env from: %ENVFILE%

if not exist "%ENVFILE%" (
    echo [ERROR] Env file not found: %ENVFILE%
    echo Usage: start-workers.bat .env.leader2
    pause
    exit /b 1
)

for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%ENVFILE%") do (
    if not "%%A"=="" if not "%%B"=="" set "%%A=%%B"
)

set "DB_PATH=%ROOT%\packages\db\prisma\dev.db"
set "DB_PATH_FWD=%DB_PATH:\=/%"
set "DATABASE_URL=file:%DB_PATH_FWD%"

echo [copybot-workers] Profile : %PROFILE_ID%
echo [copybot-workers] Leader  : %LEADER_WALLET%
echo [copybot-workers] Mode    : %BOT_MODE%
echo [copybot-workers] DB      : %DATABASE_URL%
echo.

:: ── Write per-worker launcher .bat files ────────────────────────────────────
set "TMP_DIR=%ROOT%\.bat-launchers\%PROFILE_ID%"
if not exist "%TMP_DIR%" mkdir "%TMP_DIR%"

call :write_launcher "%TMP_DIR%\run-bot-worker.bat"  "pnpm --filter bot-worker dev"
call :write_launcher "%TMP_DIR%\run-guardian.bat"    "pnpm --filter guardian-worker dev"

:: ── Launch workers ───────────────────────────────────────────────────────────
echo [copybot-workers] Launching bot-worker...
start "copybot :: bot-worker [%PROFILE_ID%]" cmd /k ""%TMP_DIR%\run-bot-worker.bat""

timeout /t 2 /nobreak >nul

echo [copybot-workers] Launching guardian-worker...
start "copybot :: guardian-worker [%PROFILE_ID%]" cmd /k ""%TMP_DIR%\run-guardian.bat""

echo.
echo [copybot-workers] Workers running for profile: %PROFILE_ID%
echo.
endlocal
goto :eof

:write_launcher
set "OUTFILE=%~1"
set "CMD=%~2"
(
    echo @echo off
    echo cd /d "%ROOT%"
    echo set "NODE_ENV=%NODE_ENV%"
    echo set "PORT=%PORT%"
    echo set "PROFILE_ID=%PROFILE_ID%"
    echo set "STARTING_USDC=%STARTING_USDC%"
    echo set "LEADER_WALLET=%LEADER_WALLET%"
    echo set "BOT_MODE=%BOT_MODE%"
    echo set "LEADER_FEED_MODE=%LEADER_FEED_MODE%"
    echo set "LEADER_POLL_INTERVAL_SECONDS=%LEADER_POLL_INTERVAL_SECONDS%"
    echo set "DATABASE_URL=%DATABASE_URL%"
    echo set "POLYMARKET_CLOB_API_URL=%POLYMARKET_CLOB_API_URL%"
    echo set "POLYMARKET_DATA_API_URL=%POLYMARKET_DATA_API_URL%"
    echo set "ENABLE_LIVE_EXECUTION=%ENABLE_LIVE_EXECUTION%"
    echo set "POLYMARKET_API_KEY=%POLYMARKET_API_KEY%"
    echo %CMD%
) > "%OUTFILE%"
goto :eof
