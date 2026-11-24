# Renders assets\gazecast.svg with headless Chrome/Edge (once, at 512 px), shrinks it to each icon size,
# and packs assets\gazecast.ico. Needs Chrome or Edge, which is already on this computer.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$tmp  = Join-Path $here 'png'
New-Item -ItemType Directory -Force $tmp | Out-Null
Get-ChildItem $tmp -File -ErrorAction SilentlyContinue | Remove-Item -Force

$browser = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $browser) { throw 'Chrome or Edge is needed once to draw the icon.' }

# Wrapper page so the picture fills the window exactly.
$svgUri = ([System.Uri](Join-Path $here 'gazecast.svg')).AbsoluteUri
$page = Join-Path $tmp 'page.html'
Set-Content -Path $page -Encoding utf8 -Value "<!doctype html><meta charset=utf-8><style>html,body{margin:0;background:transparent;overflow:hidden}img{display:block;width:100vw;height:100vh}</style><img src=`"$svgUri`">"

$profile = Join-Path $env:TEMP 'gazecast-icon-profile'
$big = Join-Path $tmp 'icon-512.png'
$pageUri = ([System.Uri]$page).AbsoluteUri
Start-Process -FilePath $browser -Wait -WindowStyle Hidden -ArgumentList @('--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  "--user-data-dir=`"$profile`"", '--default-background-color=00000000', '--window-size=512,512', "--screenshot=`"$big`"", "`"$pageUri`"")
$t = 0; while (-not (Test-Path $big) -and $t -lt 60) { Start-Sleep -Milliseconds 250; $t++ }
if (-not (Test-Path $big)) { throw 'Could not draw the icon.' }
Remove-Item $profile -Recurse -Force -ErrorAction SilentlyContinue

# Crop to a square 512 and shrink to each size with high-quality scaling.
$src = [System.Drawing.Image]::FromFile($big)
$side = [Math]::Min($src.Width, $src.Height)
$sizes = 16, 24, 32, 48, 64, 128, 256   # 512 is the source itself
foreach ($s in $sizes) {
  $bmp = New-Object System.Drawing.Bitmap $s, $s, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.InterpolationMode = 'HighQualityBicubic'; $g.SmoothingMode = 'HighQuality'; $g.PixelOffsetMode = 'HighQuality'; $g.CompositingQuality = 'HighQuality'
  $g.DrawImage($src, (New-Object System.Drawing.Rectangle 0, 0, $s, $s), 0, 0, $side, $side, [System.Drawing.GraphicsUnit]::Pixel)
  $g.Dispose()
  $bmp.Save((Join-Path $tmp "icon-$s.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}
$src.Dispose()
Copy-Item (Join-Path $tmp 'icon-512.png') (Join-Path $here 'gazecast.png') -Force

# Pack PNG-in-ICO (16 to 256).
$ico = 16, 24, 32, 48, 64, 128, 256
$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($ms)
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$ico.Count)
$datas = @(); $offset = 6 + 16 * $ico.Count
foreach ($s in $ico) {
  $bytes = [System.IO.File]::ReadAllBytes((Join-Path $tmp "icon-$s.png"))
  $datas += , $bytes
  $dim = if ($s -ge 256) { 0 } else { $s }
  $bw.Write([byte]$dim); $bw.Write([byte]$dim); $bw.Write([byte]0); $bw.Write([byte]0)
  $bw.Write([uint16]1); $bw.Write([uint16]32); $bw.Write([uint32]$bytes.Length); $bw.Write([uint32]$offset)
  $offset += $bytes.Length
}
foreach ($d in $datas) { $bw.Write($d) }
$bw.Flush()
[System.IO.File]::WriteAllBytes((Join-Path $here 'gazecast.ico'), $ms.ToArray())
Write-Host 'Icon written: assets\gazecast.ico'
