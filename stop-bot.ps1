# stop-bot.ps1 — kills all copybot worker processes
Write-Host "[copybot] Stopping all workers..." -ForegroundColor Yellow

$killed = 0
Get-Process | Where-Object { $_.ProcessName -match "node" } | ForEach-Object {
    $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)").CommandLine
    if ($cmd -match "tsx|api-server|bot-worker|guardian") {
        Stop-Process -Id $_.Id -Force
        Write-Host "[copybot] Killed PID $($_.Id): $($_.ProcessName)"
        $killed++
    }
}

# Also kill any powershell windows running pnpm copybot workers
Get-Process powershell | ForEach-Object {
    $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)").CommandLine
    if ($cmd -match "api-server|bot-worker|guardian-worker") {
        Stop-Process -Id $_.Id -Force
        Write-Host "[copybot] Killed worker shell PID $($_.Id)"
        $killed++
    }
}

if ($killed -eq 0) {
    Write-Host "[copybot] No running workers found." -ForegroundColor Gray
} else {
    Write-Host "[copybot] Stopped $killed process(es)." -ForegroundColor Green
}
Read-Host "Press Enter to close"
