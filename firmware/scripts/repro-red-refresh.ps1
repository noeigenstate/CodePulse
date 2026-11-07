param(
    [ValidateRange(1, 10000)][int]$Iterations = 40,
    [ValidateRange(1, 1000)][int]$Rounds = 3,
    [string]$Output,
    [switch]$AllowExistingShadowWarning,
    [switch]$RequireNoStaticRedFull
)
$ErrorActionPreference = 'Stop'
$firmwareRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$repositoryRoot = Split-Path -Parent $firmwareRoot
$main = Join-Path $firmwareRoot 'main'
$replay = Join-Path $firmwareRoot 'experiments\epd-red-replay\replay.c'
$outputRoot = if ($Output) { [IO.Path]::GetFullPath($Output) } else {
    Join-Path $repositoryRoot '.tmpshots\red-refresh-replay'
}
New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
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
$vendor = Join-Path $firmwareRoot 'tests\vendor\miniz'
$common = @('/nologo', '/std:c11', '/utf-8', '/W4', '/WX', '/D_CRT_SECURE_NO_WARNINGS',
    ('/I' + (Join-Path $firmwareRoot 'experiments\epd-quiet-probe\tests')),
    ('/I' + $main), ('/I' + $vendor))
$sources = @($replay, (Join-Path $main 'quiet_dashboard.c'), (Join-Path $main 'display_text.c'),
    (Join-Path $main 'epd_canvas.c'), (Join-Path $main 'display_sync_policy.c'),
    (Join-Path $vendor 'miniz_tinfl.c'))
$trackedSources = @($sources) + @((Join-Path $main 'life_dashboard.c'), $PSCommandPath)
$trackedSources += @(Get-ChildItem -LiteralPath $main -Filter '*.h' -File | Select-Object -ExpandProperty FullName)
$trackedSources += @((Join-Path $firmwareRoot 'tests\test_check.h'))
$trackedSources += @(Get-ChildItem -LiteralPath $vendor -Filter '*.h' -File | Select-Object -ExpandProperty FullName)
$trackedSources += @(Get-ChildItem -LiteralPath (Join-Path $firmwareRoot 'experiments\epd-quiet-probe\tests') -Filter '*.h' -File | Select-Object -ExpandProperty FullName)
$hashes = [ordered]@{}
foreach ($path in $trackedSources) {
    $relative = [IO.Path]::GetRelativePath($repositoryRoot, $path).Replace('\', '/')
    $hashes[$relative] = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
}
$receipt = [ordered]@{
    schema = 1; transport = 'mock'; clock = 'synthetic'; opticalValidation = $false
    compilerVersion = (Get-Item -LiteralPath (Get-Command cl.exe).Source).VersionInfo.FileVersion
    repositoryCommit = (& git -C $repositoryRoot rev-parse HEAD)
    iterations = $Iterations; rounds = $Rounds; inversions = 2
    allowExistingShadowWarning = [bool]$AllowExistingShadowWarning
    requireNoStaticRedFull = [bool]$RequireNoStaticRedFull
    sourceSha256 = $hashes
}
$receipt | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $outputRoot 'source.json') -Encoding utf8
if ($AllowExistingShadowWarning) {
    Write-Host 'Diagnostic workaround: suppress existing C4456 only while compiling life_dashboard.c; other warnings remain errors.'
}
$acceptanceFailed = $false
foreach ($mode in @('debug', 'ndebug')) {
    $directory = Join-Path $outputRoot $mode
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    Push-Location $directory
    try {
        [string[]]$defines = if ($mode -eq 'ndebug') { @('/DNDEBUG') } else { @() }
        [string[]]$lifeWarnings = if ($AllowExistingShadowWarning) { @('/wd4456') } else { @() }
        & cl.exe @common @defines @lifeWarnings /c (Join-Path $main 'life_dashboard.c') /Folife_dashboard.obj *> compile.log
        if ($LASTEXITCODE -ne 0) {
            Get-Content -LiteralPath compile.log
            throw "Life renderer compilation failed; see $directory\compile.log. Existing C4456 can be isolated with -AllowExistingShadowWarning."
        }
        & cl.exe @common @defines @sources life_dashboard.obj /Fe:replay.exe *>> compile.log
        if ($LASTEXITCODE -ne 0) {
            Get-Content -LiteralPath compile.log
            throw "Replay compilation failed; see $directory\compile.log."
        }
        $arguments = @([string]$Iterations, [string]$Rounds)
        if ($RequireNoStaticRedFull) { $arguments += '--require-no-static-red-full' }
        & (Join-Path $directory 'replay.exe') @arguments *> run.log
        $replayExit = $LASTEXITCODE
        Get-Content -LiteralPath run.log
        if ($replayExit -eq 2 -and $RequireNoStaticRedFull) { $acceptanceFailed = $true }
        elseif ($replayExit -ne 0) { throw "Replay invariant failed ($replayExit); see $directory\run.log." }
    } finally { Pop-Location }
}
foreach ($file in @('steps.csv', 'summary.csv')) {
    $debugHash = (Get-FileHash -LiteralPath (Join-Path $outputRoot "debug\$file")).Hash
    $ndebugHash = (Get-FileHash -LiteralPath (Join-Path $outputRoot "ndebug\$file")).Hash
    if ($debugHash -ne $ndebugHash) { throw "Debug/NDEBUG mismatch: $file" }
}
foreach ($relative in $hashes.Keys) {
    $current = (Get-FileHash -LiteralPath (Join-Path $repositoryRoot $relative) -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($current -ne $hashes[$relative]) { throw "Source changed during replay: $relative" }
}
Write-Host "Debug/NDEBUG outputs match. Evidence: $outputRoot"
if ($acceptanceFailed) { exit 2 }
exit 0
