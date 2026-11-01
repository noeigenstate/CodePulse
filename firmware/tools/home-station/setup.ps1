param([string]$Python = '')
$ErrorActionPreference = 'Stop'
$kitRoot = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $kitRoot '.venv'
$runtimePython = Join-Path $runtime 'Scripts\python.exe'
if ($Python) { $launcher = $Python; $launcherArgs = @() }
elseif (Get-Command py -ErrorAction SilentlyContinue) { $launcher = 'py'; $launcherArgs = @('-3.11') }
else { $launcher = 'python'; $launcherArgs = @() }
& $launcher @launcherArgs -c 'import sys,struct; assert sys.version_info[:2] == (3,11) and sys.platform == "win32" and struct.calcsize("P")==8, "Use Windows x64 Python 3.11"'
if ($LASTEXITCODE -ne 0) { throw 'Install/select Windows x64 Python 3.11. This kit does not install a firmware SDK.' }
if (-not (Test-Path -LiteralPath $runtimePython)) {
    & $launcher @launcherArgs -m venv $runtime
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the isolated station environment.' }
}
& $runtimePython -c 'import sys,struct; assert sys.version_info[:2] == (3,11) and struct.calcsize("P")==8'
if ($LASTEXITCODE -ne 0) { throw 'Existing .venv is incompatible; use a new station directory.' }
& $runtimePython -m pip install --no-index --find-links (Join-Path $kitRoot 'wheelhouse') --require-hashes -r (Join-Path $kitRoot 'requirements.lock') --disable-pip-version-check
if ($LASTEXITCODE -ne 0) { throw 'Pinned offline installation failed.' }
& $runtimePython -m pip check
if ($LASTEXITCODE -ne 0) { throw 'Dependency check failed.' }
& $runtimePython -m esptool version
if ($LASTEXITCODE -ne 0) { throw 'esptool startup failed.' }
Write-Host 'Station ready. Verify a release and list ports; no device has been opened or flashed.'
