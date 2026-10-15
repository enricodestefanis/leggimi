# Builds the portable zip for a GitHub release: the release exe plus the marker
# file that makes it keep its data next to itself (see portable_data_dir in
# src-tauri/src/lib.rs). Run after `npm run tauri build`.
#
#   npm run package:portable
#
# Output: src-tauri\target\release\bundle\portable\Leggimi_<version>_x64-portable.zip
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$version = (Get-Content "$root\package.json" -Raw | ConvertFrom-Json).version
$exe = "$root\src-tauri\target\release\leggimi.exe"
if (-not (Test-Path $exe)) { throw "Build first: $exe not found" }

$out = "$root\src-tauri\target\release\bundle\portable"
$stage = "$out\stage\Leggimi"
if (Test-Path "$out\stage") { Remove-Item -Recurse -Force "$out\stage" }
New-Item -ItemType Directory -Force $stage | Out-Null

Copy-Item $exe "$stage\Leggimi.exe"
@"
This file makes Leggimi portable: settings, recent files and reading positions
are kept in the "data" folder next to Leggimi.exe instead of the user profile.
Delete this file to use the regular per-user location.
"@ | Set-Content -Encoding utf8 "$stage\leggimi-portable.txt"
@"
Leggimi $version - portable build

Unzip anywhere you can write to (a USB stick, a projects folder) and run
Leggimi.exe. Nothing is installed: no file association, no Start menu entry.
Open files with Ctrl+O, by dropping them on the window, or from a terminal:

    Leggimi.exe path\to\file.md [--line N]

Source code and releases: https://github.com/enricodestefanis/leggimi
"@ | Set-Content -Encoding utf8 "$stage\README.txt"

$zip = "$out\Leggimi_${version}_x64-portable.zip"
if (Test-Path $zip) { Remove-Item -Force $zip }
Compress-Archive -Path "$stage\*" -DestinationPath $zip -CompressionLevel Optimal
Remove-Item -Recurse -Force "$out\stage"
Write-Host "Done: $zip ($([math]::Round((Get-Item $zip).Length / 1MB, 1)) MB)" -ForegroundColor Green
