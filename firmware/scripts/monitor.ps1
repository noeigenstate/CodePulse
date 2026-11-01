param(
    [Parameter(Mandatory = $true)][ValidatePattern('^COM[1-9][0-9]*$')][string]$Port,
    [string]$BuildDirectory = 'build'
)
. (Join-Path $PSScriptRoot 'idf-env.ps1')
$buildPath = if ([System.IO.Path]::IsPathRooted($BuildDirectory)) { $BuildDirectory } else { Join-Path $FirmwareRoot $BuildDirectory }
Write-Host 'Normal power-on: hold the function/power button for 3 seconds. Quit with Ctrl+].'
& $IdfPython (Join-Path $env:IDF_PATH 'tools\idf.py') -C $FirmwareRoot -B $buildPath -p $Port monitor --no-reset
exit $LASTEXITCODE
