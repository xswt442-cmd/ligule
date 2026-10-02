# 从 assets/app-icon.png 裁出各尺寸图标。源文件是一张 1254x1254 的 PNG，由人工维护；
# 这里只做缩放与打包，不在这儿画图——图标是设计资产，改设计改那张源图。
# 这份文件带 UTF-8 BOM：Windows PowerShell 5.1 按 ANSI 码页读没有 BOM 的 .ps1，
# 中文注释的最后一个字节会与紧随其后的换行配成一字，整行代码被吞进注释里（本机 2026-10-02 实测）。
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File desktop/make-icons.ps1
$ErrorActionPreference = 'Stop'

$source = Join-Path $PSScriptRoot 'assets/app-icon.png'
$icons = Join-Path $PSScriptRoot 'src-tauri/icons'
if (-not (Test-Path $source)) { throw "the icon source is missing: $source" }
New-Item -ItemType Directory -Force -Path $icons | Out-Null

Add-Type -AssemblyName System.Drawing

function Save-Resized([string]$name, [int]$size) {
    $original = [System.Drawing.Image]::FromFile($source)
    $bitmap = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    # 缩得越小越容易被抗锯齿磨平边缘，四周留一点内边距让形状站得住。
    $pad = [int][Math]::Round($size * 0.04)
    $graphics.DrawImage($original, $pad, $pad, ($size - 2 * $pad), ($size - 2 * $pad))
    $graphics.Dispose()
    $bitmap.Save((Join-Path $icons $name), [System.Drawing.Imaging.ImageFormat]::Png)
    $bitmap.Dispose(); $original.Dispose()
}

Save-Resized '32x32.png' 32
Save-Resized '128x128.png' 128
Save-Resized '128x128@2x.png' 256
Save-Resized 'icon.png' 512
# 界面里那一处品牌标记与标签页图标读的是前端目录里的一张 PNG，与打包图标同源，不在两处各画一张。
$frontend = Join-Path $PSScriptRoot 'frontend'
Copy-Item -Force -Path (Join-Path $icons 'icon.png') -Destination (Join-Path $frontend 'icon.png')
if (-not (Test-Path (Join-Path $frontend 'icon.png'))) { throw "the frontend icon did not land in $frontend" }
Write-Output "wrote PNGs to $icons and $frontend/"
