$ErrorActionPreference='Stop'
& (Join-Path $PSScriptRoot 'prepare.ps1')
$adminNodeCommand=Get-Command node -ErrorAction SilentlyContinue
$adminNode=if($adminNodeCommand){$adminNodeCommand.Source}else{Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'}
try{$adminHealth=Invoke-RestMethod -Uri 'http://127.0.0.1:4174/_admin/health' -TimeoutSec 2}catch{$adminHealth=$null}
$adminCandidates=(& $adminNode (Join-Path (Split-Path -Parent $PSScriptRoot) 'campus-access\server.mjs') --addresses)|ConvertFrom-Json
$adminDesiredHost=if($env:CAMPUS_HOST){$env:CAMPUS_HOST}elseif($adminCandidates.Count -eq 1){$adminCandidates[0].address}else{''}
if($adminHealth.mode -eq 'admin-login'-and (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'runtime.json'))){
 $adminSaved=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'runtime.json') -Raw|ConvertFrom-Json
 $adminCertificateInfo=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'certificate-info.json') -Raw|ConvertFrom-Json
 if($adminSaved.host -ne $adminDesiredHost-or $adminSaved.leafFingerprint -ne $adminCertificateInfo.leafFingerprint){
  & (Join-Path $PSScriptRoot 'stop.ps1');$adminHealth=$null
 }
}
if($adminHealth.mode -ne 'admin-login'){
 $adminProcess=Start-Process -FilePath $adminNode -ArgumentList ('"'+(Join-Path $PSScriptRoot 'server.mjs')+'"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $PSScriptRoot 'server.log') -RedirectStandardError (Join-Path $PSScriptRoot 'server-error.log')
 for($adminAttempt=0;$adminAttempt -lt 16;$adminAttempt++){try{$adminHealth=Invoke-RestMethod -Uri 'http://127.0.0.1:4174/_admin/health' -TimeoutSec 2}catch{$adminHealth=$null};if($adminHealth.mode -eq 'admin-login'){break};Start-Sleep -Milliseconds 250}
 if($adminHealth.mode -ne 'admin-login'){throw '管理员登录服务未就绪，请查看 admin-access/server-error.log。'}
}
Write-Host '本机管理员：http://127.0.0.1:4174/login'
if(Test-Path -LiteralPath (Join-Path $PSScriptRoot 'runtime.json')){$adminRuntime=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'runtime.json') -Raw|ConvertFrom-Json;Write-Host ('校园网管理员：https://'+$adminRuntime.host+':'+$adminRuntime.port+'/login')}
