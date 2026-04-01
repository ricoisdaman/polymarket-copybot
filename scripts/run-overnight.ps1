param(
  [int]$Hours = 8,
  [int]$PollSeconds = 30
)

$ErrorActionPreference = "Stop"

$root = (Resolve-Path "$PSScriptRoot\..").Path
$logDir = Join-Path $root "logs"
if (-not (Test-Path $logDir)) {
  New-Item -ItemType Directory -Path $logDir | Out-Null
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$runDir = Join-Path $logDir "overnight-$timestamp"
New-Item -ItemType Directory -Path $runDir | Out-Null

function Start-ServiceProcess {
  param(
    [string]$Name,
    [string]$Command
  )

  $outFile = Join-Path $runDir "$Name.out.log"
  $errFile = Join-Path $runDir "$Name.err.log"
  $proc = Start-Process -FilePath "powershell" -WorkingDirectory $root -ArgumentList "-NoProfile", "-Command", $Command -RedirectStandardOutput $outFile -RedirectStandardError $errFile -PassThru
  return $proc
}

function Stop-PortOwner {
  param(
    [int]$Port,
    [string]$Label
  )

  $owners = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique
  if ($owners) {
    foreach ($owner in $owners) {
      try {
        Stop-Process -Id $owner -Force -ErrorAction Stop
        "[$(Get-Date -Format o)] KILLED_PORT_OWNER label=$Label port=$Port pid=$owner" | Out-File -FilePath $watchdogLog -Append -Encoding utf8
      }
      catch {
        "[$(Get-Date -Format o)] PORT_OWNER_KILL_FAILED label=$Label port=$Port pid=$owner err=$($_.Exception.Message)" | Out-File -FilePath $watchdogLog -Append -Encoding utf8
      }
    }
  }
}

$services = @(
  @{ Name = "api-server"; Cmd = "pnpm --filter @copybot/api-server dev" },
  @{ Name = "bot-worker"; Cmd = "pnpm --filter @copybot/bot-worker dev" },
  @{ Name = "guardian-worker"; Cmd = "pnpm --filter @copybot/guardian-worker dev" },
  @{ Name = "dashboard"; Cmd = "pnpm --filter @copybot/dashboard dev" }
)

$procs = @{}
foreach ($svc in $services) {
  $procs[$svc.Name] = Start-ServiceProcess -Name $svc.Name -Command $svc.Cmd
}

$watchdogLog = Join-Path $runDir "watchdog.log"
"Started overnight run at $(Get-Date -Format o)" | Out-File -FilePath $watchdogLog -Encoding utf8
"Logs: $runDir" | Out-File -FilePath $watchdogLog -Append -Encoding utf8

Stop-PortOwner -Port 4000 -Label "api-server"
Stop-PortOwner -Port 3000 -Label "dashboard"

$deadline = (Get-Date).AddHours($Hours)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds $PollSeconds

  foreach ($name in $procs.Keys) {
    $proc = $procs[$name]
    if ($proc.HasExited) {
      "[$(Get-Date -Format o)] PROCESS_EXITED $name code=$($proc.ExitCode)" | Out-File -FilePath $watchdogLog -Append -Encoding utf8
      $serviceDef = $services | Where-Object { $_.Name -eq $name } | Select-Object -First 1
      if ($serviceDef) {
        if ($name -eq "api-server") { Stop-PortOwner -Port 4000 -Label "api-server" }
        if ($name -eq "dashboard") { Stop-PortOwner -Port 3000 -Label "dashboard" }
        $procs[$name] = Start-ServiceProcess -Name $serviceDef.Name -Command $serviceDef.Cmd
        "[$(Get-Date -Format o)] PROCESS_RESTARTED $name pid=$($procs[$name].Id)" | Out-File -FilePath $watchdogLog -Append -Encoding utf8
      }
    }
  }

  try {
    $health = Invoke-RestMethod -Method Get -Uri "http://localhost:4000/health/deep"
    $ok = [bool]$health.ok
    "[$(Get-Date -Format o)] health.ok=$ok heartbeatAgeMs=$($health.heartbeatAgeMs) queueDepth=$($health.queueDepth)" | Out-File -FilePath $watchdogLog -Append -Encoding utf8
    if (-not $ok) {
      "[$(Get-Date -Format o)] HEALTH_DEGRADED" | Out-File -FilePath $watchdogLog -Append -Encoding utf8
    }
  }
  catch {
    "[$(Get-Date -Format o)] HEALTH_CHECK_FAILED $($_.Exception.Message)" | Out-File -FilePath $watchdogLog -Append -Encoding utf8
  }
}

foreach ($name in $procs.Keys) {
  $proc = $procs[$name]
  if (-not $proc.HasExited) {
    Stop-Process -Id $proc.Id -Force
    "[$(Get-Date -Format o)] STOPPED $name" | Out-File -FilePath $watchdogLog -Append -Encoding utf8
  }
}

"Overnight run finished at $(Get-Date -Format o)" | Out-File -FilePath $watchdogLog -Append -Encoding utf8
Write-Host "Overnight soak complete. Logs at: $runDir"