$ErrorActionPreference='Stop'
$adminExpected=Join-Path $PSScriptRoot 'server.mjs'
$adminListeners=@(Get-NetTCPConnection -LocalPort 4174 -State Listen -ErrorAction SilentlyContinue)
foreach($adminListener in $adminListeners){$adminProcessInfo=Get-CimInstance Win32_Process -Filter ('ProcessId='+$adminListener.OwningProcess);if($adminProcessInfo.CommandLine -notlike ('*'+$adminExpected+'*')){throw '端口由其它进程使用，未停止。'};Stop-Process -Id $adminListener.OwningProcess}
Write-Host '管理员入口已停止，沙盘与师生问答继续运行。'
