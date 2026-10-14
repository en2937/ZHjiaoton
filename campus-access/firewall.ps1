$ErrorActionPreference = 'Stop'
$campusIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$campusPrincipal = [Security.Principal.WindowsPrincipal]::new($campusIdentity)
if (-not $campusPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw '请右键“允许校园网访问.cmd”，选择“以管理员身份运行”。' }
$campusRuntime = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'runtime.json') -Raw | ConvertFrom-Json
if ($campusRuntime.host -notmatch '^10\.(\d{1,3}\.){2}\d{1,3}$' -or $campusRuntime.port -lt 1024 -or $campusRuntime.port -gt 65535) { throw '校园网入口记录无效，请先启动校园网访问。' }
$campusRuleName = 'ZjuTrafficCampusDemo-' + $campusRuntime.port
$campusRule = Get-NetFirewallRule -Name $campusRuleName -ErrorAction SilentlyContinue
if ($campusRule) { Remove-NetFirewallRule -Name $campusRuleName }
New-NetFirewallRule -Name $campusRuleName -DisplayName '校园交通比赛演示（仅校园网 10.x）' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $campusRuntime.port -LocalAddress $campusRuntime.host -RemoteAddress '10.0.0.0/8' -Profile Any | Out-Null
Write-Host ('已放行校园网 10.x 地址访问本机 TCP ' + $campusRuntime.port + '，其它端口未开放。')
