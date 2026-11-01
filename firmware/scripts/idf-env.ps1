# Shared environment for CodePulse Board1 Windows development.
$ErrorActionPreference = 'Stop'
$FirmwareRoot = Split-Path -Parent $PSScriptRoot
$WorkspaceRoot = Split-Path -Parent $FirmwareRoot
$toolchainRoot = Join-Path $WorkspaceRoot '.toolchains'
$env:IDF_PATH = if ($env:CODEPULSE_IDF_PATH) { $env:CODEPULSE_IDF_PATH } elseif ($env:IDF_PATH) { $env:IDF_PATH } else { Join-Path $toolchainRoot 'esp-idf-v6.0.1' }
$env:IDF_TOOLS_PATH = if ($env:CODEPULSE_IDF_TOOLS_PATH) { $env:CODEPULSE_IDF_TOOLS_PATH } elseif ($env:IDF_TOOLS_PATH) { $env:IDF_TOOLS_PATH } else { Join-Path $toolchainRoot 'idf-tools' }
if (-not (Test-Path -LiteralPath (Join-Path $env:IDF_PATH 'tools\idf.py'))) {
    throw 'ESP-IDF v6.0.1 is missing. Run scripts\setup.ps1 or set CODEPULSE_IDF_PATH.'
}
if ($env:CODEPULSE_IDF_PYTHON_ENV_PATH) {
    $env:IDF_PYTHON_ENV_PATH = $env:CODEPULSE_IDF_PYTHON_ENV_PATH
} elseif ($env:IDF_PYTHON_ENV_PATH -and (Test-Path -LiteralPath (Join-Path $env:IDF_PYTHON_ENV_PATH 'Scripts/python.exe'))) {
    # Reuse the caller's activated environment; SDK version is checked below.
} else {
    $pythonEnvs = @(Get-ChildItem -LiteralPath (Join-Path $env:IDF_TOOLS_PATH 'python_env') -Directory -Filter 'idf6.0_py*_env')
    if ($pythonEnvs.Count -ne 1) {
        throw 'Expected one IDF 6.0 Python environment. Run setup.ps1 or set CODEPULSE_IDF_PYTHON_ENV_PATH.'
    }
    $env:IDF_PYTHON_ENV_PATH = $pythonEnvs[0].FullName
}
$IdfPython = Join-Path $env:IDF_PYTHON_ENV_PATH 'Scripts\python.exe'
if (-not (Test-Path -LiteralPath $IdfPython)) { throw 'ESP-IDF Python environment is incomplete. Run scripts\setup.ps1.' }
$activation = & $IdfPython (Join-Path $env:IDF_PATH 'tools\activate.py') --export
if ($LASTEXITCODE -ne 0) { throw 'ESP-IDF environment activation failed.' }
. $activation
$version = & $IdfPython (Join-Path $env:IDF_PATH 'tools\idf.py') --version
if ($LASTEXITCODE -ne 0 -or $version -notmatch '^ESP-IDF v6\.0\.1(?:[-\s]|$)') {
    throw "This prototype requires ESP-IDF v6.0.1; found: $version"
}
Write-Host "CodePulse environment: $version"
