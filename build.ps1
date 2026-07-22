# build.ps1 — Build (Angular) and publish the ATML File Manager webapp.
#
# Builds the Angular app in atml-ng/, packs its production output into a
# workspace-local package at dist/ATMLFileManager.nipkg (a copy of the latest
# build is always kept there), then publishes that exact package to SystemLink.
#
# Usage:
#   ./build.ps1                 # build + pack + publish to the demo webapp
#   ./build.ps1 -NoPublish      # build + pack only (keep the package)
param(
    [string]$WebappId = '9206728f-81e4-49ec-9bf5-ae8215b8be28',
    [string]$AppDir   = 'atml-ng',
    [string]$Output   = 'dist/ATMLFileManager.nipkg',
    [switch]$NoPublish
)

# Native tools (npm/ng) emit warnings to stderr; don't treat those as fatal.
# We gate on $LASTEXITCODE after each external command instead.
$ErrorActionPreference = 'Continue'

Write-Host "Building Angular app in '$AppDir'..."
Push-Location $AppDir
try {
    npm run build
    if ($LASTEXITCODE -ne 0) { Pop-Location; throw "Angular build failed (exit $LASTEXITCODE)." }
}
finally {
    if ((Get-Location).Path -like "*$AppDir") { Pop-Location }
}

$content = Join-Path $AppDir 'dist/atmlfilemanager/browser'
if (-not (Test-Path $content)) {
    # Fallback if the builder emits without a browser/ subdirectory.
    $content = Join-Path $AppDir 'dist/atmlfilemanager'
}

$outDir = Split-Path -Parent $Output
if ($outDir) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }

Write-Host "Packing '$content' -> '$Output'..."
slcli webapp pack $content --output $Output
if ($LASTEXITCODE -ne 0) { throw "Pack failed (exit $LASTEXITCODE)." }

if ($NoPublish) {
    Write-Host "Packed only (-NoPublish). Latest package kept at '$Output'."
    return
}

Write-Host "Publishing '$Output' to webapp $WebappId..."
slcli webapp publish $Output --id $WebappId
if ($LASTEXITCODE -ne 0) { throw "Publish failed (exit $LASTEXITCODE)." }

Write-Host "Done. Latest package kept at '$Output'."
