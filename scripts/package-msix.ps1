<#
.SYNOPSIS
  Builds the Microsoft Store package (MSIX) for Leggimi.

.DESCRIPTION
  1. Runs the Tauri release build (skip with -SkipBuild when target\release\leggimi.exe is current).
  2. Stages the exe and the MSIX assets in src-tauri\target\msix\layout.
  3. Stamps the version from package.json into the manifest (x.y.z -> x.y.z.0).
  4. Runs `winapp package`, which writes the .msix next to the layout folder.

  The Store re-signs the package during certification, so the default output is unsigned.
  Pass -Sign to also produce a locally installable package signed with a development
  certificate (src-tauri\msix\devcert.pfx, generated on first use). The certificate must be
  trusted once, from an elevated prompt:  winapp cert install src-tauri\msix\devcert.pfx

.PARAMETER SkipBuild
  Reuse the existing release exe instead of running `npm run tauri build`.

.PARAMETER Sign
  Sign the package with the development certificate for local testing.

.EXAMPLE
  npm run package:msix
  npm run package:msix -- -SkipBuild -Sign
#>
[CmdletBinding()]
param(
  [switch]$SkipBuild,
  [switch]$Sign
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not (Get-Command winapp -ErrorAction SilentlyContinue)) {
  throw "winapp CLI not found. Install it with: winget install Microsoft.WinAppCli"
}

$version = (Get-Content "$root\package.json" -Raw | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw "Unexpected version '$version' in package.json" }
$msixVersion = "$version.0"

if (-not $SkipBuild) {
  Write-Host "Building release..." -ForegroundColor Cyan
  npm run tauri -- build
  if ($LASTEXITCODE -ne 0) { throw "tauri build failed" }
}

$exe = "$root\src-tauri\target\release\leggimi.exe"
if (-not (Test-Path $exe)) { throw "Release exe not found at $exe" }

$out = "$root\src-tauri\target\msix"
$layout = "$out\layout"
if (Test-Path $layout) { Remove-Item $layout -Recurse -Force }
New-Item -ItemType Directory -Force "$layout\Assets" | Out-Null
Copy-Item $exe $layout
Copy-Item "$root\src-tauri\msix\Assets\*.png" "$layout\Assets"

$manifest = Get-Content "$root\src-tauri\msix\Package.appxmanifest" -Raw
$manifest = $manifest -replace 'Version="\d+\.\d+\.\d+\.\d+"', "Version=`"$msixVersion`""
[IO.File]::WriteAllText("$layout\Package.appxmanifest", $manifest, (New-Object Text.UTF8Encoding $false))

Get-ChildItem $out -Filter *.msix -ErrorAction SilentlyContinue | Remove-Item -Force

$args = @("package", $layout, "--manifest", "$layout\Package.appxmanifest", "--quiet")
if ($Sign) {
  $cert = "$root\src-tauri\msix\devcert.pfx"
  if (-not (Test-Path $cert)) {
    Write-Host "Generating development certificate..." -ForegroundColor Cyan
    winapp cert generate --manifest "$root\src-tauri\msix\Package.appxmanifest" --output $cert --quiet
    if ($LASTEXITCODE -ne 0) { throw "certificate generation failed" }
  }
  $args += @("--cert", $cert)
}

Write-Host "Packaging Leggimi $msixVersion..." -ForegroundColor Cyan
Push-Location $out
try {
  & winapp @args
  if ($LASTEXITCODE -ne 0) { throw "winapp package failed" }
} finally {
  Pop-Location
}

$msix = Get-ChildItem $out -Filter *.msix | Select-Object -First 1
if (-not $msix) { throw "No .msix produced in $out" }
Write-Host "Done: $($msix.FullName) ($([math]::Round($msix.Length / 1MB, 1)) MB)" -ForegroundColor Green
if (-not $Sign) { Write-Host "Unsigned package for Store submission. Use -Sign for a locally installable build." }
