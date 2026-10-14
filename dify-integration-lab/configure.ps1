$ErrorActionPreference = 'Stop'
$targetPath = Join-Path $PSScriptRoot '.env.local'
$apiBase = Read-Host '学校应用页面显示的 API 基础地址（例 https://dify-api.zju.edu.cn/v1）'
if ([string]::IsNullOrWhiteSpace($apiBase)) { $apiBase = 'https://dify-api.zju.edu.cn/v1' }
$parsedUri = [uri]$apiBase
if ($parsedUri.Scheme -ne 'https' -or $parsedUri.UserInfo -or $parsedUri.Query -or $parsedUri.Fragment) { throw '请填写 HTTPS API 基础地址，不含密钥或查询参数。' }
$secureKey = Read-Host '应用 API 密钥（隐藏输入，不要发到聊天里）' -AsSecureString
$keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
try {
  $plainKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer)
  if ([string]::IsNullOrWhiteSpace($plainKey)) { throw '密钥不能为空。' }
  $configValue = @{ apiBase = $apiBase.TrimEnd('/'); apiKey = $plainKey; inputs = @{} }
  $configJson = $configValue | ConvertTo-Json -Depth 5
  [IO.File]::WriteAllText($targetPath, $configJson, [Text.UTF8Encoding]::new($false))
  Write-Host '已写入独立测试后端的本地配置。密钥不会显示在测试页面。'
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer)
  $plainKey = $null
  $configJson = $null
}
