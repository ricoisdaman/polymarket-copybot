# start-workers.ps1 — launches ONLY bot-worker + guardian-worker
# Use this for a second profile when api-server is already running.
# Usage:  .\start-workers.ps1 .env.leader2

param([string]$EnvFile = "")

$Root = Split-Path -Parent $MyInvocation.MyCommand.Definition
if (-not $EnvFile) { $EnvFile = Join-Path $Root ".env" }
elseif (-not [System.IO.Path]::IsPathRooted($EnvFile)) { $EnvFile = Join-Path $Root $EnvFile }

Write-Host ""
Write-Host "[copybot-workers] Loading env from: $EnvFile"

if (-not (Test-Path $EnvFile)) {
    Write-Host "[ERROR] Env file not found: $EnvFile" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

$env_vars = @{}
foreach ($line in Get-Content $EnvFile) {
    $line = $line.Trim()
    if ($line -eq "" -or $line.StartsWith("#")) { continue }
    $idx = $line.IndexOf("=")
    if ($idx -lt 1) { continue }
    $key = $line.Substring(0, $idx).Trim()
    $val = $line.Substring($idx + 1).Trim()
    $env_vars[$key] = $val
    [System.Environment]::SetEnvironmentVariable($key, $val, "Process")
}

$dbAbs = Join-Path $Root "packages\db\prisma\dev.db"
$dbUrl  = "file:" + $dbAbs.Replace("\", "/")
$env_vars["DATABASE_URL"] = $dbUrl
[System.Environment]::SetEnvironmentVariable("DATABASE_URL", $dbUrl, "Process")

$profileId = $env_vars["PROFILE_ID"]; if (-not $profileId) { $profileId = "default" }

Write-Host "[copybot-workers] Profile : $profileId"
Write-Host "[copybot-workers] Leader  : $($env_vars['LEADER_WALLET'])"
Write-Host "[copybot-workers] Mode    : $($env_vars['BOT_MODE'])"
Write-Host ""

$envBlock = ($env_vars.GetEnumerator() | ForEach-Object {
    "`$env:$($_.Key) = '$($_.Value -replace "'","''")'"
}) -join "; "

function Start-Worker {
    param([string]$Title, [string]$Filter)
    # dot-source disable-quickedit.ps1 first so a stray click never freezes the process.
    $cmd = ". `"$Root\disable-quickedit.ps1`"; $envBlock; Set-Location '$Root'; while (`$true) { pnpm --filter $Filter dev; if (`$LASTEXITCODE -eq 0) { Write-Host '[$Filter] Stopped cleanly.' -ForegroundColor Yellow; break }; Write-Host '[$Filter] Crashed - restarting in 15s...' -ForegroundColor Red; Start-Sleep 15 }"
    Start-Process powershell.exe -ArgumentList "-NoExit", "-Command", $cmd `
        -WindowStyle Normal
    Write-Host "[copybot-workers] Launched: $Title  (auto-restarts on crash)"
}

Write-Host "[copybot-workers] Launching bot-worker..."
Start-Worker -Title "copybot :: bot-worker [$profileId]" -Filter "bot-worker"

Start-Sleep 2

Write-Host "[copybot-workers] Launching guardian-worker..."
Start-Worker -Title "copybot :: guardian-worker [$profileId]" -Filter "guardian-worker"

Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host " Workers launched for profile: $profileId"                    -ForegroundColor Green
Write-Host " Run stop-bot.ps1 to shut them down."                         -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host ""
Read-Host "Press Enter to close this window"
