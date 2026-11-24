# GazeCast setup - downloads the open-source tools GazeCast needs into .\tools
#
#   scrcpy          from https://github.com/Genymobile/scrcpy/releases   (checked against the release SHA256SUMS.txt)
#   platform-tools  from https://dl.google.com/android/repository/        (adb.exe signature must be a valid Google signature)
#   Node.js         from https://nodejs.org/dist/                          (only if Node is not already installed; SHA-256 checked)
#
# Works in Windows PowerShell 5.1. Run:   powershell -ExecutionPolicy Bypass -File setup.ps1
# Use -Force to download everything again.

param([switch]$Force)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# The bridge speaks the scrcpy protocol of exactly this version. Do not change one without the other.
$ScrcpyVersion = 'v5.0.1'

$Root  = Split-Path -Parent $MyInvocation.MyCommand.Path
$Tools = Join-Path $Root 'tools'
$Dl    = Join-Path $Tools 'downloads'
New-Item -ItemType Directory -Force -Path $Tools | Out-Null
New-Item -ItemType Directory -Force -Path $Dl | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem

$Report = New-Object System.Collections.ArrayList

function Say($text, $color) {
    if (-not $color) { $color = 'Gray' }
    Write-Host $text -ForegroundColor $color
}

function Get-Download($url, $allowedHost, $outFile) {
    $uri = [Uri]$url
    if ($uri.Scheme -ne 'https' -or $uri.Host -ne $allowedHost) {
        throw "Refusing to download from $url (expected https://$allowedHost)"
    }
    Say "  downloading $url"
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $outFile
    return (Get-Item $outFile)
}

function Add-Report($name, $file, $source, $check) {
    $item = Get-Item $file
    $hash = (Get-FileHash -Algorithm SHA256 -Path $file).Hash.ToLower()
    [void]$Report.Add([pscustomobject]@{
        File = $name; Bytes = $item.Length; SizeMB = [math]::Round($item.Length / 1MB, 2)
        Source = $source; Check = $check; SHA256 = $hash
    })
}

function Expand-Flat($zip, $dest) {
    # Extracts a zip whose content sits in one top-level folder, without that folder.
    if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
    $tmp = "$dest.tmp"
    if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
    [IO.Compression.ZipFile]::ExtractToDirectory($zip, $tmp)
    $inner = @(Get-ChildItem $tmp)
    if ($inner.Count -eq 1 -and $inner[0].PSIsContainer) {
        Move-Item $inner[0].FullName $dest
        Remove-Item -Recurse -Force $tmp
    } else {
        Move-Item $tmp $dest
    }
}

# ---------------------------------------------------------------- scrcpy
Say ''
Say "[1/3] scrcpy $ScrcpyVersion" 'Cyan'
$scrcpyDir = Join-Path $Tools 'scrcpy'
$serverFile = Join-Path $scrcpyDir 'scrcpy-server'
if ((Test-Path $serverFile) -and -not $Force) {
    Say '  already present, skipping' 'DarkGray'
} else {
    $zipName = "scrcpy-win64-$ScrcpyVersion.zip"
    $base = "https://github.com/Genymobile/scrcpy/releases/download/$ScrcpyVersion"
    $zip = Join-Path $Dl $zipName
    $sums = Join-Path $Dl 'scrcpy-SHA256SUMS.txt'
    [void](Get-Download "$base/$zipName" 'github.com' $zip)
    [void](Get-Download "$base/SHA256SUMS.txt" 'github.com' $sums)
    $expected = $null
    foreach ($line in Get-Content $sums) {
        if ($line -match '^([0-9a-fA-F]{64})\s+\*?(.+)$' -and $Matches[2].Trim() -eq $zipName) { $expected = $Matches[1].ToLower() }
    }
    $actual = (Get-FileHash -Algorithm SHA256 -Path $zip).Hash.ToLower()
    if (-not $expected) { throw "No checksum for $zipName in SHA256SUMS.txt" }
    if ($expected -ne $actual) { throw "Checksum mismatch for $zipName. Expected $expected, got $actual" }
    Say '  SHA-256 matches the official SHA256SUMS.txt' 'Green'
    Expand-Flat $zip $scrcpyDir
    Add-Report $zipName $zip 'github.com/Genymobile/scrcpy' 'SHA-256 matches release SHA256SUMS.txt'
}

# ---------------------------------------------------------------- platform-tools (adb)
Say ''
Say '[2/3] Android platform-tools (adb)' 'Cyan'
$ptDir = Join-Path $Tools 'platform-tools'
$adb = Join-Path $ptDir 'adb.exe'
if ((Test-Path $adb) -and -not $Force) {
    Say '  already present, skipping' 'DarkGray'
} else {
    $zipName = 'platform-tools-latest-windows.zip'
    $zip = Join-Path $Dl $zipName
    [void](Get-Download "https://dl.google.com/android/repository/$zipName" 'dl.google.com' $zip)
    Expand-Flat $zip $ptDir
    $sig = Get-AuthenticodeSignature -FilePath $adb
    if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'Google') {
        Remove-Item -Recurse -Force $ptDir
        throw "adb.exe does not carry a valid Google signature (status: $($sig.Status)). Download removed."
    }
    Say "  adb.exe is signed by: $($sig.SignerCertificate.Subject)" 'Green'
    Add-Report $zipName $zip 'dl.google.com/android/repository' 'adb.exe Authenticode signature valid (Google)'
}

# ---------------------------------------------------------------- Node.js
Say ''
Say '[3/3] Node.js (runs the GazeCast bridge)' 'Cyan'
$nodeDir = Join-Path $Tools 'node'
$nodeExe = Join-Path $nodeDir 'node.exe'
$systemNode = Get-Command node -ErrorAction SilentlyContinue
if ($systemNode -and -not $Force) {
    Say "  Node is already installed ($($systemNode.Source)), skipping" 'DarkGray'
} elseif ((Test-Path $nodeExe) -and -not $Force) {
    Say '  already present, skipping' 'DarkGray'
} else {
    $arch = 'x64'
    if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { $arch = 'arm64' }
    $index = (Invoke-WebRequest -UseBasicParsing -Uri 'https://nodejs.org/dist/index.json').Content | ConvertFrom-Json
    $lts = $index | Where-Object { $_.lts } | Select-Object -First 1
    $ver = $lts.version
    $zipName = "node-$ver-win-$arch.zip"
    $zip = Join-Path $Dl $zipName
    $sums = Join-Path $Dl 'node-SHASUMS256.txt'
    [void](Get-Download "https://nodejs.org/dist/$ver/$zipName" 'nodejs.org' $zip)
    [void](Get-Download "https://nodejs.org/dist/$ver/SHASUMS256.txt" 'nodejs.org' $sums)
    $expected = $null
    foreach ($line in Get-Content $sums) {
        if ($line -match '^([0-9a-fA-F]{64})\s+(.+)$' -and $Matches[2].Trim() -eq $zipName) { $expected = $Matches[1].ToLower() }
    }
    $actual = (Get-FileHash -Algorithm SHA256 -Path $zip).Hash.ToLower()
    if (-not $expected) { throw "No checksum for $zipName in SHASUMS256.txt" }
    if ($expected -ne $actual) { throw "Checksum mismatch for $zipName. Expected $expected, got $actual" }
    Say '  SHA-256 matches the official SHASUMS256.txt' 'Green'
    # Only node.exe is needed (GazeCast has no npm dependencies).
    New-Item -ItemType Directory -Force -Path $nodeDir | Out-Null
    $archive = [IO.Compression.ZipFile]::OpenRead($zip)
    try {
        $entry = $archive.Entries | Where-Object { $_.FullName -match '^[^/]+/node\.exe$' } | Select-Object -First 1
        if (-not $entry) { throw 'node.exe not found inside the Node zip' }
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $nodeExe, $true)
    } finally { $archive.Dispose() }
    Add-Report $zipName $zip 'nodejs.org/dist' 'SHA-256 matches SHASUMS256.txt'
}

# ---------------------------------------------------------------- summary
$versions = [ordered]@{ scrcpy = $ScrcpyVersion.TrimStart('v'); updated = (Get-Date).ToString('s') }
($versions | ConvertTo-Json) | Out-File -FilePath (Join-Path $Tools 'versions.json') -Encoding ascii

Say ''
if ($Report.Count -gt 0) {
    Say 'Downloaded files (kept in tools\downloads):' 'Cyan'
    $Report | Format-Table File, Bytes, SizeMB, Source, Check -AutoSize | Out-String -Width 220 | Write-Host
    $Report | ForEach-Object { Say ("  sha256 {0}  {1}" -f $_.SHA256, $_.File) 'DarkGray' }
    ($Report | ConvertTo-Json) | Out-File -FilePath (Join-Path $Tools 'downloads.json') -Encoding ascii
} else {
    Say 'Nothing to download - everything is already here.' 'Green'
}
Say ''
Say 'Setup finished. Double-click start.bat to open GazeCast.' 'Green'
