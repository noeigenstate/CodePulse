$ErrorActionPreference = 'Stop'
$firmwareRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
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
$quiet = Join-Path $firmwareRoot 'experiments\epd-quiet-probe'
$experiment = Join-Path $firmwareRoot 'experiments\epd-text-timing-probe'
$main = Join-Path $firmwareRoot 'main'
$tests = Join-Path $firmwareRoot 'tests\quiet'
$output = Join-Path $firmwareRoot 'build-quiet-tests'
New-Item -ItemType Directory -Path $output -Force | Out-Null
Push-Location $output
try {
    $panelTests = Join-Path $firmwareRoot 'tests\panel'
    foreach ($trial in @(0, 1)) {
        $trialDefine = '/DCODEPULSE_QUIET_PAIR150_TRIAL=' + $trial
        foreach ($rect in @(0, 1)) {
        $rectDefine = '/DCODEPULSE_QUIET_RECT_TRIAL=' + $rect
        $driverExe = 'test-driver-' + $trial + '-' + $rect + '.exe'
        & cl.exe /nologo /std:c11 /utf-8 /W4 /WX $trialDefine $rectDefine ('/I' + (Join-Path $quiet 'tests')) ('/I' + $main) `
            ('/I' + $experiment) (Join-Path $tests 'test_driver.c') ('/Fe:' + $driverExe)
        if ($LASTEXITCODE -ne 0) { throw 'Quiet driver compilation failed.' }
        & (Join-Path $output $driverExe)
        if ($LASTEXITCODE -ne 0) { throw 'Quiet driver regression failed.' }
        $panelExe = 'test-panel-lifecycle-' + $trial + '-' + $rect + '.exe'
        & cl.exe /nologo /std:c11 /utf-8 /W4 /WX $trialDefine $rectDefine ('/I' + (Join-Path $panelTests 'include')) `
            ('/I' + (Join-Path $quiet 'tests')) ('/I' + $main) (Join-Path $panelTests 'test_lifecycle.c') ('/Fe:' + $panelExe)
        if ($LASTEXITCODE -ne 0) { throw 'Panel lifecycle compilation failed.' }
        & (Join-Path $output $panelExe)
        if ($LASTEXITCODE -ne 0) { throw 'Panel lifecycle regression failed.' }
        }
    }
    & cl.exe /nologo /std:c11 /utf-8 /W4 /WX /D_CRT_SECURE_NO_WARNINGS `
        ('/I' + (Join-Path $quiet 'tests')) ('/I' + $main) ('/I' + (Join-Path $tests '../vendor/miniz')) (Join-Path $tests 'test_dashboard.c') `
        (Join-Path $main 'quiet_dashboard.c') (Join-Path $main 'display_text.c') (Join-Path $main 'epd_canvas.c') `
        (Join-Path $main 'display_sync_policy.c') (Join-Path $tests '../vendor/miniz/miniz_tinfl.c') /Fe:test-dashboard.exe
    if ($LASTEXITCODE -ne 0) { throw 'Quiet dashboard compilation failed.' }
    & (Join-Path $output 'test-dashboard.exe')
    if ($LASTEXITCODE -ne 0) { throw 'Quiet dashboard regression failed.' }
    & cl.exe /nologo /std:c11 /utf-8 /W4 /WX /D_CRT_SECURE_NO_WARNINGS `
        ('/I' + (Join-Path $quiet 'tests')) ('/I' + $main) ('/I' + (Join-Path $tests '../vendor/miniz')) (Join-Path $tests 'test_red.c') `
        (Join-Path $main 'quiet_dashboard.c') (Join-Path $main 'display_text.c') (Join-Path $main 'epd_canvas.c') `
        (Join-Path $main 'display_sync_policy.c') (Join-Path $tests '../vendor/miniz/miniz_tinfl.c') /Fe:test-red.exe
    if ($LASTEXITCODE -ne 0) { throw 'Red dashboard compilation failed.' }
    & (Join-Path $output 'test-red.exe')
    if ($LASTEXITCODE -ne 0) { throw 'Red dashboard regression failed.' }
    & cl.exe /nologo /std:c11 /utf-8 /W4 /WX /D_CRT_SECURE_NO_WARNINGS `
        ('/I' + (Join-Path $quiet 'tests')) ('/I' + $main) ('/I' + (Join-Path $tests '../vendor/miniz')) (Join-Path $tests 'test_pet_layout.c') `
        (Join-Path $main 'quiet_dashboard.c') (Join-Path $main 'epd_canvas.c') `
        (Join-Path $main 'display_sync_policy.c') (Join-Path $tests '../vendor/miniz/miniz_tinfl.c') /Fe:test-pet-layout.exe
    if ($LASTEXITCODE -ne 0) { throw 'Pet layout compilation failed.' }
    & (Join-Path $output 'test-pet-layout.exe')
    if ($LASTEXITCODE -ne 0) { throw 'Pet layout regression failed.' }
    & cl.exe /nologo /std:c11 /utf-8 /W4 /WX /D_CRT_SECURE_NO_WARNINGS `
        ('/I' + (Join-Path $quiet 'tests')) ('/I' + $main) ('/I' + (Join-Path $tests '../vendor/miniz')) (Join-Path $tests 'test_calendar.c') `
        (Join-Path $main 'quiet_dashboard.c') (Join-Path $main 'display_text.c') (Join-Path $main 'epd_canvas.c') `
        (Join-Path $main 'display_sync_policy.c') (Join-Path $tests '../vendor/miniz/miniz_tinfl.c') /Fe:test-calendar.exe
    if ($LASTEXITCODE -ne 0) { throw 'Calendar dashboard compilation failed.' }
    & (Join-Path $output 'test-calendar.exe')
    if ($LASTEXITCODE -ne 0) { throw 'Calendar dashboard regression failed.' }
    & cl.exe /nologo /std:c11 /utf-8 /W4 /WX /D_CRT_SECURE_NO_WARNINGS `
        ('/I' + (Join-Path $quiet 'tests')) ('/I' + $main) ('/I' + (Join-Path $tests '../vendor/miniz')) (Join-Path $tests 'test_pacing.c') `
        (Join-Path $main 'quiet_dashboard.c') (Join-Path $main 'display_text.c') (Join-Path $main 'epd_canvas.c') `
        (Join-Path $main 'display_sync_policy.c') (Join-Path $tests '../vendor/miniz/miniz_tinfl.c') /Fe:test-pacing.exe
    if ($LASTEXITCODE -ne 0) { throw 'Pacing compilation failed.' }
    & (Join-Path $output 'test-pacing.exe')
    if ($LASTEXITCODE -ne 0) { throw 'Pacing replay failed.' }
    foreach ($unit in @('test_dashboard', 'test_pet_layout', 'test_calendar')) {
        $nativeFonts = @()
        if ($unit -ne 'test_pet_layout') { $nativeFonts = @((Join-Path $main 'display_text.c')) }
        $checkedExe = $unit + '-ndebug.exe'
        & cl.exe /nologo /std:c11 /utf-8 /W4 /WX /DNDEBUG /D_CRT_SECURE_NO_WARNINGS `
            ('/I' + (Join-Path $quiet 'tests')) ('/I' + $main) ('/I' + (Join-Path $tests '../vendor/miniz')) `
            (Join-Path $tests ($unit + '.c')) (Join-Path $main 'quiet_dashboard.c') @nativeFonts `
            (Join-Path $main 'epd_canvas.c') (Join-Path $main 'display_sync_policy.c') `
            (Join-Path $tests '../vendor/miniz/miniz_tinfl.c') ('/Fe:' + $checkedExe)
        if ($LASTEXITCODE -ne 0) { throw ('NDEBUG compilation failed: ' + $unit) }
        & (Join-Path $output $checkedExe)
        if ($LASTEXITCODE -ne 0) { throw ('NDEBUG checks failed: ' + $unit) }
    }
} finally { Pop-Location }
