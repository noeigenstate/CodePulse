param([string]$Output)
$ErrorActionPreference = 'Stop'
$firmwareRoot = Split-Path -Parent $PSScriptRoot
if (-not (Get-Command cl.exe -ErrorAction SilentlyContinue)) {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (-not (Test-Path -LiteralPath $vswhere)) { throw 'Install MSVC C tools or run from a Developer PowerShell.' }
    $vsRoot = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if (-not $vsRoot) { throw 'MSVC C tools were not found.' }
    $vcvars = Join-Path $vsRoot 'VC\Auxiliary\Build\vcvars64.bat'
    # Import compiler environment only into this process; never print its values.
    $compilerEnvironment = & $env:ComSpec /d /c ('call "' + $vcvars + '" >nul && set')
    if ($LASTEXITCODE -ne 0) { throw 'Could not initialize MSVC.' }
    foreach ($entry in $compilerEnvironment) {
        if ($entry -match '^([^=]+)=(.*)$') {
            [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
        }
    }
}
$buildRoot = if ($Output) { [IO.Path]::GetFullPath($Output) } else { Join-Path $firmwareRoot 'build-host-tests' }
New-Item -ItemType Directory -Path $buildRoot -Force | Out-Null
Push-Location $buildRoot
try {
    & cl.exe /nologo /std:c11 /utf-8 /W3 /D_CRT_SECURE_NO_WARNINGS `
        ('/I' + (Join-Path $firmwareRoot 'tests\host\include')) `
        ('/I' + (Join-Path $firmwareRoot 'main')) `
        ('/I' + (Join-Path $firmwareRoot 'managed_components\espressif__cjson\cJSON')) `
        (Join-Path $firmwareRoot 'tests\host\test_sync.c') `
        (Join-Path $firmwareRoot 'main\codepulse_protocol.c') `
        (Join-Path $firmwareRoot 'main\display_sync_policy.c') `
        (Join-Path $firmwareRoot 'managed_components\espressif__cjson\cJSON\cJSON.c') `
        /Fe:test-sync.exe
    if ($LASTEXITCODE -ne 0) { throw 'Host test compilation failed.' }
    & (Join-Path $buildRoot 'test-sync.exe')
    if ($LASTEXITCODE -ne 0) { throw 'Host regression failed.' }
    & cl.exe /nologo /std:c11 /utf-8 /W3 /D_CRT_SECURE_NO_WARNINGS `
        ('/I' + (Join-Path $firmwareRoot 'tests\host\include')) `
        ('/I' + (Join-Path $firmwareRoot 'main')) `
        ('/I' + (Join-Path $firmwareRoot 'managed_components\espressif__cjson\cJSON')) `
        (Join-Path $firmwareRoot 'tests\host\test_calendar.c') `
        (Join-Path $firmwareRoot 'main\codepulse_protocol.c') `
        (Join-Path $firmwareRoot 'managed_components\espressif__cjson\cJSON\cJSON.c') /Fe:test-calendar.exe
    if ($LASTEXITCODE -ne 0) { throw 'Calendar protocol compilation failed.' }
    & (Join-Path $buildRoot 'test-calendar.exe')
    if ($LASTEXITCODE -ne 0) { throw 'Calendar protocol regression failed.' }
    & cl.exe /nologo /std:c11 /utf-8 /W3 /D_CRT_SECURE_NO_WARNINGS `
        ('/I' + (Join-Path $firmwareRoot 'tests/host/include')) ('/I' + (Join-Path $firmwareRoot 'main')) `
        ('/I' + (Join-Path $firmwareRoot 'managed_components/espressif__cjson/cJSON')) `
        (Join-Path $firmwareRoot 'tests/host/test_life.c') (Join-Path $firmwareRoot 'main/codepulse_protocol.c') `
        (Join-Path $firmwareRoot 'managed_components/espressif__cjson/cJSON/cJSON.c') /Fe:test-life.exe
    if ($LASTEXITCODE -ne 0) { throw 'Life protocol compilation failed.' }
    & (Join-Path $buildRoot 'test-life.exe') (Join-Path $firmwareRoot 'preview/fixtures')
    if ($LASTEXITCODE -ne 0) { throw 'Life protocol regression failed.' }
    foreach ($ndebug in @(0, 1)) {
        $defines = @()
        if ($ndebug) { $defines = @('/DNDEBUG') }
        $offlineExe = 'test-offline-' + $ndebug + '.exe'
        & cl.exe /nologo /std:c11 /utf-8 /W4 /WX /D_CRT_SECURE_NO_WARNINGS @defines `
            ('/I' + (Join-Path $firmwareRoot 'experiments/epd-quiet-probe/tests')) `
            ('/I' + (Join-Path $firmwareRoot 'main')) ('/I' + (Join-Path $firmwareRoot 'tests/vendor/miniz')) `
            (Join-Path $firmwareRoot 'tests/quiet/test_offline.c') (Join-Path $firmwareRoot 'main/quiet_dashboard.c') `
            (Join-Path $firmwareRoot 'main/life_dashboard.c') (Join-Path $firmwareRoot 'main/display_text.c') `
            (Join-Path $firmwareRoot 'main/epd_canvas.c') (Join-Path $firmwareRoot 'main/display_sync_policy.c') `
            (Join-Path $firmwareRoot 'tests/vendor/miniz/miniz_tinfl.c') ('/Fe:' + $offlineExe)
        if ($LASTEXITCODE -ne 0) { throw 'Offline status compilation failed.' }
        & (Join-Path $buildRoot $offlineExe)
        if ($LASTEXITCODE -ne 0) { throw 'Offline status regression failed.' }
    }
} finally {
    Pop-Location
}
