param(
    [Parameter(Mandatory = $true)][string]$Zig,
    [string]$Python = 'python',
    [Parameter(Mandatory = $true)][string]$Firmware
)
$ErrorActionPreference = 'Stop'
$workspace = Split-Path $PSScriptRoot -Parent
$firmwareRoot = (Resolve-Path -LiteralPath $Firmware).Path
$output = Join-Path $workspace '.tmpshots/device-preview-build'
& $Python (Join-Path $firmwareRoot 'scripts/build-preview.py') --zig $Zig --output $output
if ($LASTEXITCODE -ne 0) { throw 'Device renderer compilation failed; assets were not updated.' }
$targets = @('desktop', 'hud') | ForEach-Object { Join-Path $workspace "apps/$_/src/renderer/src/device-preview" }
foreach ($target in $targets) {
    if (-not (Test-Path -LiteralPath $target)) { throw "Missing desktop preview directory: $target" }
}
foreach ($target in $targets) {
    Copy-Item -LiteralPath (Join-Path $output 'renderer.wasm') -Destination $target
    Copy-Item -LiteralPath (Join-Path $output 'renderer.b64') -Destination $target
    Copy-Item -LiteralPath (Join-Path $output 'manifest.json') -Destination $target
}
Write-Output 'Both desktop configuration previews now use the firmware renderer. No app was started and no device was accessed.'
