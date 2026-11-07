param(
    [ValidateSet('Fast47', 'Color46', 'Erase43', 'Production33')][string]$Profile = 'Fast47',
    [string]$BuildDirectory,
    [ValidateRange(1, 2)][int]$Jobs = 2,
    [switch]$PlanOnly
)
$ErrorActionPreference = 'Stop'
$firmware = Split-Path -Parent $PSScriptRoot
$versions = @{ Fast47 = '0.0.47-red-fast'; Color46 = '0.0.46-red-activate';
    Erase43 = '0.0.43-red-black'; Production33 = '0.0.33-status-region-pair150' }
$levels = @{ Production33 = 0; Erase43 = 2; Color46 = 5; Fast47 = 6 }
$chain = @('CODEPULSE_EPD_RED_MASK_PROBE', 'CODEPULSE_EPD_RED_MASK_BLACK',
    'CODEPULSE_EPD_RED_MASK_COLOR', 'CODEPULSE_EPD_RED_MASK_PULSE',
    'CODEPULSE_EPD_RED_MASK_ACTIVATE', 'CODEPULSE_EPD_RED_MASK_FAST')
$cmake = Get-Content -LiteralPath (Join-Path $firmware 'CMakeLists.txt') -Raw
$options = [ordered]@{}
foreach ($match in [regex]::Matches($cmake, 'option\((CODEPULSE_(?:EPD_[A-Z0-9_]+|AUDIO_[A-Z0-9_]+))\s')) {
    $options[$match.Groups[1].Value] = 'OFF'
}
foreach ($name in $chain) {
    if (-not $options.Contains($name)) { throw "Missing explicit experiment option: $name" }
}
for ($i = 0; $i -lt $levels[$Profile]; $i++) { $options[$chain[$i]] = 'ON' }
$options['CODEPULSE_QUIET_PAIR150_TRIAL'] = 'ON'
$options['CODEPULSE_QUIET_RECT_TRIAL'] = 'ON'
if ($PlanOnly) {
    [ordered]@{ profile = $Profile; version = $versions[$Profile]; jobs = $Jobs;
        options = $options; flashesHardware = $false } | ConvertTo-Json -Depth 3
    return
}

$buildPath = if ($BuildDirectory) {
    if ([IO.Path]::IsPathRooted($BuildDirectory)) { [IO.Path]::GetFullPath($BuildDirectory) }
    else { [IO.Path]::GetFullPath((Join-Path $firmware $BuildDirectory)) }
} else { Join-Path $firmware ('build-red-lab-' + $Profile.ToLowerInvariant()) }
if ($buildPath.TrimEnd('\', '/') -eq $firmware.TrimEnd('\', '/')) { throw 'Build output must not be the source root.' }
if ($env:OS -eq 'Windows_NT' -and $buildPath.Length -gt 80) {
    throw 'Windows build path is too long for the pinned SDK. Use -BuildDirectory with a short output path (80 characters or fewer).'
}
if (Test-Path -LiteralPath (Join-Path $buildPath 'package/manifest.json')) {
    throw 'This build already has an immutable package. Select a new -BuildDirectory for a new candidate.'
}
. (Join-Path $PSScriptRoot 'idf-env.ps1')
New-Item -ItemType Directory -Path $buildPath -Force | Out-Null
$config = Join-Path $buildPath 'sdkconfig'
if (-not (Test-Path -LiteralPath $config)) { Copy-Item -LiteralPath (Join-Path $firmware 'sdkconfig') -Destination $config }
$artifactTool = Join-Path $PSScriptRoot 'red-lab-artifact.py'
$arguments = @('-C', $firmware, '-B', $buildPath, '-D', "SDKCONFIG=$config")
foreach ($name in $options.Keys) { $arguments += @('-D', ($name + '=' + $options[$name])) }
$priorParallelism = $env:CMAKE_BUILD_PARALLEL_LEVEL
try {
    $env:CMAKE_BUILD_PARALLEL_LEVEL = [string]$Jobs
    Write-Host "Configuring $Profile ($($versions[$Profile])); no hardware access."
    & $IdfPython (Join-Path $env:IDF_PATH 'tools/idf.py') @arguments reconfigure *> (Join-Path $buildPath 'configure.log')
    if ($LASTEXITCODE -ne 0) {
        Get-Content -LiteralPath (Join-Path $buildPath 'configure.log') -Tail 30
        throw 'IDF configure failed.'
    }
    & $IdfPython $artifactTool snapshot --build $buildPath --profile $Profile
    if ($LASTEXITCODE -ne 0) { throw 'Source snapshot failed.' }
    Write-Host "Building with at most $Jobs compiler jobs."
    & cmake --build $buildPath --parallel $Jobs *> (Join-Path $buildPath 'build.log')
    if ($LASTEXITCODE -ne 0) {
        Get-Content -LiteralPath (Join-Path $buildPath 'build.log') -Tail 40
        throw 'Target build failed.'
    }
    & $IdfPython $artifactTool package --build $buildPath --profile $Profile
    if ($LASTEXITCODE -ne 0) { throw 'Artifact validation failed; do not flash.' }
    Write-Host "Package: $buildPath/package. Build only; no flash, reset or application launch."
} finally {
    if ($null -eq $priorParallelism) { Remove-Item Env:CMAKE_BUILD_PARALLEL_LEVEL -ErrorAction SilentlyContinue }
    else { $env:CMAKE_BUILD_PARALLEL_LEVEL = $priorParallelism }
}
