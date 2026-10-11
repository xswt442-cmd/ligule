param(
  [Parameter(Mandatory = $true)][string]$Path,
  [Parameter(Mandatory = $true)][string]$ReadyPath,
  [Parameter(Mandatory = $true)][int]$HoldMilliseconds
)

$ErrorActionPreference = 'Stop'
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$temporaryRoot = [System.IO.Path]::GetFullPath((Join-Path $repoRoot 'testplace\tmp'))
$temporaryPrefix = $temporaryRoot + [System.IO.Path]::DirectorySeparatorChar
$targetPath = [System.IO.Path]::GetFullPath($Path)
$readyMarkerPath = [System.IO.Path]::GetFullPath($ReadyPath)

if (-not $targetPath.StartsWith($temporaryPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'The held file must be inside testplace/tmp.'
}
if (-not $readyMarkerPath.StartsWith($temporaryPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'The ready marker must be inside testplace/tmp.'
}
$stream = [System.IO.File]::Open(
  $targetPath,
  [System.IO.FileMode]::Open,
  [System.IO.FileAccess]::ReadWrite,
  [System.IO.FileShare]::ReadWrite
)

try {
  [System.IO.File]::WriteAllText($readyMarkerPath, 'ready')
  if ($HoldMilliseconds -gt 0) {
    Start-Sleep -Milliseconds $HoldMilliseconds
  }
}
finally {
  $stream.Dispose()
}
