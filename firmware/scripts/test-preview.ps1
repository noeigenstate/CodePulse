param([Parameter(Mandatory = $true)][string]$Zig,
      [string]$Python = 'python',
      [string]$Loader,
      [switch]$UpdateBaseline)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$output = Join-Path $root 'build-preview-check'
$json = Join-Path $root 'managed_components/espressif__cjson/cJSON'
if (-not $Loader) { $Loader = Join-Path $root '../apps/desktop/src/renderer/src/device-preview/renderer.mjs' }
$Loader = (Resolve-Path -LiteralPath $Loader).Path
if (-not (Test-Path -LiteralPath (Join-Path $json 'cJSON.c'))) { throw 'Configure the ESP-IDF project first to obtain the locked cJSON dependency.' }
& $Python (Join-Path $root 'scripts/build-preview.py') --zig $Zig --output $output
if ($LASTEXITCODE -ne 0) { throw 'Wasm renderer build failed.' }
if (-not (Get-Command cl.exe -ErrorAction SilentlyContinue)) {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
    $vsRoot = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if (-not $vsRoot) { throw 'Install MSVC C tools or use Developer PowerShell.' }
    $vcvars = Join-Path $vsRoot 'VC/Auxiliary/Build/vcvars64.bat'
    $compilerEnvironment = & $env:ComSpec /d /c ('call "' + $vcvars + '" >nul && set')
    if ($LASTEXITCODE -ne 0) { throw 'MSVC environment failed.' }
    foreach ($entry in $compilerEnvironment) {
        if ($entry -match '^([^=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process') }
    }
}
Push-Location $output
try {
    & cl.exe /nologo /std:c11 /utf-8 /W3 /D_CRT_SECURE_NO_WARNINGS /DPREVIEW_NATIVE `
        ('/I' + $root + '/main') ('/I' + $root + '/preview/include') ('/I' + $root + '/tests/vendor/miniz') ('/I' + $json) `
        ($root + '/preview/renderer.c') ($root + '/main/quiet_dashboard.c') ($root + '/main/display_text.c') `
        ($root + '/main/epd_canvas.c') ($root + '/main/codepulse_protocol.c') `
        ($root + '/tests/vendor/miniz/miniz_tinfl.c') ($json + '/cJSON.c') /Fe:preview-native.exe
    if ($LASTEXITCODE -ne 0) { throw 'Native renderer build failed.' }
    & node (Join-Path $root 'preview/test-preview.mjs') (Join-Path $output 'renderer.wasm') `
        (Join-Path $output 'preview-native.exe') $Loader (Join-Path $output 'parity')
    if ($LASTEXITCODE -ne 0) { throw 'Native/Wasm parity failed.' }
    $baselineOptions = @()
    if ($UpdateBaseline) { $baselineOptions = @('--update') }
    & node (Join-Path $root 'preview/check-legacy.mjs') (Join-Path $output 'preview-native.exe') (Join-Path $output 'legacy') @baselineOptions
    if ($LASTEXITCODE -ne 0) { throw 'Pixel baseline regression failed.' }
} finally { Pop-Location }
