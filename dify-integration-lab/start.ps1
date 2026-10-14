$ErrorActionPreference = 'Stop'
$labNodeCommand = Get-Command node -ErrorAction SilentlyContinue
$labNodePath = if ($labNodeCommand) { $labNodeCommand.Source } else { Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' }
if (-not (Test-Path -LiteralPath $labNodePath)) { throw 'Node.js 20+ is required.' }
Set-Location -LiteralPath $PSScriptRoot
& $labNodePath (Join-Path $PSScriptRoot 'server.mjs')
