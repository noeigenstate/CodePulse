param([Parameter(Mandatory = $true)][ValidatePattern('^COM[1-9][0-9]*$')][string]$Port)
$ErrorActionPreference = 'Stop'
$firmwareRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$desktopRoot = Join-Path (Split-Path $firmwareRoot) 'CodePulse'
$buildRoot = Join-Path $desktopRoot '.tmpshots\quiet-probe-build'
$manifest = Get-Content -Raw -LiteralPath (Join-Path $desktopRoot '.tmpshots\panel-research\quiet-probe-build-manifest.json') | ConvertFrom-Json
$app = Join-Path $buildRoot 'codepulse_bringup.bin'
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $app).Hash -ne $manifest.probeSha256) { throw 'Probe image changed after validation.' }
$recovery = Join-Path $desktopRoot '.tmpshots\smart-refresh-0.0.3-recovery.bin'
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $recovery).Hash -ne $manifest.recoverySha256) { throw 'Verified recovery image missing or changed.' }
foreach ($part in @((Join-Path $buildRoot 'partition_table\partition-table.bin'), (Join-Path $firmwareRoot 'build\partition_table\partition-table.bin'))) {
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $part).Hash -ne $manifest.partitionSha256) { throw 'Partition layout differs.' }
}
$pythonPath = Join-Path (Split-Path $firmwareRoot) '.toolchains\idf-tools\python_env\idf6.0_py3.11_env\Scripts\python.exe'
Write-Host 'Manual experiment v2: one OTP baseline, row A reference, row B longer pair; no startup refresh.'
Write-Host 'Hold only function/power button continuously. Writes application only; no automatic post-flash reset.'
& $pythonPath -m esptool --chip esp32s3 --port $Port --baud 115200 `
    --before usb-reset --after no-reset write-flash `
    --flash-mode dio --flash-freq 80m --flash-size 16MB 0x10000 $app
if ($LASTEXITCODE -ne 0) { throw 'Flash failed; inspect before retrying.' }
