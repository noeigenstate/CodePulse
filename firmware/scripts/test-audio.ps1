param([string]$Output)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
if (-not (Get-Command cl.exe -ErrorAction SilentlyContinue)) {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
    $vsRoot = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if (-not $vsRoot) { throw 'MSVC C tools were not found.' }
    $vcvars = Join-Path $vsRoot 'VC/Auxiliary/Build/vcvars64.bat'
    $compilerEnvironment = & $env:ComSpec /d /c ('call "' + $vcvars + '" >nul && set')
    if ($LASTEXITCODE -ne 0) { throw 'Could not initialize MSVC.' }
    foreach ($entry in $compilerEnvironment) {
        if ($entry -match '^([^=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process') }
    }
}
$output = if ($Output) { [IO.Path]::GetFullPath($Output) } else { Join-Path $root 'build-audio-host' }
New-Item -ItemType Directory -Path $output -Force | Out-Null
Push-Location $output
try {
    & cl.exe /nologo /std:c11 /utf-8 /W4 /WX ('/I'+$root+'/main') `
        ($root+'/tests/audio/test_pins.c') ($root+'/main/audio_pin_policy.c') /Fe:test-audio-pins.exe
    if ($LASTEXITCODE -ne 0) { throw 'Audio pin checks failed to compile.' }
    & (Join-Path $output 'test-audio-pins.exe')
    if ($LASTEXITCODE -ne 0) { throw 'Audio pin validation failed.' }
    & cl.exe /nologo /std:c11 /utf-8 /W4 /WX ('/I'+$root+'/main') ('/I'+$root+'/preview/include') `
        ($root+'/tests/audio/test_disabled.c') ($root+'/main/codepulse_audio.c') /Fe:test-audio-disabled.exe
    if ($LASTEXITCODE -ne 0) { throw 'Legacy audio no-op failed to compile.' }
    & (Join-Path $output 'test-audio-disabled.exe')
    if ($LASTEXITCODE -ne 0) { throw 'Legacy audio no-op failed.' }
} finally { Pop-Location }
