# Publish the current build as a GitHub release, with its signature.
#
#   powershell -ExecutionPolicy Bypass -File tools\release.ps1 -Notes notes.md
#
# Run tools\build.ps1 first. This refuses to publish a zip whose signature is
# missing or does not verify, because installed copies would then refuse it -
# a release that looks fine on GitHub but never reaches anyone.

param([Parameter(Mandatory = $true)][string]$Notes)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$py = Join-Path $root ".venv\Scripts\python.exe"
$gh = Join-Path $env:ProgramFiles "GitHub CLI\gh.exe"

$version = (& $py -c "import sys; sys.path.insert(0, r'$root'); import glitchguard; print(glitchguard.__version__)").Trim()
$zip = Join-Path $root "dist\GlitchGuard-$version-portable.zip"
if (-not (Test-Path $zip)) { throw "No build for $version at $zip - run tools\build.ps1" }
if (-not (Test-Path "$zip.sig")) { throw "$zip is not signed - installed copies would not install it" }

& $py (Join-Path $root "tools\sign.py") verify $zip
if ($LASTEXITCODE -ne 0) { throw "The signature does not verify - not publishing" }

& $gh release create "v$version" $zip "$zip.sig" --repo Niick-pixel/price-error-hunter `
    --target main --title "GlitchGuard $version" --notes-file $Notes --latest
if ($LASTEXITCODE -ne 0) { throw "gh release create failed" }
