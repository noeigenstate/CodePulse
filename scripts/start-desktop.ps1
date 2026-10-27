param([switch]$Build, [switch]$DeviceServer)
$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$desktopApp = Join-Path $workspace 'apps\desktop'
$electron = Join-Path $workspace 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path -LiteralPath $electron)) { throw 'Run pnpm install --frozen-lockfile first.' }
if ($Build) {
    & pnpm --dir $workspace build
    if ($LASTEXITCODE -ne 0) { throw 'Unified application build failed.' }
}
foreach ($entry in @('out\main\index.js', 'out\renderer\index.html', 'out\hud\renderer\index.html', 'out\hud\preload\index.js')) {
    if (-not (Test-Path -LiteralPath (Join-Path $desktopApp $entry))) { throw 'Build outputs are missing. Run with -Build.' }
}
$listener = @(Get-NetTCPConnection -State Listen -LocalPort 17888 -ErrorAction SilentlyContinue)
if ($listener.Count) { throw 'A CodePulse instance already owns port 17888. Quit CodePulse from its tray first; leave Codex tasks running.' }
& pnpm --dir $workspace --filter '@codepulse/desktop' rebuild:electron
if ($LASTEXITCODE -ne 0) { throw 'Electron native dependency setup failed.' }
$logsRoot = Join-Path $workspace '.tmpshots'
New-Item -ItemType Directory -Path $logsRoot -Force | Out-Null
$variables = @('CODEPULSE_DISABLE_UPDATE_CHECKS', 'CODEPULSE_DEVICE_SERVER_ENABLED', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL')
$previous = @{}
foreach ($name in $variables) { $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
try {
    $env:CODEPULSE_DISABLE_UPDATE_CHECKS = '1'
    if ($DeviceServer) { $env:CODEPULSE_DEVICE_SERVER_ENABLED = '1' }
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    Remove-Item Env:ELECTRON_RENDERER_URL -ErrorAction SilentlyContinue
    $desktopProcess = Start-Process -FilePath $electron -ArgumentList ('"' + $desktopApp + '"') -WorkingDirectory $workspace -WindowStyle Normal -PassThru -RedirectStandardOutput (Join-Path $logsRoot 'unified-desktop.stdout.log') -RedirectStandardError (Join-Path $logsRoot 'unified-desktop.stderr.log')
    $desktopProcess.Id | Set-Content -LiteralPath (Join-Path $logsRoot 'unified-desktop.pid')
    Write-Host "CodePulse started (PID $($desktopProcess.Id)). Use Control in the client to open the HUD or screen workbench."
} finally {
    foreach ($name in $variables) { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') }
}
