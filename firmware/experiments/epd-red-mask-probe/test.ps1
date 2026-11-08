param([string]$Output,[switch]$BlackStage,[switch]$ColorStage,[switch]$PulseStage,[switch]$ActivateStage,[switch]$FastStage,[switch]$Tail100Stage,[switch]$SplitStage,[switch]$NeutralStage,[switch]$StaggerStage)
$ErrorActionPreference = 'Stop'
if (($Tail100Stage -or $NeutralStage -or $StaggerStage) -and $FastStage) { throw 'Tail100 variants and Fast are separate candidates.' }
if ($SplitStage -and ($FastStage -or $Tail100Stage -or $NeutralStage -or $StaggerStage)) { throw 'Split excludes Fast and Tail100 variants.' }
if ($StaggerStage -and $NeutralStage) { throw 'Stagger and Neutral are separate candidates.' }
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
$useBlackDriver = $BlackStage -or $ColorStage -or $PulseStage -or $ActivateStage -or $FastStage -or $Tail100Stage -or $SplitStage -or $NeutralStage -or $StaggerStage
$driverTest = if($useBlackDriver) { 'test_black_driver.c' } else { 'test_driver.c' }
$out = if ($Output) { [IO.Path]::GetFullPath($Output) } else { Join-Path $firmware 'build-red-mask-host' }
$common = @('/nologo','/std:c11','/utf-8','/W4','/WX','/D_CRT_SECURE_NO_WARNINGS',
    ('/I'+$firmware+'/experiments/epd-quiet-probe/tests'),('/I'+$firmware+'/main'),('/I'+$experiment),('/I'+$firmware+'/tests'))
foreach($mode in @('debug','ndebug')) {
    $destination = Join-Path $out $mode
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    Push-Location -LiteralPath $destination
    try {
        [string[]]$defines = if($mode -eq 'ndebug') { @('/DNDEBUG') } else { @() }
        if($useBlackDriver) { $defines += '/DCODEPULSE_EPD_RED_MASK_BLACK=1' }
        if($ColorStage -or $PulseStage -or $ActivateStage -or $FastStage -or $Tail100Stage -or $SplitStage -or $NeutralStage -or $StaggerStage) { $defines += '/DCODEPULSE_EPD_RED_MASK_COLOR=1' }
        if($PulseStage -or $ActivateStage -or $FastStage -or $Tail100Stage -or $SplitStage -or $NeutralStage -or $StaggerStage) { $defines += '/DCODEPULSE_EPD_RED_MASK_PULSE=1' }
        if($ActivateStage -or $FastStage -or $Tail100Stage -or $SplitStage -or $NeutralStage -or $StaggerStage) { $defines += '/DCODEPULSE_EPD_RED_MASK_ACTIVATE=1' }
        if($FastStage) { $defines += '/DCODEPULSE_EPD_RED_MASK_FAST=1' }
        if($Tail100Stage -or $NeutralStage -or $StaggerStage) { $defines += '/DCODEPULSE_EPD_RED_MASK_TAIL100=1' }
        if($SplitStage) { $defines += '/DCODEPULSE_EPD_RED_MASK_SPLIT=1' }
        if($NeutralStage) { $defines += '/DCODEPULSE_EPD_RED_MASK_NEUTRAL=1' }
        if($StaggerStage) { $defines += '/DCODEPULSE_EPD_RED_MASK_STAGGER=1' }
        & cl.exe @common @defines ('/I'+$firmware+'/tests/panel/include') ($experiment+'/tests/'+$driverTest) ($experiment+'/red_mask_pattern.c') ($experiment+'/red_mask_plan.c') ($firmware+'/main/epd_canvas.c') /Fe:test-driver.exe *> driver-build.log
        if($LASTEXITCODE -ne 0) { Get-Content driver-build.log; throw 'Red mask driver test compile failed' }
        & .\test-driver.exe
        if($LASTEXITCODE -ne 0) { throw 'Red mask driver test failed' }
        & cl.exe ('/I'+$firmware+'/experiments/epd-red-region-probe/tests/stubs') @common @defines ($experiment+'/tests/test_control.c') ($experiment+'/red_mask_probe.c') ($experiment+'/red_mask_pattern.c') ($experiment+'/red_mask_plan.c') ($firmware+'/main/epd_canvas.c') /Fe:test-control.exe *> control-build.log
        if($LASTEXITCODE -ne 0) { Get-Content control-build.log; throw 'Red mask control test compile failed' }
        & .\test-control.exe
        if($LASTEXITCODE -ne 0) { throw 'Red mask control test failed' }
    } finally { Pop-Location }
}
foreach($frame in 0..2) {
    $a=(Get-FileHash -LiteralPath (Join-Path $out "debug/frame-$frame.ppm")).Hash
    $b=(Get-FileHash -LiteralPath (Join-Path $out "ndebug/frame-$frame.ppm")).Hash
    if($a -ne $b) { throw "NDEBUG frame mismatch: $frame" }
}
Write-Host 'Register-BWR candidate passed Debug/NDEBUG. Hardware optics remain unverified.'
