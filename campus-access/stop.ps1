$ErrorActionPreference = 'Stop'
$campusRuntimePath = Join-Path $PSScriptRoot 'runtime.json'
if (Test-Path -LiteralPath $campusRuntimePath) {
    $campusRuntime = Get-Content -LiteralPath $campusRuntimePath -Raw | ConvertFrom-Json
    $campusProcess = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$campusRuntime.pid)
    $campusExpectedScript = Join-Path $PSScriptRoot 'server.mjs'
    if ($campusProcess -and $campusProcess.Name -eq 'node.exe' -and $campusProcess.CommandLine.Contains($campusExpectedScript)) {
        Stop-Process -Id $campusRuntime.pid
    } elseif ($campusProcess) { throw 'PID 已被其它程序使用，未停止任何程序。' }
    Remove-Item -LiteralPath $campusRuntimePath
}
Write-Host '校园网入口已停止。原本的本机沙盘和问答服务继续运行。'
$campusPrincipal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if ($campusPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    if ($campusRuntime) { Remove-NetFirewallRule -Name ('ZjuTrafficCampusDemo-' + $campusRuntime.port) -ErrorAction SilentlyContinue }
} else { Write-Host '如需同时删除演示防火墙规则，请以管理员身份运行本脚本。' }

& (Join-Path (Split-Path -Parent $PSScriptRoot) 'admin-access\stop.ps1')
if($campusPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){Remove-NetFirewallRule -Name 'ZjuTrafficAdmin-4190' -ErrorAction SilentlyContinue}
