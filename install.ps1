# Puts GazeCast on the desktop and in the Start menu, with its icon. Safe to run again.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$icon = Join-Path $root 'assets\gazecast.ico'

Write-Host ''
Write-Host '  Installing GazeCast ...' -ForegroundColor Cyan

if (-not (Test-Path $icon)) {
  Write-Host '  Drawing the icon ...'
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'assets\make-icon.ps1') | Out-Null
}
if (-not (Test-Path $icon)) { throw 'The icon could not be made.' }

$shell = New-Object -ComObject WScript.Shell
function New-Shortcut($path, $target, $description) {
  $s = $shell.CreateShortcut($path)
  $s.TargetPath = $target
  $s.WorkingDirectory = $root
  $s.IconLocation = "$icon,0"
  $s.Description = $description
  $s.WindowStyle = 7   # console starts minimised
  $s.Save()
}

$desktop  = [Environment]::GetFolderPath('Desktop')
$programs = [Environment]::GetFolderPath('Programs')

New-Shortcut (Join-Path $desktop  'GazeCast.lnk')        (Join-Path $root 'start.bat')      'Control your phone with your eyes'
New-Shortcut (Join-Path $programs 'GazeCast.lnk')        (Join-Path $root 'start.bat')      'Control your phone with your eyes'
New-Shortcut (Join-Path $programs 'GazeCast (demo).lnk') (Join-Path $root 'start-demo.bat') 'Try GazeCast without a phone'

Write-Host ''
Write-Host '  Done. GazeCast is on your desktop.' -ForegroundColor Green
Write-Host '  Double-click the GazeCast icon to start.'
Write-Host ''
