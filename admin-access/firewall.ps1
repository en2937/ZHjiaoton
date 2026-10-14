$ErrorActionPreference='Stop'
$adminPrincipal=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if(-not $adminPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw '请右键“允许管理员校园网访问.cmd”，选择“以管理员身份运行”。'}
$adminRuntime=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'runtime.json') -Raw|ConvertFrom-Json
if($adminRuntime.host -notmatch '^10\.(\d{1,3}\.){2}\d{1,3}$'-or $adminRuntime.port -ne 4190){throw '管理员入口记录无效，请先启动项目。'}
$adminRule=Get-NetFirewallRule -Name 'ZjuTrafficAdmin-4190' -ErrorAction SilentlyContinue
if($adminRule){Remove-NetFirewallRule -Name 'ZjuTrafficAdmin-4190'}
New-NetFirewallRule -Name 'ZjuTrafficAdmin-4190' -DisplayName '校园交通管理员 HTTPS（仅校园网 10.x）' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 4190 -LocalAddress $adminRuntime.host -RemoteAddress '10.0.0.0/8' -Profile Any|Out-Null
Write-Host '已允许校园网设备访问管理员 HTTPS 4190 端口。'
