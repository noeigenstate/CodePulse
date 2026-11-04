param([ValidateSet('x64','arm64','ia32')][string]$Arch = 'x64')
$ErrorActionPreference = 'Stop'
$desktop = Split-Path -Parent $PSScriptRoot
$source = Join-Path $desktop 'native/performance-gpu.cpp'
$output = Join-Path $desktop 'out/performance'
$exe = Join-Path $output ('performance-gpu-' + $Arch + '.exe')
if ((Test-Path -LiteralPath $exe) -and (Get-Item $exe).LastWriteTimeUtc -ge (Get-Item $source).LastWriteTimeUtc -and (Get-Item $exe).LastWriteTimeUtc -ge (Get-Item $PSCommandPath).LastWriteTimeUtc) { return }
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
if (!(Test-Path -LiteralPath $vswhere)) { Write-Warning 'GPU preview unavailable without MSVC and the Windows SDK. CPU and memory are available.'; return }
$vs = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (!$vs) { Write-Warning 'GPU preview unavailable without MSVC and the Windows SDK. CPU and memory are available.'; return }
$vcvars = Join-Path $vs 'VC/Auxiliary/Build/vcvarsall.bat'
$target = @{x64='x64'; arm64='x64_arm64'; ia32='x64_x86'}[$Arch]
$environment = & $env:ComSpec /d /c ('call "' + $vcvars + '" ' + $target + ' >nul && set')
if ($LASTEXITCODE) { throw 'Could not initialize the Windows compiler.' }
foreach ($entry in $environment) {
    if ($entry -match '^([^=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process') }
}
New-Item -ItemType Directory -Force -Path $output | Out-Null
Push-Location $output
try {
    & cl.exe /nologo /O1 /MT /W3 /utf-8 $source ('/Fe:' + $exe) /link gdi32.lib
    if ($LASTEXITCODE) { throw 'Failed to build the Windows GPU counter reader.' }
} finally { Pop-Location }
