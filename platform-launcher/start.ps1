param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$platformNodeCommand = Get-Command node -ErrorAction SilentlyContinue
$platformNode = if ($platformNodeCommand) { $platformNodeCommand.Source } else { Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' }
$platformPython = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
if (-not (Test-Path -LiteralPath $platformNode)) { Write-Host '未找到 Node.js 20+，请先安装运行环境。' -ForegroundColor Red; exit 1 }
try {
    $platformArgs = @((Join-Path $PSScriptRoot 'launch.mjs'), '--python', $platformPython)
    if ($NoBrowser) { $platformArgs += '--no-browser' }
    & $platformNode @platformArgs
    exit $LASTEXITCODE
} catch { Write-Host ('启动失败：' + $_.Exception.Message) -ForegroundColor Red; exit 1 }
