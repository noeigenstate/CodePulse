param([Parameter(Mandatory = $true)][ValidatePattern('^COM[1-9][0-9]*$')][string]$Port)
$ErrorActionPreference = 'Stop'
throw 'Historical 0.0.9 private-package helper is retired. Use the reviewed firmware/doc/DEVELOPMENT.md workflow.'
$firmwareRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$desktopRoot = Join-Path (Split-Path $firmwareRoot) 'CodePulse'
$artifacts = Join-Path $desktopRoot '.tmpshots'
$manifest = Get-Content -Raw -LiteralPath (Join-Path $artifacts 'quiet-wifi-manifest.json') | ConvertFrom-Json
if ($manifest.version -ne '0.0.9-quiet-wifi' -or -not $manifest.hostTestsPassed -or -not $manifest.protocolTestsPassed -or -not $manifest.buildPassed) { throw 'Validated quiet Wi-Fi candidate is missing.' }
$app = Join-Path $artifacts 'quiet-wifi-0.0.9.bin'
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $app).Hash -ne $manifest.appSha256) { throw 'Candidate image hash mismatch.' }
$recovery = Join-Path $artifacts 'smart-refresh-0.0.3-recovery.bin'
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $recovery).Hash -ne $manifest.recoverySha256) { throw 'Recovery image hash mismatch.' }
$partition = Join-Path $firmwareRoot 'build\partition_table\partition-table.bin'
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $partition).Hash -ne $manifest.partitionSha256) { throw 'Partition layout differs.' }
$pythonPath = Join-Path (Split-Path $firmwareRoot) '.toolchains\idf-tools\python_env\idf6.0_py3.11_env\Scripts\python.exe'
Write-Host 'Quiet Wi-Fi dashboard: one cleaning baseline at boot, then PAIR125 partial updates.'
Write-Host 'Hold only function/power continuously. App-only write; NVS preserved; no post-flash reset.'
& $pythonPath -m esptool --chip esp32s3 --port $Port --baud 115200 `
    --before usb-reset --after no-reset write-flash `
    --flash-mode dio --flash-freq 80m --flash-size 16MB 0x10000 $app
if ($LASTEXITCODE -ne 0) { throw 'Flash failed; inspect before retrying.' }
