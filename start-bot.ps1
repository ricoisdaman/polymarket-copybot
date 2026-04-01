# start-bot.ps1 — launches api-server, bot-worker, guardian-worker
# Usage:  .\start-bot.ps1
# Optional: pass a profile env file:  .\start-bot.ps1 .env.leader2

param([string]$EnvFile = "")

$Root = Split-Path -Parent $MyInvocation.MyCommand.Definition
if (-not $EnvFile) { $EnvFile = Join-Path $Root ".env" }
elseif (-not [System.IO.Path]::IsPathRooted($EnvFile)) { $EnvFile = Join-Path $Root $EnvFile }

Write-Host ""
Write-Host "[copybot] Loading env from: $EnvFile"

if (-not (Test-Path $EnvFile)) {
    Write-Host "[ERROR] Env file not found: $EnvFile" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

# Parse .env into a hashtable
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

# Always use absolute forward-slash DB path
$dbAbs = Join-Path $Root "packages\db\prisma\dev.db"
$dbUrl  = "file:" + $dbAbs.Replace("\", "/")
$env_vars["DATABASE_URL"] = $dbUrl
[System.Environment]::SetEnvironmentVariable("DATABASE_URL", $dbUrl, "Process")

$profileId = $env_vars["PROFILE_ID"]
if (-not $profileId) { $profileId = "default" }

Write-Host "[copybot] Profile  : $profileId"
Write-Host "[copybot] Leader   : $($env_vars['LEADER_WALLET'])"
Write-Host "[copybot] Mode     : $($env_vars['BOT_MODE'])"
Write-Host "[copybot] Feed     : $($env_vars['LEADER_FEED_MODE'])"
Write-Host "[copybot] API Port : $($env_vars['PORT'])"
Write-Host "[copybot] DB       : $dbUrl"
Write-Host ""

# Prisma schema push
Write-Host "[copybot] Applying Prisma schema..."
Push-Location (Join-Path $Root "packages\db")
& pnpm exec prisma db push --accept-data-loss
Pop-Location
Write-Host ""

# Build env block string for child process
$envBlock = ($env_vars.GetEnumerator() | ForEach-Object {
    "`$env:$($_.Key) = '$($_.Value -replace "'","''")'"
}) -join "; "

# Launch each worker in a new titled window
function Start-Worker {
    param([string]$Title, [string]$Filter)
    # Inner loop: pnpm restarts automatically on crash (non-zero exit).
    # A clean exit (code 0 = SIGINT / intentional stop) breaks the loop.
    # dot-source disable-quickedit.ps1 first so a stray click never freezes the process.
    $cmd = ". `"$Root\disable-quickedit.ps1`"; $envBlock; Set-Location '$Root'; while (`$true) { pnpm --filter $Filter dev; if (`$LASTEXITCODE -eq 0) { Write-Host '[$Filter] Stopped cleanly.' -ForegroundColor Yellow; break }; Write-Host '[$Filter] Crashed - restarting in 15s...' -ForegroundColor Red; Start-Sleep 15 }"
    Start-Process powershell.exe -ArgumentList "-NoExit", "-Command", $cmd `
        -WindowStyle Normal
    Write-Host "[copybot] Launched: $Title  (auto-restarts on crash)"
}

Write-Host "[copybot] Launching api-server..."
Start-Worker -Title "copybot :: api-server [$profileId]" -Filter "api-server"

Write-Host "[copybot] Waiting 4s for api-server to init..."
Start-Sleep 4

Write-Host "[copybot] Launching bot-worker..."
Start-Worker -Title "copybot :: bot-worker [$profileId]" -Filter "bot-worker"

Start-Sleep 2

Write-Host "[copybot] Launching guardian-worker..."
Start-Worker -Title "copybot :: guardian-worker [$profileId]" -Filter "guardian-worker"

Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host " All 3 workers launched in separate PowerShell windows."     -ForegroundColor Green
Write-Host " Run stop-bot.ps1 to shut them all down."                    -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host ""
Read-Host "Press Enter to close this window"
