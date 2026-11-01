$ErrorActionPreference = 'Stop'
$firmwareRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..\..')).Path
if (-not (Get-Command cl.exe -ErrorAction SilentlyContinue)) {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    $vsRoot = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if (-not $vsRoot) { throw 'MSVC C tools were not found.' }
    $vcvars = Join-Path $vsRoot 'VC\Auxiliary\Build\vcvars64.bat'
    $compilerEnvironment = & $env:ComSpec /d /c ('call "' + $vcvars + '" >nul && set')
    if ($LASTEXITCODE -ne 0) { throw 'Could not initialize MSVC.' }
    foreach ($entry in $compilerEnvironment) {
        if ($entry -match '^([^=]+)=(.*)$') {
            [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
        }
    }
}
$experiment = Join-Path $firmwareRoot 'experiments\epd-text-probe'
$quiet = Join-Path $firmwareRoot 'experiments\epd-quiet-probe'
$output = Join-Path (Split-Path $firmwareRoot) 'CodePulse\.tmpshots\text-probe-host'
New-Item -ItemType Directory -Path $output -Force | Out-Null
Push-Location $output
try {
    & cl.exe /nologo /std:c11 /W4 /WX ('/I' + (Join-Path $quiet 'tests')) `
        ('/I' + $quiet) (Join-Path $quiet 'tests\test_quiet.c') /Fe:test-driver.exe
    if ($LASTEXITCODE -ne 0) { throw 'Shared B driver compilation failed.' }
    & (Join-Path $output 'test-driver.exe')
    if ($LASTEXITCODE -ne 0) { throw 'Shared B driver regression failed.' }
    & cl.exe /nologo /std:c11 /W4 /WX ('/I' + (Join-Path $quiet 'tests')) `
        ('/I' + $quiet) ('/I' + $experiment) (Join-Path $experiment 'tests\test_text.c') `
        (Join-Path $firmwareRoot 'main\epd_canvas.c') /Fe:test-text.exe
    if ($LASTEXITCODE -ne 0) { throw 'Text test compilation failed.' }
    & (Join-Path $output 'test-text.exe')
    if ($LASTEXITCODE -ne 0) { throw 'Text sequence regression failed.' }
} finally { Pop-Location }
