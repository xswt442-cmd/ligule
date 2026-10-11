param(
  [Parameter(Mandatory = $true)][string]$Path,
  [Parameter(Mandatory = $true)][string]$ReadyPath,
  [Parameter(Mandatory = $true)][int]$HoldMilliseconds,
  [string]$ChangedPath = $null,
  [string]$ReplaceFrom = $null,
  [string]$ReplaceTo = $null,
  [int]$RewriteDelayMilliseconds = 0
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
$hasReplacementFrom = $PSBoundParameters.ContainsKey('ReplaceFrom')
$hasReplacementTo = $PSBoundParameters.ContainsKey('ReplaceTo')
if ($hasReplacementFrom -ne $hasReplacementTo) {
  throw 'Both replacement strings must be supplied together.'
}
$stream = [System.IO.File]::Open(
  $targetPath,
  [System.IO.FileMode]::Open,
  [System.IO.FileAccess]::ReadWrite,
  [System.IO.FileShare]::ReadWrite
)

try {
  [System.IO.File]::WriteAllText($readyMarkerPath, 'ready')
  if ($hasReplacementFrom) {
    if ($null -eq $ChangedPath) {
      throw 'A changed marker path is required when replacing document text.'
    }
    $changedMarkerPath = [System.IO.Path]::GetFullPath($ChangedPath)
    if (-not $changedMarkerPath.StartsWith($temporaryPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw 'The changed marker must be inside testplace/tmp.'
    }
    if ($RewriteDelayMilliseconds -gt 0) {
      Start-Sleep -Milliseconds $RewriteDelayMilliseconds
    }

    $originalBytes = New-Object byte[] ([int]$stream.Length)
    $stream.Position = 0
    $readCount = 0
    while ($readCount -lt $originalBytes.Length) {
      $received = $stream.Read($originalBytes, $readCount, $originalBytes.Length - $readCount)
      if ($received -eq 0) {
        break
      }
      $readCount += $received
    }
    if ($readCount -ne $originalBytes.Length) {
      throw 'The held document could not be read completely.'
    }
    $utf8 = [System.Text.UTF8Encoding]::new($false, $true)
    $document = ConvertFrom-Json -InputObject $utf8.GetString($originalBytes) -ErrorAction Stop
    if ($document -isnot [pscustomobject] -or $null -eq $document.PSObject.Properties['owner'] -or $document.owner -isnot [string] -or $document.owner -cne $ReplaceFrom) {
      throw 'The held document owner does not match the requested value.'
    }
    $document.owner = $ReplaceTo
    $updatedText = (ConvertTo-Json -InputObject $document -Depth 100 -Compress -ErrorAction Stop) + "`n"
    $updatedBytes = $utf8.GetBytes($updatedText)
    if ($updatedBytes.Length -ne $originalBytes.Length) {
      throw 'The updated document must have the same UTF-8 byte length.'
    }

    $stream.Position = 0
    $stream.Write($updatedBytes, 0, $updatedBytes.Length)
    $stream.Flush($true)
    [System.IO.File]::WriteAllText($changedMarkerPath, 'changed')
  }

  if ($HoldMilliseconds -gt 0) {
    Start-Sleep -Milliseconds $HoldMilliseconds
  }
}
finally {
  $stream.Dispose()
}
