$ErrorActionPreference='Stop'
$taskRoot=Split-Path -Parent $PSScriptRoot
$taskNode=(Get-Command node).Source
function Get-VerifiedService([int]$taskPort,[string]$taskFolder){
 $taskListener=Get-NetTCPConnection -State Listen -LocalPort $taskPort -ErrorAction Stop | Select-Object -First 1
 $taskProcess=Get-CimInstance Win32_Process -Filter ('ProcessId='+$taskListener.OwningProcess)
 if($taskProcess.Name -ne 'node.exe' -or $taskProcess.CommandLine -notmatch [regex]::Escape((Join-Path $taskRoot ($taskFolder+'\server.mjs')))){throw ('端口 '+$taskPort+' 的进程身份不匹配，停止更新。')}
 return $taskProcess.ProcessId
}
$taskAdminPid=Get-VerifiedService 4174 'admin-access'
$taskSandboxPid=Get-VerifiedService 4173 'traffic-sandbox'
$taskOtherPids=@{}
foreach($taskPort in 4183,4180){$taskOtherPids[$taskPort]=(Get-NetTCPConnection -State Listen -LocalPort $taskPort -ErrorAction Stop | Select-Object -First 1).OwningProcess}
$taskCheckpoint=Join-Path $PSScriptRoot 'private\ai-web-deployment.json'
# Stop the administrator entry first, so no new control can race the checkpoint.
Stop-Process -Id $taskAdminPid
& $taskNode (Join-Path $PSScriptRoot 'save-ai-checkpoint.mjs')
if($LASTEXITCODE -ne 0){throw '检查点保存失败，沙盘继续运行；请重新启动管理员入口。'}
Stop-Process -Id $taskSandboxPid
$taskSandbox=Start-Process -FilePath $taskNode -ArgumentList ('"'+(Join-Path $taskRoot 'traffic-sandbox\server.mjs')+'" --restore-state "'+$taskCheckpoint+'"') -WorkingDirectory $taskRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskRoot 'traffic-sandbox\server.log') -RedirectStandardError (Join-Path $taskRoot 'traffic-sandbox\server-error.log')
for($taskAttempt=0;$taskAttempt -lt 20;$taskAttempt++){
 try{$taskPacket=Invoke-RestMethod 'http://127.0.0.1:4173/api/simulation' -TimeoutSec 2;break}catch{Start-Sleep -Milliseconds 250}
}
if(-not $taskPacket){throw '沙盘恢复未完成，请检查 server-error.log。'}
& $taskNode (Join-Path $PSScriptRoot 'save-ai-checkpoint.mjs') --verify
if($LASTEXITCODE -ne 0){throw '检查点恢复核验失败，请检查状态后再启动管理入口。'}
& (Join-Path $PSScriptRoot 'start.ps1')
for($taskAttempt=0;$taskAttempt -lt 20;$taskAttempt++){
 try{$taskHealth=Invoke-RestMethod 'http://127.0.0.1:4174/_admin/health' -TimeoutSec 2;break}catch{Start-Sleep -Milliseconds 250}
}
if($taskHealth.mode -ne 'admin-login'){throw '管理员入口未就绪，请检查 server-error.log。'}
foreach($taskPort in 4183,4180){if((Get-NetTCPConnection -State Listen -LocalPort $taskPort | Select-Object -First 1).OwningProcess -ne $taskOtherPids[$taskPort]){throw '师生入口进程发生变化，请核对。'}}
[pscustomobject]@{sandboxPid=$taskSandbox.Id;adminPid=(Get-NetTCPConnection -State Listen -LocalPort 4174 | Select-Object -First 1).OwningProcess;studentPid=$taskOtherPids[4183];campusPid=$taskOtherPids[4180];localLogin='http://127.0.0.1:4174/login'} | ConvertTo-Json
