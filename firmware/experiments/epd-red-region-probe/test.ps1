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
$out = if ($Output) { [IO.Path]::GetFullPath($Output) } else { Join-Path $firmware 'build-red-region-host' }
$common = @('/nologo','/std:c11','/utf-8','/W4','/WX','/D_CRT_SECURE_NO_WARNINGS',
    ('/I'+$experiment+'/tests/stubs'),('/I'+$firmware+'/experiments/epd-quiet-probe/tests'),
    ('/I'+$firmware+'/main'),('/I'+$experiment),('/I'+$firmware+'/tests'))
foreach($profile in @('bwr','bw-only','red-change')) {
foreach($mode in @('debug','ndebug')) {
    $destination = Join-Path $out "$profile/$mode"
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    Push-Location -LiteralPath $destination
    try {
        [string[]]$defines = if($mode -eq 'ndebug') { @('/DNDEBUG') } else { @() }
        if($profile -eq 'bw-only') { $defines += '/DCODEPULSE_EPD_RED_BW_ONLY=1' }
        if($profile -eq 'red-change') { $defines += '/DCODEPULSE_EPD_RED_RETAINED=1' }
        $driverTest = if($profile -eq 'red-change') { '/tests/test_retained_driver.c' } else { '/tests/test_driver.c' }
        & cl.exe @common @defines ($experiment+$driverTest) ($experiment+'/red_pattern.c') ($firmware+'/main/epd_canvas.c') /Fe:test-driver.exe *> driver-build.log
        if($LASTEXITCODE -ne 0) { Get-Content driver-build.log; throw ('Red-region driver test compile failed: exit=' + $LASTEXITCODE) }
        & .\test-driver.exe
        if($LASTEXITCODE -ne 0) { throw 'Red-region driver safety test failed' }
        & cl.exe @common @defines ($experiment+'/tests/test_control.c') ($experiment+'/red_probe.c') ($experiment+'/red_pattern.c') ($firmware+'/main/epd_canvas.c') /Fe:test-control.exe *> control-build.log
        if($LASTEXITCODE -ne 0) { Get-Content control-build.log; throw 'Red-region control test compile failed' }
        & .\test-control.exe
        if($LASTEXITCODE -ne 0) { throw 'Red-region control test failed' }
    } finally { Pop-Location }
}
$lastFrame = if($profile -eq 'red-change') { 3 } else { 4 }
foreach($frame in 0..$lastFrame) {
    $a=(Get-FileHash -LiteralPath (Join-Path $out "$profile/debug/frame-$frame.ppm")).Hash
    $b=(Get-FileHash -LiteralPath (Join-Path $out "$profile/ndebug/frame-$frame.ppm")).Hash
    if($a -ne $b) { throw "NDEBUG reference mismatch: frame $frame" }
}
}
Write-Host 'All three probe profiles passed in Debug/NDEBUG; optical validation is still required.'
