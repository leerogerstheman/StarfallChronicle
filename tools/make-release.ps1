# Build a release zip from git-tracked files only.
#
# Why not Compress-Archive: on this machine it writes backslash-separated
# entry names, which is not what the Zip spec says and which makes several
# unzip tools dump every file into one flat folder. System.IO.Compression with
# explicit forward-slash entry names is the whole fix.
#
# usage: powershell -ExecutionPolicy Bypass -File tools/make-release.ps1 0.3.0
param([Parameter(Mandatory = $true)][string]$Version)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$outName = "StarfallChronicle-v$Version.zip"
$outPath = Join-Path $root $outName
if (Test-Path $outPath) { Remove-Item $outPath }

$files = @(& git -C $root ls-files) | Where-Object { $_ -ne '' }
if (-not $files) { throw 'git ls-files returned nothing' }

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$zip = [System.IO.Compression.ZipFile]::Open($outPath, 'Create')
try {
  foreach ($rel in $files) {
    $src = Join-Path $root ($rel -replace '/', '\')
    $entry = $zip.CreateEntry($rel, [System.IO.Compression.CompressionLevel]::Optimal)
    $stream = $entry.Open()
    $bytes = [System.IO.File]::ReadAllBytes($src)
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Close()
  }
}
finally { $zip.Dispose() }

# Sanity: no backslash entries may ever ship again.
$check = [System.IO.Compression.ZipFile]::OpenRead($outPath)
try {
  $bad = @($check.Entries | Where-Object { $_.FullName -like '*\*' })
  if ($bad.Count -gt 0) { throw "$($bad.Count) entries use backslashes" }
  $count = $check.Entries.Count
}
finally { $check.Dispose() }

Write-Output "$outName created: $count entries, $([math]::Round((Get-Item $outPath).Length / 1MB, 2)) MB"
