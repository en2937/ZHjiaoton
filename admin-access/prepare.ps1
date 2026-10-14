$ErrorActionPreference='Stop'
$adminNodeCommand=Get-Command node -ErrorAction SilentlyContinue
$adminNode=if($adminNodeCommand){$adminNodeCommand.Source}else{Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'}
$adminPython=Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
if(-not(Test-Path -LiteralPath $adminNode)-or -not(Test-Path -LiteralPath $adminPython)){throw '管理员入口需要项目的 Node.js 与 Python 运行环境。'}
& $adminNode (Join-Path $PSScriptRoot 'server.mjs') --prepare
if($LASTEXITCODE -ne 0){throw '管理员内部配置准备失败。'}
$adminCandidates=@((& $adminNode (Join-Path (Split-Path -Parent $PSScriptRoot) 'campus-access\server.mjs') --addresses)|ConvertFrom-Json)
$adminHosts=@($adminCandidates|ForEach-Object{$_.address})
& $adminPython (Join-Path $PSScriptRoot 'prepare-cert.py') --directory $PSScriptRoot --hosts @adminHosts
if($LASTEXITCODE -ne 0){throw 'HTTPS 证书准备失败。'}
$adminPrivate=Join-Path $PSScriptRoot 'private'
$adminSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls $adminPrivate /inheritance:r /grant:r ('*'+$adminSid+':(OI)(CI)F') '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if($LASTEXITCODE -ne 0){throw '管理员私有文件权限设置失败。'}
