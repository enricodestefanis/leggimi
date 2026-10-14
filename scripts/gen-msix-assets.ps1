# Generates the qualified MSIX asset variants from the icon master.
#
# Why this exists: Windows 11 picks Square44x44Logo.targetsize-N_altform-unplated
# for the taskbar, Start and Alt+Tab. Without those files it falls back to the
# plain logo and plates it on the manifest BackgroundColor -- which, when that is
# "transparent", means the system accent colour: the icon ends up on a blue
# square. Explorer wants the same variants for the .md file-type icon.
#
# winapp's PRI indexer is configured with filenameAsQualifier and "." as the
# delimiter, so dropping these names into Assets\ is all it takes --
# package-msix.ps1 copies Assets\*.png with a wildcard.
#
# Only downscales: the master is 512x512, so nothing here is ever upscaled.
#
#   npm run gen:icons        (or: powershell -File scripts\gen-msix-assets.ps1)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$master = Join-Path $root "src-tauri\icons\icon.png"
$outDir = Join-Path $root "src-tauri\msix\Assets"

if (-not (Test-Path $master)) { throw "Icon master not found: $master" }
if (-not (Test-Path $outDir)) { throw "Assets folder not found: $outDir" }

$src = [System.Drawing.Image]::FromFile($master)
Write-Host ("Master: {0} ({1}x{2})" -f $master, $src.Width, $src.Height)

function Write-Variant {
    param([string]$Name, [int]$Size)

    if ($Size -gt $src.Width) {
        Write-Host ("  skipped {0}: {1}px exceeds the {2}px master" -f $Name, $Size, $src.Width)
        return
    }
    $bmp = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $bmp.SetResolution(96, 96)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
        $g.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
        $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        # TileFlipXY stops the resampler from bleeding transparent pixels in at the edges
        $attr = New-Object System.Drawing.Imaging.ImageAttributes
        $attr.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY)
        $rect = New-Object System.Drawing.Rectangle(0, 0, $Size, $Size)
        $g.DrawImage($src, $rect, 0, 0, $src.Width, $src.Height, [System.Drawing.GraphicsUnit]::Pixel, $attr)
        $attr.Dispose()
    } finally {
        $g.Dispose()
    }
    $bmp.Save((Join-Path $outDir $Name), [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
}

# The taskbar, Start, Alt+Tab and Explorer sizes. The artwork carries its own
# rounded plate, so the unplated variants are the same image: what they buy is
# Windows not drawing a second plate underneath.
$targetSizes = 16, 20, 24, 30, 32, 36, 40, 48, 56, 60, 64, 72, 80, 96, 256
$count = 0
foreach ($s in $targetSizes) {
    foreach ($suffix in @("", "_altform-unplated", "_altform-lightunplated")) {
        Write-Variant -Name ("Square44x44Logo.targetsize-{0}{1}.png" -f $s, $suffix) -Size $s
        $count++
    }
}

# Per-DPI tiles, so Windows never has to resample a single neutral bitmap.
$scales = @{ 100 = 1.0; 125 = 1.25; 150 = 1.5; 200 = 2.0; 400 = 4.0 }
$tiles = @{ "Square44x44Logo" = 44; "Square71x71Logo" = 71; "Square150x150Logo" = 150; "StoreLogo" = 50 }
foreach ($tile in $tiles.Keys) {
    foreach ($scale in ($scales.Keys | Sort-Object)) {
        $px = [int][Math]::Round($tiles[$tile] * $scales[$scale])
        Write-Variant -Name ("{0}.scale-{1}.png" -f $tile, $scale) -Size $px
        $count++
    }
}

$src.Dispose()
$made = (Get-ChildItem $outDir -Filter *.png).Count
Write-Host ("Done: {0} variants requested, {1} PNGs now in {2}" -f $count, $made, $outDir)
