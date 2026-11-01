param([Parameter(Mandatory = $true)][ValidatePattern('^COM[1-9][0-9]*$')][string]$Port)
. (Join-Path $PSScriptRoot 'idf-env.ps1')
foreach ($image in @('build\bootloader\bootloader.bin', 'build\partition_table\partition-table.bin', 'build\codepulse_bringup.bin')) {
    if (-not (Test-Path -LiteralPath (Join-Path $FirmwareRoot $image))) { throw "Missing $image. Run scripts\build.ps1 first." }
}
Write-Host 'Hold ONLY the function/power button throughout flashing. Do not press BOOT.'
Write-Host 'Uses the original USB download reset, then leaves the board unreset. NVS is retained.'
Push-Location -LiteralPath $FirmwareRoot
try {
    & $IdfPython -m esptool --chip esp32s3 --port $Port --baud 115200 --before usb-reset --after no-reset write-flash --flash-mode dio --flash-freq 80m --flash-size 16MB 0x0 build/bootloader/bootloader.bin 0x8000 build/partition_table/partition-table.bin 0x10000 build/codepulse_bringup.bin
    if ($LASTEXITCODE -ne 0) { throw 'Flash failed. Keep the board powered while inspecting the error.' }
} finally { Pop-Location }
Write-Host 'Release the function button fully to turn the board off, then start monitor.ps1 and hold for 3 seconds to boot normally.'
