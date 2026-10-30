param(
    [Parameter(Mandatory = $true)][string]$Zig,
    [string]$Python = 'python',
    [Parameter(Mandatory = $true)][string]$Firmware
)
$ErrorActionPreference = 'Stop'
$workspace = Split-Path $PSScriptRoot -Parent
$firmwareRoot = (Resolve-Path -LiteralPath $Firmware).Path
$output = Join-Path $workspace '.tmpshots/device-preview-build'
# Never ship leftovers from an earlier build; the compiler cache stays.
foreach ($name in @('renderer.wasm', 'renderer.b64', 'manifest.json', 'THIRD-PARTY-FONTS.txt')) {
    Remove-Item -LiteralPath (Join-Path $output $name) -Force -ErrorAction SilentlyContinue
}
& $Python (Join-Path $firmwareRoot 'scripts/build-preview.py') --zig $Zig --output $output
if ($LASTEXITCODE -ne 0) { throw 'Device renderer compilation failed; assets were not updated.' }
$notices = Join-Path $output 'THIRD-PARTY-FONTS.txt'
if (-not (Test-Path -LiteralPath $notices)) { throw 'The renderer build did not produce THIRD-PARTY-FONTS.txt; assets were not updated.' }
$targets = @('desktop', 'hud') | ForEach-Object { Join-Path $workspace "apps/$_/src/renderer/src/device-preview" }
foreach ($target in $targets) {
    if (-not (Test-Path -LiteralPath $target)) { throw "Missing desktop preview directory: $target" }
}
foreach ($target in $targets) {
    Copy-Item -LiteralPath (Join-Path $output 'renderer.wasm') -Destination $target
    Copy-Item -LiteralPath (Join-Path $output 'renderer.b64') -Destination $target
    Copy-Item -LiteralPath (Join-Path $output 'manifest.json') -Destination $target
    # The embedded fonts' licenses travel with the renderer: shipped as a resource and served next to the app.
    Copy-Item -LiteralPath $notices -Destination (Join-Path $target 'THIRD-PARTY-NOTICES.txt')
    Copy-Item -LiteralPath $notices -Destination (Join-Path $target '../../public/device-preview-licenses.txt')
}
Write-Output 'Both desktop configuration previews now use the firmware renderer. No app was started and no device was accessed.'
