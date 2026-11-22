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
$out = if ($Output) { [IO.Path]::GetFullPath($Output) } else { Join-Path $firmware 'build-resolution-host' }
New-Item -ItemType Directory -Path $out -Force | Out-Null
Push-Location -LiteralPath $out
try {
    & cl.exe /nologo /std:c11 /utf-8 /W4 /WX /D_CRT_SECURE_NO_WARNINGS `
      ('/I'+$firmware+'/tests/host/include') ('/I'+$firmware+'/main') ('/I'+$experiment) `
      ($experiment+'/tests/test_pattern.c') ($experiment+'/resolution_pattern.c') `
      ($firmware+'/main/epd_canvas.c') /Fe:test-resolution.exe
    if ($LASTEXITCODE -ne 0) { throw 'Resolution reference failed to compile.' }
    & (Join-Path $out 'test-resolution.exe') (Join-Path $out 'reference.pgm')
    if ($LASTEXITCODE -ne 0) { throw 'Resolution reference checks failed.' }
    & cl.exe /nologo /std:c11 /utf-8 /W4 /WX /D_CRT_SECURE_NO_WARNINGS `
      ('/I'+$experiment+'/tests/stubs') ('/I'+$firmware+'/tests/host/include') `
      ('/I'+$firmware+'/main') ('/I'+$experiment) `
      ($experiment+'/tests/test_control.c') ($experiment+'/resolution_probe.c') `
      ($experiment+'/resolution_pattern.c') ($firmware+'/main/epd_canvas.c') /Fe:test-resolution-control.exe
    if ($LASTEXITCODE -ne 0) { throw 'Resolution control checks failed to compile.' }
    & (Join-Path $out 'test-resolution-control.exe')
    if ($LASTEXITCODE -ne 0) { throw 'Resolution control checks failed.' }

} finally { Pop-Location }
