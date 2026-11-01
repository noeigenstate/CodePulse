param([string]$BuildDirectory = 'build')
. (Join-Path $PSScriptRoot 'idf-env.ps1')
$buildPath = if ([System.IO.Path]::IsPathRooted($BuildDirectory)) { $BuildDirectory } else { Join-Path $FirmwareRoot $BuildDirectory }
& $IdfPython (Join-Path $env:IDF_PATH 'tools\idf.py') -C $FirmwareRoot -B $buildPath build
exit $LASTEXITCODE
