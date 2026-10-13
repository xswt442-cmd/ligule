$ErrorActionPreference = 'Stop'
$desktopRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$temporaryParent = Join-Path $desktopRoot 'testplace\tmp'
$evidenceRoot = Join-Path $desktopRoot 'testplace\readings\installer-windows'
$version = (Get-Content -LiteralPath (Join-Path $desktopRoot 'package.json') -Raw | ConvertFrom-Json).version
$installer = Join-Path $desktopRoot "release\ligule Setup $version.exe"
$installRoot = Join-Path $temporaryParent ('electron-installed-' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
$resolvedInstallRoot = [IO.Path]::GetFullPath($installRoot)
$expectedPrefix = [IO.Path]::GetFullPath($temporaryParent).TrimEnd('\') + '\'
if (-not $resolvedInstallRoot.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Installer test destination is outside desktop/testplace/tmp.'
}
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) { throw 'NSIS installer is missing.' }

# 已安装且仍存在的用户应用不会成为本测试的升级对象。
$installed = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -eq 'ligule' -and $_.InstallLocation -and (Test-Path -LiteralPath $_.InstallLocation.Trim('"')) }
if ($installed) { throw 'A real Ligule installation exists. The isolated installer test cannot replace it.' }

New-Item -ItemType Directory -Path $temporaryParent, $evidenceRoot -Force | Out-Null
$report = [ordered]@{ version = $version; installerSha256 = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash; installed = $false; runtime = $null; window = $null; uninstalled = $false }
$exitCode = 1
try {
    $installation = Start-Process -FilePath $installer -ArgumentList @('/S', ('/D=' + $installRoot)) -WindowStyle Hidden -PassThru -Wait
    $report.installExit = $installation.ExitCode
    if ($installation.ExitCode -ne 0) { throw 'NSIS installation failed.' }
    if (-not (Test-Path -LiteralPath (Join-Path $installRoot 'ligule.exe'))) { throw 'Installed executable is missing.' }
    $report.installed = $true
    $node = Join-Path $installRoot 'resources\node\node.exe'
    & $node (Join-Path $desktopRoot 'check-runtime.mjs') --resources (Join-Path $installRoot 'resources') *> (Join-Path $evidenceRoot 'runtime.txt')
    $report.runtime = $LASTEXITCODE
    if ($LASTEXITCODE -ne 0) { throw 'Installed runtime self-check failed.' }
    & $node (Join-Path $PSScriptRoot 'run-packaged-smoke.mjs') --app-dir $installRoot *> (Join-Path $evidenceRoot 'window.txt')
    $report.window = $LASTEXITCODE
    if ($LASTEXITCODE -ne 0) { throw 'Installed application smoke check failed.' }
    $exitCode = 0
} catch {
    $report.error = $_.Exception.Message
} finally {
    if ($report.installed) {
        $uninstaller = Join-Path $installRoot 'Uninstall ligule.exe'
        if (Test-Path -LiteralPath $uninstaller -PathType Leaf) {
            $removal = Start-Process -FilePath $uninstaller -ArgumentList '/S' -WindowStyle Hidden -PassThru -Wait
            $report.uninstallExit = $removal.ExitCode
            for ($attempt = 0; $attempt -lt 50 -and (Test-Path -LiteralPath (Join-Path $installRoot 'ligule.exe')); $attempt++) {
                Start-Sleep -Milliseconds 200
            }
            $report.uninstalled = -not (Test-Path -LiteralPath (Join-Path $installRoot 'ligule.exe'))
            if (-not $report.uninstalled -or $removal.ExitCode -ne 0) { $exitCode = 1 }
        } else {
            $report.uninstallError = 'The installed uninstaller is missing.'
            $exitCode = 1
        }
    }
    $report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $evidenceRoot 'report.json') -Encoding utf8
}
Get-Content -LiteralPath (Join-Path $evidenceRoot 'report.json')
exit $exitCode
