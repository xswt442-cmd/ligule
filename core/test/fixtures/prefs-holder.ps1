param(
  [Parameter(Mandatory = $true)][string]$Path,
  [Parameter(Mandatory = $true)][string]$ReadyPath,
  [Parameter(Mandatory = $true)][int]$HoldMilliseconds,
  [string]$ReleasePath
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
$releaseMarkerPath = $null
if ($ReleasePath) {
  $releaseMarkerPath = [System.IO.Path]::GetFullPath($ReleasePath)
  if (-not $releaseMarkerPath.StartsWith($temporaryPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'The release marker must be inside testplace/tmp.'
  }
}
$stream = [System.IO.File]::Open(
  $targetPath,
  [System.IO.FileMode]::Open,
  [System.IO.FileAccess]::ReadWrite,
  [System.IO.FileShare]::ReadWrite
)

try {
  [System.IO.File]::WriteAllText($readyMarkerPath, 'ready')
  if ($releaseMarkerPath) {
    $releaseDeadline = [System.DateTime]::UtcNow.AddSeconds(60)
    while (-not [System.IO.File]::Exists($releaseMarkerPath)) {
      if ([System.DateTime]::UtcNow -ge $releaseDeadline) { throw 'The file holder was not released.' }
      Start-Sleep -Milliseconds 20
    }
  } elseif ($HoldMilliseconds -gt 0) {
    Start-Sleep -Milliseconds $HoldMilliseconds
  }
}
finally {
  $stream.Dispose()
}
