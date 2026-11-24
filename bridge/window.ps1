# GazeCast window helper (Windows PowerShell 5.1 compatible, nothing downloaded).
# Minimises / restores / maximises the GazeCast browser window, or toggles its
# full-screen mode, by calling user32.dll.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File window.ps1 -Action minimize [-ProcId 1234] [-Title GazeCast]
#
# Prints one word: OK, or NOTFOUND when no GazeCast window exists. Exit code 0 / 2.

param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('minimize', 'restore', 'maximize', 'zoom', 'fullscreen', 'find')]
    [string]$Action,
    [int]$ProcId = 0,
    [string]$Title = 'GazeCast'
)

$ErrorActionPreference = 'Stop'

Add-Type -Namespace GazeCast -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
'@

$SW_MAXIMIZE = 3
$SW_MINIMIZE = 6
$SW_RESTORE = 9
$VK_F11 = 0x7A

# Find the window: first the browser the bridge started, then any Chrome / Edge
# window whose title is exactly the page title. Other programs are never touched.
$handle = [IntPtr]::Zero
if ($ProcId -gt 0) {
    $p = Get-Process -Id $ProcId -ErrorAction SilentlyContinue
    if ($p -and $p.MainWindowHandle -ne [IntPtr]::Zero) { $handle = $p.MainWindowHandle }
}
if ($handle -eq [IntPtr]::Zero) {
    $match = Get-Process -Name chrome, msedge -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero -and $_.MainWindowTitle -eq $Title } |
        Select-Object -First 1
    if ($match) { $handle = $match.MainWindowHandle }
}
if ($handle -eq [IntPtr]::Zero) {
    Write-Output 'NOTFOUND'
    exit 2
}

switch ($Action) {
    'minimize' { [void][GazeCast.Win]::ShowWindow($handle, $SW_MINIMIZE) }
    'restore' {
        [void][GazeCast.Win]::ShowWindow($handle, $SW_RESTORE)
        [void][GazeCast.Win]::SetForegroundWindow($handle)
    }
    'maximize' { [void][GazeCast.Win]::ShowWindow($handle, $SW_MAXIMIZE) }
    'zoom' {
        # ordinary window: maximise <-> restore
        if ([GazeCast.Win]::IsZoomed($handle)) { [void][GazeCast.Win]::ShowWindow($handle, $SW_RESTORE) }
        else { [void][GazeCast.Win]::ShowWindow($handle, $SW_MAXIMIZE) }
    }
    'fullscreen' {
        # browser full-screen mode is toggled with the F11 key
        if ([GazeCast.Win]::IsIconic($handle)) { [void][GazeCast.Win]::ShowWindow($handle, $SW_RESTORE) }
        [void][GazeCast.Win]::SetForegroundWindow($handle)
        Start-Sleep -Milliseconds 120
        [GazeCast.Win]::keybd_event($VK_F11, 0, 0, [UIntPtr]::Zero)
        [GazeCast.Win]::keybd_event($VK_F11, 0, 2, [UIntPtr]::Zero)
    }
    'find' { }
}
Write-Output 'OK'
exit 0
