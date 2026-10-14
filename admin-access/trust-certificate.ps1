$ErrorActionPreference='Stop'
$adminCertificate=Join-Path $PSScriptRoot 'public\campus-admin-ca.cer'
$adminCertificateInfo=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'certificate-info.json') -Raw|ConvertFrom-Json
$adminLoaded=[Security.Cryptography.X509Certificates.X509Certificate2]::new($adminCertificate)
$adminSha=[Security.Cryptography.SHA256]::Create()
$adminFingerprint=([BitConverter]::ToString($adminSha.ComputeHash($adminLoaded.RawData))).Replace('-','')
if($adminFingerprint -ne $adminCertificateInfo.sha256){throw '证书指纹与项目记录不一致，未安装。'}
Write-Host ('证书 SHA-256：'+$adminFingerprint)
$adminAnswer=Read-Host '仅在确认这是自己的校园交通项目证书后，输入 YES 安装到当前用户信任区'
if($adminAnswer -cne 'YES'){Write-Host '未安装证书。';exit}
Import-Certificate -FilePath $adminCertificate -CertStoreLocation 'Cert:\CurrentUser\Root'|Out-Null
Write-Host '当前用户已信任管理员入口证书。其它管理设备需单独安装证书。'
