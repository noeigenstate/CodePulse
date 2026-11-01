param([Parameter(Mandatory = $true)][ValidatePattern('^COM[1-9][0-9]*$')][string]$Port)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\..\scripts\idf-env.ps1')
$desktopRoot = Join-Path (Split-Path $FirmwareRoot) 'CodePulse'
$probeBuild = Join-Path $desktopRoot '.tmpshots\waveform-probe-build'
$manifestPath = Join-Path $desktopRoot '.tmpshots\panel-research\waveform-probe-build-manifest.json'
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
$app = Join-Path $probeBuild 'codepulse_bringup.bin'
$recovery = Join-Path $desktopRoot '.tmpshots\smart-refresh-0.0.3-recovery.bin'
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $app).Hash -ne $manifest.probeSha256) {
    throw 'Probe image changed since validation.'
}
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $recovery).Hash -ne $manifest.recoverySha256) {
    throw 'Verified recovery application is missing or changed.'
}
foreach ($partitionPath in @((Join-Path $probeBuild 'partition_table\partition-table.bin'),
                            (Join-Path $FirmwareRoot 'build\partition_table\partition-table.bin'))) {
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $partitionPath).Hash -ne $manifest.partitionSha256) {
        throw 'Partition layout changed; do not flash this experiment.'
    }
}
Write-Host 'EXPERIMENT: replaces Wi-Fi dashboard with manual ZERO effectiveness check, then conditional HALF-repeat test; no startup refresh.'
Write-Host 'Hold ONLY the function/power button continuously. Do not press BOOT.'
Write-Host 'Writes application only; retains existing bootloader, partition table and NVS.'
& $IdfPython -m esptool --chip esp32s3 --port $Port --baud 115200 `
    --before usb-reset --after no-reset write-flash `
    --flash-mode dio --flash-freq 80m --flash-size 16MB 0x10000 $app
if ($LASTEXITCODE -ne 0) { throw 'Probe flash failed; inspect before retrying.' }
Write-Host 'Release fully for power-off, then hold about 3 seconds to boot and release.'
