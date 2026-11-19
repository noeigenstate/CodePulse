param([string]$Output)
$ErrorActionPreference = 'Stop'
$experiment = $PSScriptRoot
$firmware = (Resolve-Path -LiteralPath (Join-Path $experiment '../..')).Path
if (-not (Get-Command cl.exe -ErrorAction SilentlyContinue)) {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
    $vsRoot = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if (-not $vsRoot) { throw 'MSVC C compiler is required.' }
    $vcvars = Join-Path $vsRoot 'VC/Auxiliary/Build/vcvars64.bat'
    $compilerEnvironment = & $env:ComSpec /d /c ('call "' + $vcvars + '" >nul && set')
    if ($LASTEXITCODE -ne 0) { throw 'MSVC activation failed.' }
    foreach ($entry in $compilerEnvironment) {
        if ($entry -match '^([^=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process') }
    }
}
$out = if ($Output) { [IO.Path]::GetFullPath($Output) } else { Join-Path $firmware 'build-red-lut-host' }
$common = @('/nologo','/std:c11','/utf-8','/W4','/WX','/D_CRT_SECURE_NO_WARNINGS',
    ('/I'+$firmware+'/experiments/epd-quiet-probe/tests'),('/I'+$firmware+'/main'),('/I'+$experiment),('/I'+$firmware+'/tests'))
foreach($mode in @('debug','ndebug')) {
    $destination = Join-Path $out $mode
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    Push-Location -LiteralPath $destination
    try {
        [string[]]$defines = if($mode -eq 'ndebug') { @('/DNDEBUG') } else { @() }
        & cl.exe @common @defines ('/I'+$firmware+'/tests/panel/include') ($experiment+'/tests/test_driver.c') ($experiment+'/red_lut_pattern.c') ($firmware+'/main/epd_canvas.c') /Fe:test-driver.exe *> driver-build.log
        if($LASTEXITCODE -ne 0) { Get-Content driver-build.log; throw 'Red LUT driver test compile failed' }
        & .\test-driver.exe
        if($LASTEXITCODE -ne 0) { throw 'Red LUT driver test failed' }
        & cl.exe ('/I'+$firmware+'/experiments/epd-red-region-probe/tests/stubs') @common @defines ($experiment+'/tests/test_control.c') ($experiment+'/red_lut_probe.c') ($experiment+'/red_lut_pattern.c') ($firmware+'/main/epd_canvas.c') /Fe:test-control.exe *> control-build.log
        if($LASTEXITCODE -ne 0) { Get-Content control-build.log; throw 'Red LUT control test compile failed' }
        & .\test-control.exe
        if($LASTEXITCODE -ne 0) { throw 'Red LUT control test failed' }
    } finally { Pop-Location }
}
foreach($frame in 0..2) {
    $a=(Get-FileHash -LiteralPath (Join-Path $out "debug/frame-$frame.ppm")).Hash
    $b=(Get-FileHash -LiteralPath (Join-Path $out "ndebug/frame-$frame.ppm")).Hash
    if($a -ne $b) { throw "NDEBUG frame mismatch: $frame" }
}
Write-Host 'Register-BWR candidate passed Debug/NDEBUG. Hardware optics remain unverified.'
