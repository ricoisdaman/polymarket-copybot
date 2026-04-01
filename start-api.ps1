# start-api.ps1 — launches ONLY the api-server (shared, serves all profiles)
# Use this when you want to run specific bot workers without the default bot.
# The api-server always runs on port 4000 regardless of which profile's workers are active.

$Root = Split-Path -Parent $MyInvocation.MyCommand.Definition
$EnvFile = Join-Path $Root ".env"

Write-Host ""
Write-Host "[copybot-api] Starting shared api-server on port 4000"

# Parse .env — we only need DATABASE_URL and PORT from this
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

# Force port 4000 and no specific profile (api-server is profile-agnostic)
$env_vars["PORT"] = "4000"
[System.Environment]::SetEnvironmentVariable("PORT", "4000", "Process")

$dbAbs = Join-Path $Root "packages\db\prisma\dev.db"
$dbUrl  = "file:" + $dbAbs.Replace("\", "/")
$env_vars["DATABASE_URL"] = $dbUrl
[System.Environment]::SetEnvironmentVariable("DATABASE_URL", $dbUrl, "Process")

$envBlock = ($env_vars.GetEnumerator() | ForEach-Object {
    "`$env:$($_.Key) = '$($_.Value -replace "'","''")'"
}) -join "; "

$cmd = ". `"$Root\disable-quickedit.ps1`"; $envBlock; Set-Location '$Root'; while (`$true) { pnpm --filter api-server dev; if (`$LASTEXITCODE -eq 0) { Write-Host '[api-server] Stopped cleanly.' -ForegroundColor Yellow; break }; Write-Host '[api-server] Crashed - restarting in 15s...' -ForegroundColor Red; Start-Sleep 15 }"

Start-Process powershell.exe -ArgumentList "-NoExit", "-Command", $cmd -WindowStyle Normal

Write-Host "[copybot-api] api-server launched (port 4000)"
Write-Host "[copybot-api] Now start any profile workers with start-workers.ps1"
Write-Host ""
