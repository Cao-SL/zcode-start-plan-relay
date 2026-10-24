# Start the relay in the background and print its health. Windows only.
#
#   powershell -ExecutionPolicy Bypass -File scripts\start-windows.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\start-windows.ps1 -Port 8792 -Bind 0.0.0.0 -Key <secret>
#
# ASCII only on purpose: Windows PowerShell 5.1 reads a .ps1 in the machine's
# ANSI code page, so non-ASCII text here breaks parsing.
param(
  [int]$Port = 8791,
  [string]$Bind = '127.0.0.1',
  [string]$Key = ''
)

$ErrorActionPreference = 'SilentlyContinue'
$relay = Join-Path $PSScriptRoot '..\zcode-plan-relay.js'
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Write-Output 'Node.js not found on PATH'; exit 1 }
if (-not (Test-Path -LiteralPath $relay)) { Write-Output "relay not found: $relay"; exit 1 }

if (-not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) {
  $env:PORT = $Port
  $env:HOST = $Bind
  if ($Key) { $env:ZCODE_PLAN_KEY = $Key } else { Remove-Item Env:ZCODE_PLAN_KEY -ErrorAction SilentlyContinue }
  Start-Process -FilePath $node -ArgumentList @($relay) -WindowStyle Hidden | Out-Null
  Remove-Item Env:PORT -ErrorAction SilentlyContinue
  Remove-Item Env:HOST -ErrorAction SilentlyContinue
  Remove-Item Env:ZCODE_PLAN_KEY -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 1500
}

try {
  $h = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 15
  Write-Output ($h | ConvertTo-Json -Compress)
} catch {
  Write-Output "relay did not come up on port $Port - check %TEMP%\zcode-plan-relay.log"
  exit 1
}
