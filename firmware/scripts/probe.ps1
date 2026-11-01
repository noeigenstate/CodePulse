param([string]$Port, [switch]$List)
. (Join-Path $PSScriptRoot 'idf-env.ps1')
$probeArgs = @()
if ($Port) { $probeArgs += @('--port', $Port) }
if ($List) { $probeArgs += '--list' }
& $IdfPython (Join-Path $PSScriptRoot 'probe.py') @probeArgs
exit $LASTEXITCODE
