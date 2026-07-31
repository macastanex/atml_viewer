# build.ps1 — Build (pack) and publish the ATML File Manager webapp.
#
# Packs the app into a Plugin Manager package at dist/ATMLFileManager.nipkg using
# the full manifest (nipkg.config.json) so it can be published to the SystemLink
# Plugin Manager. A copy of the latest build is always kept in dist/.
#
# Usage:
#   ./build.ps1                 # pack + publish to the demo webapp
#   ./build.ps1 -NoPublish      # pack only (keep the package, don't publish)
param(
    [string]$WebappId = '9206728f-81e4-49ec-9bf5-ae8215b8be28',
    [string]$Config   = 'nipkg.config.json',
    [string]$Output   = 'dist/ATMLFileManager.nipkg',
    [switch]$NoPublish
)

$ErrorActionPreference = 'Stop'

$outDir = Split-Path -Parent $Output
if ($outDir) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }

Write-Host "Building web app (npm run build)..."
npm run build
if ($LASTEXITCODE -ne 0) { throw "npm run build failed (exit $LASTEXITCODE)." }

Write-Host "Packing (Plugin Manager) via '$Config' -> '$Output'..."
slcli webapp pack --config $Config --output $Output

if ($NoPublish) {
    Write-Host "Packed only (‑NoPublish). Latest package kept at '$Output'."
    return
}

Write-Host "Publishing '$Output' to webapp $WebappId..."
slcli webapp publish $Output --id $WebappId

Write-Host "Done. Latest package kept at '$Output'."
