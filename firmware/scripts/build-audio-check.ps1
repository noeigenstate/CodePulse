param([string]$BuildDirectory = 'build-audio-check', [switch]$SpeakerOnly)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'idf-env.ps1')
$build = [IO.Path]::GetFullPath((Join-Path $FirmwareRoot $BuildDirectory))
if (-not $build.StartsWith($FirmwareRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Use a dedicated build directory inside the firmware repository.'
}
New-Item -ItemType Directory -Path $build -Force | Out-Null
$inputFlag = if ($SpeakerOnly) { 'OFF' } else { 'ON' }
& $IdfPython (Join-Path $env:IDF_PATH 'tools/idf.py') -C $FirmwareRoot -B $build `
    -D "SDKCONFIG=$build/sdkconfig" `
    -D "SDKCONFIG_DEFAULTS=$FirmwareRoot/sdkconfig.defaults;$FirmwareRoot/sdkconfig.defaults.audio" `
    -D IDF_TARGET=esp32s3 -D CODEPULSE_AUDIO_ENABLED=ON -D "CODEPULSE_AUDIO_INPUT_ENABLED=$inputFlag" `
    -D CODEPULSE_AUDIO_COMPILE_TEST=ON -D CODEPULSE_AUDIO_PINS_CONFIRMED=OFF reconfigure
if ($LASTEXITCODE -ne 0) { throw 'Audio check configuration failed.' }
& cmake --build $build --parallel 2
if ($LASTEXITCODE -ne 0) { throw 'Audio check build failed.' }
Write-Output 'Compile-only audio image: hardware initialization is disabled. No device was accessed or flashed.'
