# build.ps1 — Build (pack) and publish the ATML File Manager webapp.
#
# Packs the webapp folder into a workspace-local package at dist/ATMLFileManager.nipkg
# (a copy of the latest build is always kept there) and then publishes that
# exact package to the SystemLink WebApp service.
#
# Usage:
#   ./build.ps1                 # pack + publish to the demo webapp
#   ./build.ps1 -NoPublish      # pack only (keep the package, don't publish)
param(
    [string]$WebappId = '9206728f-81e4-49ec-9bf5-ae8215b8be28',
    [string]$Source   = 'webapp',
    [string]$Output   = 'dist/ATMLFileManager.nipkg',
    [switch]$NoPublish
)

$ErrorActionPreference = 'Stop'

$outDir = Split-Path -Parent $Output
if ($outDir) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }

Write-Host "Packing '$Source' -> '$Output'..."
slcli webapp pack $Source --output $Output

if ($NoPublish) {
    Write-Host "Packed only (‑NoPublish). Latest package kept at '$Output'."
    return
}

Write-Host "Publishing '$Output' to webapp $WebappId..."
slcli webapp publish $Output --id $WebappId

Write-Host "Done. Latest package kept at '$Output'."
