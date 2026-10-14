$ErrorActionPreference = 'Stop'
$trafficProjectDir = $PSScriptRoot
& (Join-Path $trafficProjectDir 'admin-access\prepare.ps1')
$trafficNodeCommand = Get-Command node -ErrorAction SilentlyContinue
$trafficNodeExecutable = if ($trafficNodeCommand) { $trafficNodeCommand.Source } else { Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' }
if (-not (Test-Path -LiteralPath $trafficNodeExecutable)) { throw '需要 Node.js 20+。' }
function Read-LocalState($Address) {
    try { Invoke-RestMethod -Uri $Address -TimeoutSec 2 } catch { $null }
}
$sandboxPacket = Read-LocalState 'http://127.0.0.1:4173/api/simulation'
if (-not $sandboxPacket.simulation) {
    $sandboxDirectory = Join-Path $trafficProjectDir 'traffic-sandbox'
    Start-Process -FilePath $trafficNodeExecutable -ArgumentList ('"' + (Join-Path $sandboxDirectory 'server.mjs') + '"') -WorkingDirectory $sandboxDirectory -WindowStyle Hidden -RedirectStandardOutput (Join-Path $sandboxDirectory 'shared-server.log') -RedirectStandardError (Join-Path $sandboxDirectory 'shared-server-error.log') | Out-Null
}
$cStatus = Read-LocalState 'http://127.0.0.1:4183/api/status'
if (-not $cStatus.mode) {
    $cDirectory = Join-Path $trafficProjectDir 'dify-integration-lab'
    Start-Process -FilePath $trafficNodeExecutable -ArgumentList ('"' + (Join-Path $cDirectory 'server.mjs') + '"') -WorkingDirectory $cDirectory -WindowStyle Hidden -RedirectStandardOutput (Join-Path $cDirectory 'live-server.log') -RedirectStandardError (Join-Path $cDirectory 'live-server-error.log') | Out-Null
}
for ($attempt = 0; $attempt -lt 10; $attempt++) {
    $sandboxPacket = Read-LocalState 'http://127.0.0.1:4173/api/simulation'
    $cLiveState = Read-LocalState 'http://127.0.0.1:4183/api/student/state'
    if ($sandboxPacket.simulation -and $cLiveState.source -eq 'traffic-sandbox-live') { break }
    Start-Sleep -Milliseconds 500
}
if (-not $sandboxPacket.simulation -or $cLiveState.source -ne 'traffic-sandbox-live') { throw '项目服务未就绪。请检查 4173/4183 端口是否被旧版服务占用，以及目录内的服务日志。' }
& (Join-Path $trafficProjectDir 'admin-access\start.ps1')
Write-Host '沙盘：http://127.0.0.1:4173/'
Write-Host '师生端：http://127.0.0.1:4183/student/'
Write-Host '两端已连接同一份合成仿真状态。请在浏览器中打开以上网址。'
