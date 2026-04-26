# start-beta.ps1 — launches bot-worker-v2 with C1 per-sport filter config
# Uses profile=beta (isolated namespace in the shared DB)
# The main api-server (start-bot.bat) serves the dashboard; select "beta" profile there.
#
# Usage:  .\start-beta.ps1

$Root = Split-Path -Parent $MyInvocation.MyCommand.Definition
$EnvFile = Join-Path $Root ".env.beta"

Write-Host ""
Write-Host "[beta] Loading env from: $EnvFile" -ForegroundColor Cyan

if (-not (Test-Path $EnvFile)) {
    Write-Host "[ERROR] .env.beta not found: $EnvFile" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

# Parse .env.beta into a hashtable
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

# Always use absolute forward-slash DB path (must point at the shared DB)
$dbAbs = Join-Path $Root "packages\db\prisma\dev.db"
$dbUrl  = "file:" + $dbAbs.Replace("\", "/")
$env_vars["DATABASE_URL"] = $dbUrl
[System.Environment]::SetEnvironmentVariable("DATABASE_URL", $dbUrl, "Process")

$profileId = $env_vars["PROFILE_ID"]
if (-not $profileId) { $profileId = "beta" }

Write-Host "[beta] Profile       : $profileId"
Write-Host "[beta] Leader        : $($env_vars['LEADER_WALLET'])"
Write-Host "[beta] Mode          : $($env_vars['BOT_MODE'])"
Write-Host "[beta] Filter        : $($env_vars['MIN_PRICE_FILTER']) - $($env_vars['MAX_PRICE_FILTER'])"
Write-Host "[beta] Sport Filters : $($env_vars['SPORT_PRICE_FILTERS'])"
Write-Host "[beta] DB            : $dbUrl"
Write-Host ""
Write-Host "[beta] NOTE: Dashboard shows beta profile via existing api-server on port 4000." -ForegroundColor Yellow
Write-Host "[beta]       Select 'beta' in the Profile Switcher." -ForegroundColor Yellow
Write-Host ""

$envBlock = ($env_vars.GetEnumerator() | ForEach-Object {
    "`$env:$($_.Key) = '$($_.Value -replace "'","''")'"
}) -join "; "

# Launch bot-worker-v2 in a new titled window with auto-restart on crash
$cmd = ". `"$Root\disable-quickedit.ps1`"; $envBlock; Set-Location '$Root'; while (`$true) { pnpm --filter '@copybot/bot-worker-v2' dev; if (`$LASTEXITCODE -eq 0) { Write-Host '[bot-worker-v2] Stopped cleanly.' -ForegroundColor Yellow; break }; Write-Host '[bot-worker-v2] Crashed - restarting in 15s...' -ForegroundColor Red; Start-Sleep 15 }"
Start-Process powershell.exe -ArgumentList "-NoExit", "-Command", $cmd -WindowStyle Normal
Write-Host "[beta] Launched: bot-worker-v2 [$profileId]  (auto-restarts on crash)" -ForegroundColor Green
Write-Host ""
Read-Host "Press Enter to close this window"
