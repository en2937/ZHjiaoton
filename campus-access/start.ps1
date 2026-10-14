$ErrorActionPreference = 'Stop'
$campusProject = Split-Path -Parent $PSScriptRoot
$campusNodeCommand = Get-Command node -ErrorAction SilentlyContinue
$campusNodePath = if ($campusNodeCommand) { $campusNodeCommand.Source } else { Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' }
if (-not (Test-Path -LiteralPath $campusNodePath)) { throw '需要 Node.js 20+。' }
& (Join-Path $campusProject 'start-project.ps1')
$campusCandidates = (& $campusNodePath (Join-Path $PSScriptRoot 'server.mjs') --addresses) | ConvertFrom-Json
$campusBindAddress = if ($env:CAMPUS_HOST) { $env:CAMPUS_HOST } elseif ($campusCandidates.Count -eq 1) { $campusCandidates[0].address } else { throw '校园网地址不唯一，请设置 CAMPUS_HOST 后重新启动。' }
$campusPort = if ($env:CAMPUS_PORT) { [int]$env:CAMPUS_PORT } else { 4180 }
$env:CAMPUS_HOST = $campusBindAddress
$env:CAMPUS_PORT = [string]$campusPort
$campusHealthUrl = 'http://' + $campusBindAddress + ':' + $campusPort + '/_campus/health'
try { $campusHealth = Invoke-RestMethod -Uri $campusHealthUrl -TimeoutSec 2 } catch { $campusHealth = $null }
if ($campusHealth.mode -ne 'campus-read-only') {
    $campusProcess = Start-Process -FilePath $campusNodePath -ArgumentList ('"' + (Join-Path $PSScriptRoot 'server.mjs') + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $PSScriptRoot 'server.log') -RedirectStandardError (Join-Path $PSScriptRoot 'server-error.log')
    for ($campusAttempt = 0; $campusAttempt -lt 12; $campusAttempt++) {
        try { $campusHealth = Invoke-RestMethod -Uri $campusHealthUrl -TimeoutSec 2 } catch { $campusHealth = $null }
        if ($campusHealth.mode -eq 'campus-read-only') { break }
        Start-Sleep -Milliseconds 300
    }
    if ($campusHealth.mode -ne 'campus-read-only') { throw '校园网入口未就绪，请检查 campus-access/server-error.log。' }
    @{host=$campusBindAddress;port=$campusPort;pid=$campusProcess.Id} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'runtime.json') -Encoding UTF8
}
Write-Host ('校园网沙盘：http://' + $campusBindAddress + ':' + $campusPort + '/')
Write-Host ('校园网师生端：http://' + $campusBindAddress + ':' + $campusPort + '/student/')
Write-Host ('管理员登录：https://' + $campusBindAddress + ':4190/login')
Write-Host '如其他校园网设备无法访问，先用管理员身份运行“允许校园网访问.cmd”，再测试校园网络是否隔离设备。'
