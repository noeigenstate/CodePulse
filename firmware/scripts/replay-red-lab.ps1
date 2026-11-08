param(
    [Parameter(Mandatory=$true)][string]$SourcesRoot,
    [Parameter(Mandatory=$true)][string]$OutputDirectory,
    [string]$Python='python',
    [ValidateSet('Fast47','Tail48','Split49','Neutral50','Stagger51')]
    [string[]]$Profiles=@('Tail48','Neutral50','Stagger51')
)
$ErrorActionPreference='Stop'
$repoRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$sources=[IO.Path]::GetFullPath($SourcesRoot)
$output=[IO.Path]::GetFullPath($OutputDirectory)
if(Test-Path -LiteralPath $output) {throw 'Select a new output directory; preserve earlier replay outputs.'}
$harness=Join-Path $repoRoot 'firmware/scripts/red-lab-replay/audit_plan.c'
if(-not (Get-Command cl.exe -ErrorAction SilentlyContinue)) {
    $vswhere=Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
    $vsRoot=& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if(-not $vsRoot) {throw 'MSVC C compiler is required.'}
    $vcvars=Join-Path $vsRoot 'VC/Auxiliary/Build/vcvars64.bat'
    $compilerEnvironment=& $env:ComSpec /d /c ('call "'+$vcvars+'" >nul && set')
    if($LASTEXITCODE -ne 0) {throw 'MSVC activation failed.'}
    foreach($entry in $compilerEnvironment) {
        if($entry -match '^([^=]+)=(.*)$') {[Environment]::SetEnvironmentVariable($matches[1],$matches[2],'Process')}
    }
}
foreach($profile in $Profiles) {
    $source=Join-Path $sources $profile
    & $Python (Join-Path $PSScriptRoot 'red-lab-handoff.py') verify --profile $profile --source $source
    if($LASTEXITCODE -ne 0) {throw 'Source verification failed; no replay.'}
    $main=Join-Path $source 'firmware/main'
    $experiment=Join-Path $source 'firmware/experiments/epd-red-mask-probe'
    $arguments=@('/nologo','/std:c11','/utf-8','/W4','/WX',('/I'+$experiment),('/I'+$main),
        ('/I'+$source+'/firmware/experiments/epd-quiet-probe/tests'))
    foreach($name in @('BLACK','COLOR','PULSE','ACTIVATE')) {$arguments+='/DCODEPULSE_EPD_RED_MASK_'+$name+'=1'}
    if($profile -eq 'Fast47') {$arguments+='/DCODEPULSE_EPD_RED_MASK_FAST=1'}
    if($profile -eq 'Split49') {$arguments+='/DCODEPULSE_EPD_RED_MASK_SPLIT=1'}
    if($profile -in @('Tail48','Neutral50','Stagger51')) {$arguments+='/DCODEPULSE_EPD_RED_MASK_TAIL100=1'}
    if($profile -eq 'Neutral50') {$arguments+='/DCODEPULSE_EPD_RED_MASK_NEUTRAL=1'}
    if($profile -eq 'Stagger51') {$arguments+='/DCODEPULSE_EPD_RED_MASK_STAGGER=1'}
    $destination=Join-Path $output $profile
    New-Item -ItemType Directory -Path $destination | Out-Null
    Push-Location -LiteralPath $destination
    try {
        & cl.exe @arguments $harness (Join-Path $experiment 'red_mask_plan.c') (Join-Path $experiment 'red_mask_pattern.c') (Join-Path $main 'epd_canvas.c') /Fe:audit-plan.exe *> compile.log
        if($LASTEXITCODE -ne 0) {Get-Content -LiteralPath compile.log; throw 'Offline replay compilation failed.'}
        & .\audit-plan.exe > replay.json
        if($LASTEXITCODE -ne 0) {throw 'Offline replay failed.'}
        Write-Output "$profile frozen C replay complete; no SDK, serial, GPIO or SPI access."
    } finally {Pop-Location}
}
