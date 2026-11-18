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

$out = if ($Output) { [IO.Path]::GetFullPath($Output) } else { Join-Path $firmware 'build-panel-readback-host' }
$common=@('/nologo','/std:c11','/utf-8','/W4','/WX','/D_CRT_SECURE_NO_WARNINGS',
  ('/I'+$experiment+'/tests/stubs'),('/I'+$firmware+'/main'),('/I'+$experiment),('/I'+$firmware+'/tests'))
foreach($mode in @('debug','ndebug')) {
  $destination=Join-Path $out $mode
  New-Item -ItemType Directory -Path $destination -Force | Out-Null
  Push-Location -LiteralPath $destination
  try {
    [string[]]$defines=if($mode -eq 'ndebug') { @('/DNDEBUG') } else { @() }
    & cl.exe @common @defines ($experiment+'/tests/test_readback.c') /Fe:test-readback.exe *> readback-build.log
    if($LASTEXITCODE -ne 0) { Get-Content readback-build.log; throw 'Readback test compile failed' }
    & .\test-readback.exe
    if($LASTEXITCODE -ne 0) { throw 'Readback test failed' }
    & cl.exe @common @defines ($experiment+'/tests/test_control.c') ($experiment+'/panel_readback_probe.c') /Fe:test-control.exe *> control-build.log
    if($LASTEXITCODE -ne 0) { Get-Content control-build.log; throw 'Control test compile failed' }
    & .\test-control.exe
    if($LASTEXITCODE -ne 0) { throw 'Control test failed' }
  } finally { Pop-Location }
}
