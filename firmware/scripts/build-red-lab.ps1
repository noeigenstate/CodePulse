param(
    [ValidateSet('ProductionRed68', 'CrispAB67', 'VividAB66', 'SmoothAB65', 'RichAB64', 'FreqAB63', 'WaveAB62', 'BrakeAB61', 'PureAB60', 'GlideAB59', 'SingleAB58', 'ScanAB57', 'Shift55', 'Finish54', 'Pair53', 'Gap52', 'Stagger51', 'Neutral50', 'Split49', 'Tail48', 'Fast47', 'Color46', 'Erase43', 'Production33')][string]$Profile = 'Stagger51',
    [string]$BuildDirectory,
    [ValidateRange(1, 2)][int]$Jobs = 2,
    [switch]$PlanOnly
)
$ErrorActionPreference = 'Stop'
$firmware = Split-Path -Parent $PSScriptRoot
$versions = @{ ProductionRed68 = '0.0.68-status-red-crisp'; CrispAB67 = '0.0.67-red-crisp-ab'; VividAB66 = '0.0.66-red-vivid-ab'; SmoothAB65 = '0.0.65-red-smooth-ab'; RichAB64 = '0.0.64-red-rich-ab'; FreqAB63 = '0.0.63-red-freq-ab'; WaveAB62 = '0.0.62-red-wave-ab'; BrakeAB61 = '0.0.61-red-brake-ab'; PureAB60 = '0.0.60-red-pure-ab'; GlideAB59 = '0.0.59-red-glide-ab'; SingleAB58 = '0.0.58-red-single-ab'; ScanAB57 = '0.0.57-red-scan-ab'; Shift55 = '0.0.55-red-gap-shift'; Finish54 = '0.0.54-red-finish'; Pair53 = '0.0.53-red-pair'; Gap52 = '0.0.52-red-gap'; Stagger51 = '0.0.51-red-stagger'; Neutral50 = '0.0.50-red-neutral'; Split49 = '0.0.49-red-split'; Tail48 = '0.0.48-red-tail100'; Fast47 = '0.0.47-red-fast'; Color46 = '0.0.46-red-activate';
    Erase43 = '0.0.43-red-black'; Production33 = '0.0.33-status-region-pair150' }
$levels = @{ ProductionRed68 = 0; Production33 = 0; Erase43 = 2; Color46 = 5; Fast47 = 6; Tail48 = 5; Split49 = 5; Neutral50 = 5; Stagger51 = 5; Gap52 = 5; Pair53 = 5; Finish54 = 5; Shift55 = 5; ScanAB57 = 5; SingleAB58 = 5; GlideAB59 = 5; PureAB60 = 5; BrakeAB61 = 5; WaveAB62 = 5; FreqAB63 = 5; RichAB64 = 5; SmoothAB65 = 5; VividAB66 = 5; CrispAB67 = 5 }
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
if (-not $options.Contains('CODEPULSE_EPD_RED_MASK_TAIL100')) { throw 'Missing 100Hz-tail option.' }
if ($Profile -in @('Tail48', 'Neutral50', 'Stagger51', 'Gap52', 'Pair53', 'Finish54', 'Shift55', 'ScanAB57', 'SingleAB58', 'GlideAB59', 'PureAB60', 'BrakeAB61', 'WaveAB62', 'FreqAB63', 'RichAB64', 'SmoothAB65', 'VividAB66', 'CrispAB67')) { $options['CODEPULSE_EPD_RED_MASK_TAIL100'] = 'ON' }
if (-not $options.Contains('CODEPULSE_EPD_RED_MASK_SPLIT')) { throw 'Missing split-stage option.' }
if ($Profile -eq 'Split49') { $options['CODEPULSE_EPD_RED_MASK_SPLIT'] = 'ON' }
if (-not $options.Contains('CODEPULSE_EPD_RED_MASK_NEUTRAL')) { throw 'Missing neutral-tail option.' }
if ($Profile -eq 'Neutral50') { $options['CODEPULSE_EPD_RED_MASK_NEUTRAL'] = 'ON' }
if (-not $options.Contains('CODEPULSE_EPD_RED_MASK_STAGGER')) { throw 'Missing stagger option.' }
if ($Profile -eq 'Stagger51') { $options['CODEPULSE_EPD_RED_MASK_STAGGER'] = 'ON' }
if (-not $options.Contains('CODEPULSE_EPD_RED_MASK_GAP')) { throw 'Missing red-tail gap option.' }
if ($Profile -in @('Gap52', 'Pair53', 'Finish54', 'Shift55', 'ScanAB57', 'SingleAB58', 'GlideAB59', 'PureAB60', 'BrakeAB61', 'WaveAB62', 'FreqAB63', 'RichAB64', 'SmoothAB65', 'VividAB66', 'CrispAB67')) { $options['CODEPULSE_EPD_RED_MASK_GAP'] = 'ON' }
if (-not $options.Contains('CODEPULSE_EPD_RED_MASK_TAIL_PAIR')) { throw 'Missing paired-tail option.' }
if ($Profile -eq 'Pair53') { $options['CODEPULSE_EPD_RED_MASK_TAIL_PAIR'] = 'ON' }
if (-not $options.Contains('CODEPULSE_EPD_RED_MASK_TAIL_FINISH')) { throw 'Missing continuous-finish option.' }
if ($Profile -eq 'Finish54') { $options['CODEPULSE_EPD_RED_MASK_TAIL_FINISH'] = 'ON' }
if (-not $options.Contains('CODEPULSE_EPD_RED_MASK_GAP_SHIFT')) { throw 'Missing shifted-gap option.' }
if ($Profile -in @('Shift55', 'ScanAB57', 'SingleAB58', 'GlideAB59', 'PureAB60', 'BrakeAB61', 'WaveAB62', 'FreqAB63', 'RichAB64', 'SmoothAB65', 'VividAB66', 'CrispAB67')) { $options['CODEPULSE_EPD_RED_MASK_GAP_SHIFT'] = 'ON' }
if ($Profile -in @('ScanAB57', 'SingleAB58', 'GlideAB59', 'PureAB60', 'BrakeAB61', 'WaveAB62', 'FreqAB63', 'RichAB64', 'SmoothAB65', 'VividAB66', 'CrispAB67')) {
    if (-not $options.Contains('CODEPULSE_EPD_RED_MASK_SCAN_AB')) { throw 'Missing scan A/B option.' }
    $options['CODEPULSE_EPD_RED_MASK_SCAN_AB'] = 'ON'
}
if ($Profile -in @('SingleAB58', 'GlideAB59', 'PureAB60', 'BrakeAB61', 'WaveAB62', 'FreqAB63', 'RichAB64', 'SmoothAB65', 'VividAB66', 'CrispAB67')) {
    if (-not $options.Contains('CODEPULSE_EPD_RED_MASK_SINGLE_AB')) { throw 'Missing single A/B option.' }
    $options['CODEPULSE_EPD_RED_MASK_SINGLE_AB'] = 'ON'
}
if ($Profile -in @('GlideAB59', 'PureAB60', 'BrakeAB61', 'WaveAB62', 'FreqAB63', 'RichAB64', 'SmoothAB65', 'VividAB66', 'CrispAB67')) {
    if (-not $options.Contains('CODEPULSE_EPD_RED_MASK_GLIDE_AB')) { throw 'Missing glide A/B option.' }
    $options['CODEPULSE_EPD_RED_MASK_GLIDE_AB'] = 'ON'
}
if ($Profile -in @('PureAB60', 'BrakeAB61', 'WaveAB62', 'FreqAB63', 'RichAB64', 'SmoothAB65', 'VividAB66', 'CrispAB67')) {
    if (-not $options.Contains('CODEPULSE_EPD_RED_MASK_PURE_AB')) { throw 'Missing pure A/B option.' }
    $options['CODEPULSE_EPD_RED_MASK_PURE_AB'] = 'ON'
}
if ($Profile -in @('BrakeAB61', 'WaveAB62', 'FreqAB63', 'RichAB64', 'SmoothAB65', 'VividAB66', 'CrispAB67')) {
    if (-not $options.Contains('CODEPULSE_EPD_RED_MASK_BRAKE_AB')) { throw 'Missing brake A/B option.' }
    $options['CODEPULSE_EPD_RED_MASK_BRAKE_AB'] = 'ON'
}
if ($Profile -in @('WaveAB62', 'FreqAB63', 'RichAB64', 'SmoothAB65', 'VividAB66', 'CrispAB67')) {
    if (-not $options.Contains('CODEPULSE_EPD_RED_MASK_WAVE_AB')) { throw 'Missing wave A/B option.' }
    $options['CODEPULSE_EPD_RED_MASK_WAVE_AB'] = 'ON'
}
if ($Profile -in @('FreqAB63', 'RichAB64', 'SmoothAB65', 'VividAB66', 'CrispAB67')) {
    if (-not $options.Contains('CODEPULSE_EPD_RED_MASK_FREQ_AB')) { throw 'Missing freq A/B option.' }
    $options['CODEPULSE_EPD_RED_MASK_FREQ_AB'] = 'ON'
}
if ($Profile -in @('RichAB64', 'SmoothAB65', 'VividAB66', 'CrispAB67')) {
    if (-not $options.Contains('CODEPULSE_EPD_RED_MASK_RICH_AB')) { throw 'Missing rich A/B option.' }
    $options['CODEPULSE_EPD_RED_MASK_RICH_AB'] = 'ON'
}
if ($Profile -in @('SmoothAB65', 'VividAB66', 'CrispAB67')) {
    if (-not $options.Contains('CODEPULSE_EPD_RED_MASK_SMOOTH_AB')) { throw 'Missing smooth A/B option.' }
    $options['CODEPULSE_EPD_RED_MASK_SMOOTH_AB'] = 'ON'
}
if ($Profile -in @('VividAB66', 'CrispAB67')) {
    if (-not $options.Contains('CODEPULSE_EPD_RED_MASK_VIVID_AB')) { throw 'Missing vivid A/B option.' }
    $options['CODEPULSE_EPD_RED_MASK_VIVID_AB'] = 'ON'
}
if ($Profile -eq 'CrispAB67') {
    if (-not $options.Contains('CODEPULSE_EPD_RED_MASK_CRISP_AB')) { throw 'Missing crisp A/B option.' }
    $options['CODEPULSE_EPD_RED_MASK_CRISP_AB'] = 'ON'
}
$options['CODEPULSE_QUIET_PAIR150_TRIAL'] = 'ON'
$options['CODEPULSE_QUIET_RECT_TRIAL'] = 'ON'
$options['CODEPULSE_QUIET_RED_CRISP_TRIAL'] = if ($Profile -eq 'ProductionRed68') { 'ON' } else { 'OFF' }
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
    $ErrorActionPreference = 'Continue'
    & $IdfPython (Join-Path $env:IDF_PATH 'tools/idf.py') @arguments reconfigure > (Join-Path $buildPath 'configure.log') 2>&1
    $cfgExit = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($cfgExit -ne 0) {
        Get-Content -LiteralPath (Join-Path $buildPath 'configure.log') -Tail 30
        throw 'IDF configure failed.'
    }
    & $IdfPython $artifactTool snapshot --build $buildPath --profile $Profile
    if ($LASTEXITCODE -ne 0) { throw 'Source snapshot failed.' }
    Write-Host "Building with at most $Jobs compiler jobs."
    $ErrorActionPreference = 'Continue'
    & cmake --build $buildPath --parallel $Jobs > (Join-Path $buildPath 'build.log') 2>&1
    $bldExit = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($bldExit -ne 0) {
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
