param(
  [int]$MaxRestarts = 20
)

$ErrorActionPreference = "Continue"
$root = (Resolve-Path ".").Path
$attempt = 0

while ($true) {
  $attempt += 1
  Write-Output "[dashboard] starting dev attempt $attempt"

  Push-Location "$root\apps\dashboard"
  try {
    pnpm run dev:raw
    $exitCode = $LASTEXITCODE
  }
  finally {
    Pop-Location
  }

  if ($exitCode -eq 0) {
    Write-Output "[dashboard] exited cleanly"
    exit 0
  }

  Write-Warning "[dashboard] dev crashed with exit code $exitCode"
  powershell -ExecutionPolicy Bypass -File "$root\scripts\kill-dashboard-next.ps1" | Out-Null

  if ($attempt -ge $MaxRestarts) {
    Write-Error "[dashboard] reached max restarts ($MaxRestarts), stopping"
    exit $exitCode
  }

  Start-Sleep -Seconds 2
}
