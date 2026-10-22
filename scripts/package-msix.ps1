<#
.SYNOPSIS
  Builds the Microsoft Store package (MSIX) for Leggimi.

.DESCRIPTION
  1. Runs the Tauri release build (skip with -SkipBuild when target\release\leggimi.exe is current).
  2. Stages the exe, the MSIX assets and the template of File Explorer's New > Markdown document
     in src-tauri\target\msix\layout.
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

.PARAMETER DevIdentity
  Build a signed test package that installs next to the Store copy, to try the manifest
  (File Explorer's New menu, file types, languages) without touching it: identity
  EnricoDeStefanis.Leggimi.Dev, display name "Leggimi Dev", no `leggimi` command (that stays
  the Store copy's), its own .msix file. Both copies share the single-instance name, so close
  the Store copy before starting this one, or the launch goes to it.
  Install it with Add-AppxPackage <file>; remove it with
  Get-AppxPackage EnricoDeStefanis.Leggimi.Dev | Remove-AppxPackage

.EXAMPLE
  npm run package:msix
  npm run package:msix -- -SkipBuild -Sign
  npm run package:msix -- -SkipBuild -DevIdentity
#>
[CmdletBinding()]
param(
  [switch]$SkipBuild,
  [switch]$Sign,
  [switch]$DevIdentity
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# a package made to be installed must be signed
if ($DevIdentity) { $Sign = $true }

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
# What New > Markdown document in File Explorer copies (uap4:ShellNewFileName): a new
# document starts empty.
New-Item -ItemType Directory -Force "$layout\ShellNew" | Out-Null
[IO.File]::WriteAllBytes("$layout\ShellNew\New.md", [byte[]]@())

$manifest = Get-Content "$root\src-tauri\msix\Package.appxmanifest" -Raw
# Only the Identity's Version attribute: MinVersion/MaxVersionTested also end in Version="...".
$manifest = $manifest -replace '(?<=\s)Version="\d+\.\d+\.\d+\.\d+"', "Version=`"$msixVersion`""

if ($DevIdentity) {
  # Another name installs next to the Store copy (same publisher, so the same development
  # certificate signs it); without the execution alias, `leggimi` in a terminal still
  # starts the Store copy.
  $doc = New-Object Xml.XmlDocument
  $doc.PreserveWhitespace = $true
  $doc.LoadXml($manifest)
  $ns = New-Object Xml.XmlNamespaceManager $doc.NameTable
  $ns.AddNamespace("m", "http://schemas.microsoft.com/appx/manifest/foundation/windows10")
  $ns.AddNamespace("uap", "http://schemas.microsoft.com/appx/manifest/uap/windows10")
  $ns.AddNamespace("uap5", "http://schemas.microsoft.com/appx/manifest/uap/windows10/5")
  $doc.SelectSingleNode("/m:Package/m:Identity", $ns).SetAttribute("Name", "EnricoDeStefanis.Leggimi.Dev")
  $doc.SelectSingleNode("/m:Package/m:Properties/m:DisplayName", $ns).InnerText = "Leggimi Dev"
  $doc.SelectSingleNode("//uap:VisualElements", $ns).SetAttribute("DisplayName", "Leggimi Dev")
  $alias = $doc.SelectSingleNode("//uap5:Extension[@Category='windows.appExecutionAlias']", $ns)
  if (-not $alias) { throw "The manifest has no execution alias to remove" }
  [void]$alias.ParentNode.RemoveChild($alias)
  $manifest = $doc.OuterXml
}
[IO.File]::WriteAllText("$layout\Package.appxmanifest", $manifest, (New-Object Text.UTF8Encoding $false))

# Named as winapp names packages, after the identity: the Store package and the Dev one sit
# side by side, and each run replaces only the packages of its own identity.
$identity = ([xml]$manifest).Package.Identity
$msix = "$out\$($identity.Name)_${msixVersion}_$($identity.ProcessorArchitecture).msix"
Get-ChildItem $out -Filter "$($identity.Name)_*.msix" -ErrorAction SilentlyContinue | Remove-Item -Force

$args = @("package", $layout, "--manifest", "$layout\Package.appxmanifest", "--output", $msix, "--quiet")
if ($Sign) {
  $cert = "$root\src-tauri\msix\devcert.pfx"
  if (-not (Test-Path $cert)) {
    Write-Host "Generating development certificate..." -ForegroundColor Cyan
    winapp cert generate --manifest "$root\src-tauri\msix\Package.appxmanifest" --output $cert --quiet
    if ($LASTEXITCODE -ne 0) { throw "certificate generation failed" }
  }
  $args += @("--cert", $cert)
}

Write-Host "Packaging $($identity.Name) $msixVersion..." -ForegroundColor Cyan
Push-Location $out
try {
  & winapp @args
  if ($LASTEXITCODE -ne 0) { throw "winapp package failed" }
} finally {
  Pop-Location
}

if (-not (Test-Path $msix)) { throw "No .msix produced at $msix" }
$size = (Get-Item $msix).Length
Write-Host "Done: $msix ($([math]::Round($size / 1MB, 1)) MB)" -ForegroundColor Green
if ($DevIdentity) {
  Write-Host "Test package: Add-AppxPackage `"$msix`"  (remove: Get-AppxPackage $($identity.Name) | Remove-AppxPackage)"
} elseif (-not $Sign) {
  Write-Host "Unsigned package for Store submission. Use -Sign for a locally installable build."
}
