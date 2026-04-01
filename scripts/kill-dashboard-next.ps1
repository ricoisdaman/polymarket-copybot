$ErrorActionPreference = "SilentlyContinue"

$workspace = (Resolve-Path ".").Path
$workspacePattern = [Regex]::Escape($workspace)
$dashboardPattern = "${workspacePattern}.*apps\\dashboard"
$nextBinPattern = "next\\dist\\bin\\next"
$nextServerPattern = "next\\dist\\server\\lib\\start-server\.js"

$processes = Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq "node.exe" -and
  $_.CommandLine -and
  (
    (($_.CommandLine -match $nextBinPattern) -and ($_.CommandLine -match $dashboardPattern)) -or
    (($_.CommandLine -match $nextServerPattern) -and ($_.CommandLine -match $workspacePattern))
  )
}

if (-not $processes) {
  Write-Output "No stale dashboard Next processes found."
  exit 0
}

$killed = @()
foreach ($process in $processes) {
  if ($process.ProcessId -and $process.ProcessId -ne $PID) {
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    $killed += $process.ProcessId
  }
}

if ($killed.Count -gt 0) {
  Write-Output ("Killed dashboard Next process IDs: " + ($killed -join ", "))
} else {
  Write-Output "No dashboard Next processes needed termination."
}
