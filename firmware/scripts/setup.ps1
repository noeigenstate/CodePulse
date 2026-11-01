param([string]$Python = 'python', [switch]$Direct)
$ErrorActionPreference = 'Stop'
$workspaceRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$toolchainRoot = Join-Path $workspaceRoot '.toolchains'
$idfRoot = if ($env:CODEPULSE_IDF_PATH) { $env:CODEPULSE_IDF_PATH } else { Join-Path $toolchainRoot 'esp-idf-v6.0.1' }
if ($Direct) {
    $env:HTTP_PROXY = ''; $env:HTTPS_PROXY = ''; $env:ALL_PROXY = ''
    $env:GIT_CONFIG_COUNT = '1'
    $env:GIT_CONFIG_KEY_0 = 'http.proxy'
    $env:GIT_CONFIG_VALUE_0 = ''
}
& $Python -c 'import sys; assert sys.version_info >= (3, 10), "Python 3.10+ is required"'
if ($LASTEXITCODE -ne 0) { throw 'Choose a supported Python with -Python <python.exe>.' }
New-Item -ItemType Directory -Path $toolchainRoot -Force | Out-Null
if (-not (Test-Path -LiteralPath (Join-Path $idfRoot 'tools\idf_tools.py'))) {
    & git clone --depth 1 --branch v6.0.1 --recursive --shallow-submodules https://github.com/espressif/esp-idf.git $idfRoot
    if ($LASTEXITCODE -ne 0) { throw 'ESP-IDF clone failed. Check connectivity; use -Direct only to bypass an unavailable proxy.' }
} else {
    & git -C $idfRoot submodule update --init --recursive --depth 1
    if ($LASTEXITCODE -ne 0) { throw 'ESP-IDF submodule setup failed.' }
}
$env:IDF_PATH = $idfRoot
$env:IDF_TOOLS_PATH = if ($env:CODEPULSE_IDF_TOOLS_PATH) { $env:CODEPULSE_IDF_TOOLS_PATH } else { Join-Path $toolchainRoot 'idf-tools' }
Remove-Item Env:IDF_PYTHON_ENV_PATH -ErrorAction SilentlyContinue
& $Python (Join-Path $idfRoot 'tools\idf_tools.py') --idf-path $idfRoot install --targets=esp32s3
if ($LASTEXITCODE -ne 0) { throw 'ESP-IDF tool installation failed.' }
& $Python (Join-Path $idfRoot 'tools\idf_tools.py') --idf-path $idfRoot install-python-env --features=core
if ($LASTEXITCODE -ne 0) { throw 'ESP-IDF Python environment installation failed.' }
Write-Host 'Ready. Run scripts\build.ps1. Tools are isolated under the workspace .toolchains directory.'
