# disable-quickedit.ps1
# Disables QuickEdit mode on the current console window.
#
# QuickEdit is enabled by default in all PowerShell/cmd windows. When it's on,
# a single click anywhere in the window freezes the process (stdin blocks stdout)
# until Enter or Escape is pressed. For a bot this means heartbeats stop being
# written, the guardian sees a stale heartbeat, and pauses trading.
#
# This script is dot-sourced at the start of each worker window by the launchers.

try {
    if (-not ("CopyBot.WinConsoleMode" -as [type])) {
        Add-Type -Name WinConsoleMode -Namespace CopyBot -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern IntPtr GetStdHandle(int n);
[DllImport("kernel32.dll")] public static extern bool GetConsoleMode(IntPtr h, out uint lpMode);
[DllImport("kernel32.dll")] public static extern bool SetConsoleMode(IntPtr h, uint dwMode);
'@
    }
    $handle = [CopyBot.WinConsoleMode]::GetStdHandle(-10)   # STD_INPUT_HANDLE
    $mode   = [uint32]0
    [CopyBot.WinConsoleMode]::GetConsoleMode($handle, [ref]$mode) | Out-Null
    # Clear ENABLE_QUICK_EDIT_MODE (0x40) and ENABLE_INSERT_MODE (0x20)
    [CopyBot.WinConsoleMode]::SetConsoleMode($handle, $mode -band (-bnot 0x60)) | Out-Null
    Write-Host "[copybot] QuickEdit disabled - window will not freeze on click." -ForegroundColor DarkGray
} catch {
    Write-Host "[copybot] Could not disable QuickEdit: $_" -ForegroundColor DarkYellow
}
